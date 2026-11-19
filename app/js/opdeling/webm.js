// WebM (Chrome på Android): EBML-hoved og et Segment med Info, Tracks og klynger (Cluster). Telefonens optager
// skriver Segment og klynger med ukendt størrelse, så klyngerne findes element for element, ikke ved at søge
// efter bytes. En bid er hovedet, Info (uden samlet varighed) og Tracks, og de klynger, der hører til.
// Hver klynges tid trækkes ned, så bidden starter ved 0. Lyden i klyngerne kopieres uændret.

import { lavLaeser } from './laeser.js';

const ID = {
  EBML: 0x1a45dfa3, SEGMENT: 0x18538067, INFO: 0x1549a966, TRACKS: 0x1654ae6b, CLUSTER: 0x1f43b675,
  TIDSSKALA: 0x2ad7b1, VARIGHED: 0x4489, TIDSKODE: 0xe7, SIMPELBLOK: 0xa3, BLOKGRUPPE: 0xa0, BLOK: 0xa1,
};
// Elementer på Segment-niveau. Mødes de inde i en klynge af ukendt størrelse, er klyngen slut.
const SEGMENT_NIVEAU = new Set([0x114d9b74, ID.INFO, ID.TRACKS, 0x1c53bb6b, ID.CLUSTER, 0x1254c367, 0x1043a770, 0x1941a469]);
// Højst så meget må mangle til sidst: en halvt skrevet blok eller et halvt elementhoved.
const SLUT_TOLERANCE = 8 * 1024;
const UKENDT_SEGMENT = new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

/** Et element på pos: { id, data, slut } (slut null ved ukendt størrelse), eller null. */
async function element(hent, pos, filSlut) {
  if (pos >= filSlut) return null;
  const { buf, i } = await hent(pos, 12);
  const idLaengde = Math.clz32(buf[i]) - 23;
  if (idLaengde < 1 || idLaengde > 4) return null;
  let id = 0;
  for (let k = 0; k < idLaengde; k++) id = id * 256 + buf[i + k];
  const s = i + idLaengde;
  const strLaengde = Math.clz32(buf[s]) - 23;
  if (strLaengde < 1 || strLaengde > 8) return null;
  let str = buf[s] & (0xff >> strLaengde);
  let ukendt = str === (0xff >> strLaengde);
  for (let k = 1; k < strLaengde; k++) {
    str = str * 256 + buf[s + k];
    if (buf[s + k] !== 0xff) ukendt = false;
  }
  const data = pos + idLaengde + strLaengde;
  if (data > filSlut) return null;
  return { id, start: pos, data, slut: ukendt ? null : Math.min(data + str, filSlut), helt: ukendt || data + str <= filSlut };
}

async function uint(hent, el) {
  const { buf, i } = await hent(el.data, el.slut - el.data);
  let v = 0;
  for (let k = 0; k < el.slut - el.data; k++) v = v * 256 + buf[i + k];
  return v;
}

/** Klyngens børn: tidskoden og den sidste bloks tid. Slutter ved klyngens slut eller et Segment-element. */
async function laesKlynge(hent, klynge, filSlut) {
  const slut = klynge.slut ?? filSlut;
  let pos = klynge.data;
  let tidskode = null;
  let sidsteBlok = 0;
  while (pos < slut) {
    const el = await element(hent, pos, slut);
    if (!el || SEGMENT_NIVEAU.has(el.id)) break;
    if (el.slut === null || !el.helt) break;
    if (el.id === ID.TIDSKODE) tidskode = { pos: el.data, laengde: el.slut - el.data, vaerdi: await uint(hent, el) };
    let blok = el.id === ID.SIMPELBLOK ? el : null;
    if (el.id === ID.BLOKGRUPPE) {
      const indre = await element(hent, el.data, el.slut);
      if (indre?.id === ID.BLOK) blok = indre;
    }
    if (blok) {
      const { buf, i } = await hent(blok.data, 4);
      const spor = Math.clz32(buf[i]) - 23;
      const rel = (buf[i + spor] << 8) | buf[i + spor + 1];
      sidsteBlok = Math.max(sidsteBlok, rel > 0x7fff ? rel - 0x10000 : rel);
    }
    pos = el.slut;
  }
  return { slut: pos, tidskode, sidsteBlok };
}

export async function lavIndeks(kilde) {
  const hent = lavLaeser(kilde);
  const filSlut = kilde.stoerrelse;
  const ebml = await element(hent, 0, filSlut);
  if (!ebml || ebml.id !== ID.EBML || ebml.slut === null) return null;
  const segment = await element(hent, ebml.slut, filSlut);
  if (!segment || segment.id !== ID.SEGMENT) return null;
  const segSlut = segment.slut ?? filSlut;
  let info = null;
  let spor = null;
  let skala = 1000000;
  const enheder = [];
  let sidsteTid = 0;
  let pos = segment.data;
  // Kun det sidste, halvt skrevne element må mangle (appen blev lukket midt i et stykke).
  const naerSlut = (p) => segSlut - p <= SLUT_TOLERANCE;
  while (pos < segSlut) {
    const el = await element(hent, pos, segSlut);
    // Et ødelagt stykke midt i filen: klyngerne bagefter kan ikke findes sikkert. Så sendes filen hel (null).
    if (!el) {
      if (!naerSlut(pos)) return null;
      break;
    }
    if (el.id === ID.CLUSTER) {
      const k = await laesKlynge(hent, el, segSlut);
      if (!k.tidskode) {
        if (!naerSlut(pos)) return null;
        break;
      }
      const tidMs = Math.round((k.tidskode.vaerdi * skala) / 1e6);
      enheder.push({ tidMs, fra: el.start, til: k.slut, blokFra: k.tidskode.pos + k.tidskode.laengde, tidskode: k.tidskode });
      sidsteTid = Math.round(((k.tidskode.vaerdi + k.sidsteBlok) * skala) / 1e6);
      pos = k.slut;
      continue;
    }
    if (el.slut === null || !el.helt) {
      if (el.slut === null) return null;
      break;
    }
    if (el.id === ID.INFO) {
      info = el;
      for (let p = el.data; p < el.slut;) {
        const b = await element(hent, p, el.slut);
        if (!b || b.slut === null) break;
        if (b.id === ID.TIDSSKALA) skala = await uint(hent, b);
        if (b.id === ID.VARIGHED) info.varighed = b;
        p = b.slut;
      }
    }
    if (el.id === ID.TRACKS) spor = el;
    pos = el.slut;
  }
  if (!info || !spor || !enheder.length) return null;
  return { format: 'webm', varighedMs: sidsteTid, enheder, hoved: { ebml, info, spor, skala } };
}

export async function lavBid(kilde, indeks, { fraEnhed, tilEnhed }) {
  const { ebml, info, spor } = indeks.hoved;
  const infoBytes = await kilde.laes(info.start, info.slut);
  if (info.varighed) {
    // Den samlede varighed gælder hele optagelsen. Den erstattes af et tomt Void-element af samme længde.
    const fra = info.varighed.start - info.start;
    const laengde = info.varighed.slut - info.varighed.start;
    infoBytes.fill(0, fra, fra + laengde);
    infoBytes[fra] = 0xec;
    infoBytes[fra + 1] = 0x80 | (laengde - 2);
  }
  const dele = [await kilde.laes(0, ebml.slut), UKENDT_SEGMENT, infoBytes, await kilde.laes(spor.start, spor.slut)];
  const base = indeks.enheder[fraEnhed].tidskode.vaerdi;
  // Hele bidden hentes i ét udsnit (én læsning i lageret); klyngerne er udsnit af det.
  const fra0 = indeks.enheder[fraEnhed].fra;
  const helt = await kilde.udsnit(fra0, indeks.enheder[tilEnhed - 1].til);
  for (let e = fraEnhed; e < tilEnhed; e++) {
    const u = indeks.enheder[e];
    const hoved = new Uint8Array(await helt.slice(u.fra - fra0, u.blokFra - fra0).arrayBuffer());
    let v = u.tidskode.vaerdi - base;
    for (let k = u.tidskode.laengde - 1; k >= 0; k--, v = Math.floor(v / 256)) hoved[u.tidskode.pos - u.fra + k] = v % 256;
    dele.push(hoved, helt.slice(u.blokFra - fra0, u.til - fra0));
  }
  return new Blob(dele, { type: 'audio/webm' });
}
