// MP4/m4a. To slags:
//  - Fragmenteret (appens egen optager): ftyp + moov, derefter moof+mdat for hvert stykke. En bid er hovedet
//    uændret og de fragmenter, der hører til, med tfdt trukket ned, så bidden starter ved 0.
//  - Almindelig (Memoer, Samsung): én moov med prøvetabeller og lyden i mdat. En bid får en ny moov med kun
//    sine prøver; lyden er udsnit af originalen.
// Kun ét lydspor. Alt andet giver null, og filen sendes hel.

import { lavLaeser } from './laeser.js';

const tekst = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
const u32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u64 = (b, i) => u32(b, i) * 0x100000000 + u32(b, i + 4);
const BEHOLDERE = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'edts', 'dinf']);

/** Kasserne i en buffer: [{ type, start, data, slut }] (positioner i bufferen). */
function kasser(b, fra = 0, til = b.length) {
  const ud = [];
  let p = fra;
  while (p + 8 <= til) {
    let str = u32(b, p);
    let hoved = 8;
    if (str === 1) {
      str = u64(b, p + 8);
      hoved = 16;
    } else if (str === 0) str = til - p;
    if (str < hoved || p + str > til) throw new Error('kasse');
    ud.push({ type: tekst(b, p + 4), start: p, data: p + hoved, slut: p + str });
    p += str;
  }
  return ud;
}

/** Første kasse med stien, fx ['trak', 'mdia', 'mdhd'], eller null. */
function find(b, kasse, sti) {
  let nu = kasse;
  for (const type of sti) {
    nu = kasser(b, nu.data, nu.slut).find((k) => k.type === type);
    if (!nu) return null;
  }
  return nu;
}

const alle = (b, kasse, type) => kasser(b, kasse.data, kasse.slut).filter((k) => k.type === type);

/** Kasserne på øverste niveau, kun deres hoveder: [{ type, start, data, slut }]. */
async function topKasser(kilde) {
  const ud = [];
  let p = 0;
  while (p + 8 <= kilde.stoerrelse) {
    const h = await kilde.laes(p, p + 16);
    let str = u32(h, 0);
    let hoved = 8;
    if (str === 1) {
      str = u64(h, 8);
      hoved = 16;
    } else if (str === 0) str = kilde.stoerrelse - p;
    if (str < hoved) throw new Error('kasse');
    // En optagelse, der blev afbrudt midt i en kasse, har en kort sidste kasse.
    ud.push({ type: tekst(h, 4), start: p, data: p + hoved, slut: Math.min(p + str, kilde.stoerrelse), hel: p + str <= kilde.stoerrelse });
    p += str;
  }
  return ud;
}

function tidsskala(moov, mdhd) {
  const v = moov[mdhd.data];
  return u32(moov, mdhd.data + (v === 1 ? 20 : 12));
}

export async function lavIndeks(kilde) {
  const top = await topKasser(kilde);
  const moovKasse = top.find((k) => k.type === 'moov' && k.hel);
  if (!moovKasse || top[0]?.type !== 'ftyp') return null;
  const moov = await kilde.laes(moovKasse.start, moovKasse.slut);
  // moov's egne børn: bufferen starter med moov's hoved.
  const rod = { data: moovKasse.data - moovKasse.start, slut: moov.length };
  const spor = alle(moov, rod, 'trak');
  if (spor.length !== 1) return null;
  const mdhd = find(moov, spor[0], ['mdia', 'mdhd']);
  if (!mdhd) return null;
  const skala = tidsskala(moov, mdhd);
  if (!skala) return null;
  return find(moov, rod, ['mvex'])
    ? fragmenteret(kilde, top, moov, rod, skala)
    : almindelig(kilde, top, moov, rod, spor[0], skala);
}

// Fragmenteret MP4

async function fragmenteret(kilde, top, moov, rod, skala) {
  const trex = find(moov, rod, ['mvex', 'trex']);
  const standardVarighed = trex ? u32(moov, trex.data + 12) : 0;
  const enheder = [];
  let tid = 0;
  let sidsteVarighed = 0;
  for (let n = 0; n < top.length; n++) {
    const k = top[n];
    if (k.type !== 'moof' || !k.hel) continue;
    const mdat = top[n + 1];
    if (!mdat || mdat.type !== 'mdat' || !mdat.hel) break;
    const moof = await kilde.laes(k.start, k.slut);
    const traf = find(moof, { data: 8, slut: moof.length }, ['traf']);
    const tfhd = traf && find(moof, traf, ['tfhd']);
    if (!tfhd) return null;
    const flag = u32(moof, tfhd.data) & 0xffffff;
    // En absolut dataposition ville pege forkert i bidden.
    if (flag & 0x01) return null;
    let p = tfhd.data + 8 + (flag & 0x02 ? 4 : 0);
    const fragVarighed = flag & 0x08 ? u32(moof, p) : standardVarighed;
    const tfdt = find(moof, traf, ['tfdt']);
    let tfdtV = 0;
    if (tfdt) {
      tfdtV = moof[tfdt.data];
      tid = tfdtV === 1 ? u64(moof, tfdt.data + 4) : u32(moof, tfdt.data + 4);
    }
    let varighed = 0;
    for (const trun of alle(moof, traf, 'trun')) {
      const f = u32(moof, trun.data) & 0xffffff;
      const antal = u32(moof, trun.data + 4);
      p = trun.data + 8 + (f & 0x01 ? 4 : 0) + (f & 0x04 ? 4 : 0);
      const felt = 4 * ((f & 0x100 ? 1 : 0) + (f & 0x200 ? 1 : 0) + (f & 0x400 ? 1 : 0) + (f & 0x800 ? 1 : 0));
      for (let s = 0; s < antal; s++, p += felt) varighed += f & 0x100 ? u32(moof, p) : fragVarighed;
    }
    enheder.push({
      tidMs: Math.round((tid / skala) * 1000), fra: k.start, moofTil: k.slut, til: mdat.slut, tid,
      tfdtPos: tfdt ? tfdt.data + 4 : -1, tfdtV,
    });
    tid += varighed;
    sidsteVarighed = varighed;
    n++;
  }
  if (!enheder.length) return null;
  const sidste = enheder.at(-1);
  return {
    format: 'mp4f',
    varighedMs: Math.round(((sidste.tid + sidsteVarighed) / skala) * 1000),
    enheder,
    hoved: { slut: enheder[0].fra, mehd: mehdPos(moov, rod, top) },
  };
}

/** Hvor i filen mehd's samlede varighed står, eller -1. Den gælder hele filen og sættes til 0 i en bid. */
function mehdPos(moov, rod, top) {
  const mehd = find(moov, rod, ['mvex', 'mehd']);
  return mehd ? top.find((k) => k.type === 'moov').start + mehd.data : -1;
}

async function bidFragmenteret(kilde, indeks, { fraEnhed, tilEnhed }) {
  const { enheder, hoved } = indeks;
  const start = await kilde.laes(0, hoved.slut);
  if (hoved.mehd >= 0) {
    const pos = hoved.mehd;
    start.fill(0, pos + 4, pos + 4 + (start[pos] === 1 ? 8 : 4));
  }
  const base = enheder[fraEnhed].tid;
  const dele = [start];
  for (let e = fraEnhed; e < tilEnhed; e++) {
    const u = enheder[e];
    const moof = await kilde.laes(u.fra, u.moofTil);
    if (u.tfdtPos >= 0) {
      const v = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
      if (u.tfdtV === 1) v.setBigUint64(u.tfdtPos, BigInt(u.tid - base));
      else v.setUint32(u.tfdtPos, u.tid - base);
    }
    dele.push(moof, await kilde.udsnit(u.moofTil, u.til));
  }
  return new Blob(dele, { type: 'audio/mp4' });
}

// Almindelig MP4 (udfyldes med prøvetabeller)

async function almindelig() {
  return null;
}

export async function lavBid(kilde, indeks, bid) {
  if (indeks.format === 'mp4f') return bidFragmenteret(kilde, indeks, bid);
  throw new Error('format');
}

export { kasser, find, alle, u32, u64, tekst };
