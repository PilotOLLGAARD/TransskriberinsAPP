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

// Almindelig MP4: prøvetabellerne læses, og en bid får sine egne tabeller med én prøve pr. chunk.

/** En kasse med type og indhold. */
function byg(type, ...dele) {
  const laengde = 8 + dele.reduce((s, d) => s + d.length, 0);
  const b = new Uint8Array(laengde);
  new DataView(b.buffer).setUint32(0, laengde);
  b.set(new TextEncoder().encode(type), 4);
  let p = 8;
  for (const d of dele) {
    b.set(d, p);
    p += d.length;
  }
  return b;
}

/** En fuld kasse (version 0, ingen flag) med 32-bit tal. */
function tabel(type, tal) {
  const b = new Uint8Array(4 + tal.length * 4);
  const v = new DataView(b.buffer);
  tal.forEach((x, i) => v.setUint32(4 + i * 4, x));
  return byg(type, b);
}

async function almindelig(kilde, top, moov, rod, trak, skala) {
  if (top.some((k) => k.type === 'moof')) return null;
  const stbl = find(moov, trak, ['mdia', 'minf', 'stbl']);
  if (!stbl) return null;
  const k = (type) => find(moov, stbl, [type]);
  const [stts, stsz, stsc] = [k('stts'), k('stsz'), k('stsc')];
  const co = k('stco') || k('co64');
  const stsd = k('stsd');
  if (!stts || !stsz || !stsc || !co || !stsd) return null;
  // Krypteret lyd kan ikke klippes og sendes.
  const indgang = String.fromCharCode(...moov.subarray(stsd.data + 12, stsd.data + 16));
  if (indgang !== 'mp4a' && indgang !== 'samr' && indgang !== 'sawb' && indgang !== 'alac') return null;

  const antal = u32(moov, stsz.data + 8);
  const fast = u32(moov, stsz.data + 4);
  const str = new Uint32Array(antal);
  for (let s = 0; s < antal; s++) str[s] = fast || u32(moov, stsz.data + 12 + 4 * s);
  const varighed = new Uint32Array(antal);
  for (let e = 0, s = 0, n = u32(moov, stts.data + 4); e < n; e++) {
    const gange = u32(moov, stts.data + 8 + 8 * e);
    const delta = u32(moov, stts.data + 12 + 8 * e);
    for (let g = 0; g < gange && s < antal; g++) varighed[s++] = delta;
  }
  const bred = co.type === 'co64';
  const chunks = u32(moov, co.data + 4);
  const raekker = u32(moov, stsc.data + 4);
  const pos = new Float64Array(antal);
  let s = 0;
  for (let r = 0; r < raekker; r++) {
    const foerste = u32(moov, stsc.data + 8 + 12 * r) - 1;
    const pr = u32(moov, stsc.data + 12 + 12 * r);
    const sidste = r + 1 < raekker ? u32(moov, stsc.data + 8 + 12 * (r + 1)) - 1 : chunks;
    for (let c = foerste; c < sidste && s < antal; c++) {
      let p = bred ? u64(moov, co.data + 8 + 8 * c) : u32(moov, co.data + 8 + 4 * c);
      for (let j = 0; j < pr && s < antal; j++, s++) {
        pos[s] = p;
        p += str[s];
      }
    }
  }
  if (s !== antal) return null;

  const enheder = [];
  let tid = 0;
  for (let p = 0; p < antal; p++) {
    const tidMs = Math.round((tid / skala) * 1000);
    if (!enheder.length || tidMs >= enheder.length * 1000) enheder.push({ tidMs, fra: pos[p], til: pos[p] + str[p], foersteProeve: p });
    else enheder[enheder.length - 1].til = Math.max(enheder[enheder.length - 1].til, pos[p] + str[p]);
    tid += varighed[p];
  }
  if (pos.some((p, i) => p + str[i] > kilde.stoerrelse)) return null;
  const ftyp = top[0];
  return {
    format: 'mp4',
    varighedMs: Math.round((tid / skala) * 1000),
    enheder,
    hoved: { moov, rod, trak, stbl, pos, str, varighed, skala, ftyp: [ftyp.start, ftyp.slut] },
  };
}

/** Kopi af en kasse med varigheden sat: felt er positionen for version 0 og 1 i kassens data. */
function medVarighed(moov, kasse, [v0, v1], vaerdi) {
  const b = moov.slice(kasse.start, kasse.slut);
  const v = new DataView(b.buffer);
  const data = kasse.data - kasse.start;
  if (b[data] === 1) v.setBigUint64(data + v1, BigInt(Math.round(vaerdi)));
  else v.setUint32(data + v0, Math.min(0xffffffff, Math.round(vaerdi)));
  return b;
}

async function bidAlmindelig(kilde, indeks, { fraEnhed, tilEnhed }) {
  const { moov, rod, trak, stbl, pos, str, varighed, skala } = indeks.hoved;
  const s0 = indeks.enheder[fraEnhed].foersteProeve;
  const s1 = tilEnhed < indeks.enheder.length ? indeks.enheder[tilEnhed].foersteProeve : str.length;
  let fra = Infinity;
  let til = 0;
  let ticks = 0;
  const stts = [];
  for (let s = s0; s < s1; s++) {
    fra = Math.min(fra, pos[s]);
    til = Math.max(til, pos[s] + str[s]);
    ticks += varighed[s];
    if (stts.length && stts.at(-1)[1] === varighed[s]) stts.at(-1)[0]++;
    else stts.push([1, varighed[s]]);
  }
  const antal = s1 - s0;
  const nyStbl = (offsets) => byg('stbl',
    moov.slice(find(moov, stbl, ['stsd']).start, find(moov, stbl, ['stsd']).slut),
    tabel('stts', [stts.length, ...stts.flat()]),
    tabel('stsc', [1, 1, 1, 1]),
    tabel('stsz', [0, antal, ...str.subarray(s0, s1)]),
    tabel('stco', [antal, ...offsets]));
  const mvhd = find(moov, rod, ['mvhd']);
  const mvhdSkala = moov[mvhd.data] === 1 ? u32(moov, mvhd.data + 20) : u32(moov, mvhd.data + 12);
  const filmVarighed = (ticks / skala) * mvhdSkala;
  const kopi = (kk) => moov.slice(kk.start, kk.slut);
  const nyMoov = (offsets) => byg('moov', ...kasser(moov, rod.data, rod.slut).map((kk) => {
    if (kk.type === 'mvhd') return medVarighed(moov, kk, [16, 24], filmVarighed);
    if (kk.type !== 'trak') return kopi(kk);
    return byg('trak', ...kasser(moov, trak.data, trak.slut).filter((t) => t.type !== 'edts').map((t) => {
      if (t.type === 'tkhd') return medVarighed(moov, t, [20, 28], filmVarighed);
      if (t.type !== 'mdia') return kopi(t);
      return byg('mdia', ...kasser(moov, t.data, t.slut).map((m) => {
        if (m.type === 'mdhd') return medVarighed(moov, m, [16, 28], ticks);
        if (m.type !== 'minf') return kopi(m);
        return byg('minf', ...kasser(moov, m.data, m.slut).map((x) => (x.type === 'stbl' ? nyStbl(offsets) : kopi(x))));
      }));
    }));
  }));
  const ftyp = await kilde.laes(...indeks.hoved.ftyp);
  // Positionerne afhænger af moov's længde, som ikke afhænger af deres værdi (fast 4 bytes hver).
  const laengde = nyMoov(new Array(antal).fill(0)).length;
  const lydStart = ftyp.length + laengde + 8;
  const offsets = Array.from({ length: antal }, (_, k) => lydStart + pos[s0 + k] - fra);
  const mdatHoved = new Uint8Array(8);
  new DataView(mdatHoved.buffer).setUint32(0, 8 + til - fra);
  mdatHoved.set(new TextEncoder().encode('mdat'), 4);
  return new Blob([ftyp, nyMoov(offsets), mdatHoved, await kilde.udsnit(fra, til)], { type: 'audio/mp4' });
}

export async function lavBid(kilde, indeks, bid) {
  if (indeks.format === 'mp4f') return bidFragmenteret(kilde, indeks, bid);
  return bidAlmindelig(kilde, indeks, bid);
}

export { kasser, find, alle, u32, u64, tekst };
