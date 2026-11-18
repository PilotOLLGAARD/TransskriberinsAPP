import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lavIndeks, planlaegBidder, lavBid, blobKilde, kanKlippes } from '../js/opdeling/index.js';

const MIN = 60 * 1000;
const lyd = (navn) => new Blob([readFileSync(new URL(`./lyd/${navn}`, import.meta.url))]);
const bytes = async (b) => new Uint8Array(await b.arrayBuffer());
/** Enheder på ét sekund, som de formater, der deles op i sekunder. */
const sekunder = (antal) => Array.from({ length: antal }, (_, i) => ({ tidMs: i * 1000, fra: i * 10, til: i * 10 + 10 }));
const LILLE = { bidMs: 10000, overlapMs: 2000, delFraMs: 12000 };

function indeholder(stor, lille) {
  outer: for (let i = 0; i + lille.length <= stor.length; i++) {
    for (let j = 0; j < lille.length; j++) if (stor[i + j] !== lille[j]) continue outer;
    return i;
  }
  return -1;
}

// Plan for bidder

test('planlaegBidder: 34 min. giver én bid', () => {
  const p = planlaegBidder(34 * MIN, sekunder(34 * 60), { bidMs: 30 * MIN, overlapMs: 30000, delFraMs: 35 * MIN });
  assert.deepEqual(p, [{ nr: 0, startMs: 0, slutMs: 34 * MIN, overlapMs: 0, fraEnhed: 0, tilEnhed: 34 * 60 }]);
});

test('planlaegBidder: 3 timer giver 6 bidder med 30 s overlap', () => {
  const p = planlaegBidder(180 * MIN, sekunder(180 * 60), { bidMs: 30 * MIN, overlapMs: 30000, delFraMs: 35 * MIN });
  assert.equal(p.length, 6);
  assert.deepEqual(p.map((b) => b.startMs / 1000), [0, 1770, 3570, 5370, 7170, 8970]);
  assert.deepEqual(p.map((b) => b.slutMs / 1000), [1800, 3600, 5400, 7200, 9000, 10800]);
  assert.deepEqual(p.map((b) => b.overlapMs), [0, 30000, 30000, 30000, 30000, 30000]);
  assert.equal(p.at(-1).tilEnhed, 180 * 60);
});

test('planlaegBidder: en rest under 5 min. lægges til sidste bid', () => {
  const p = planlaegBidder(62 * MIN, sekunder(62 * 60), { bidMs: 30 * MIN, overlapMs: 30000, delFraMs: 35 * MIN });
  assert.deepEqual(p.map((b) => [b.startMs / 1000, b.slutMs / 1000]), [[0, 1800], [1770, 3720]]);
});

test('planlaegBidder: grænserne falder på enhedernes start, og overlappet er mindst det ønskede', () => {
  const enheder = Array.from({ length: 40 }, (_, i) => ({ tidMs: i * 5000, fra: i, til: i + 1 }));
  const p = planlaegBidder(200000, enheder, { bidMs: 60000, overlapMs: 7000, delFraMs: 70000 });
  for (const b of p) {
    assert.equal(b.startMs % 5000, 0);
    assert.equal(enheder[b.fraEnhed].tidMs, b.startMs);
  }
  assert.ok(p.slice(1).every((b) => b.overlapMs >= 7000), JSON.stringify(p));
  assert.equal(p[1].startMs, 50000, 'rundet ned fra 53 s');
});

test('kanKlippes: m4a, mp4, webm, mp3 og wav, men ikke ogg, flac og aac', () => {
  for (const m of ['audio/mp4', 'audio/x-m4a', 'audio/webm;codecs=opus', 'audio/mpeg', 'audio/wav']) assert.equal(kanKlippes(m), true, m);
  for (const m of ['audio/ogg', 'audio/flac', 'audio/aac', '']) assert.equal(kanKlippes(m), false, m);
});

// WAV

function wav(sek, { rate = 8000, kanaler = 1, ekstraChunk = false } = {}) {
  const data = new Uint8Array(sek * rate * kanaler * 2);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 9)) & 0xff;
  const fmt = new DataView(new ArrayBuffer(24));
  fmt.setUint32(0, 0x666d7420); fmt.setUint32(4, 16, true);
  fmt.setUint16(8, 1, true); fmt.setUint16(10, kanaler, true); fmt.setUint32(12, rate, true);
  fmt.setUint32(16, rate * kanaler * 2, true); fmt.setUint16(20, kanaler * 2, true); fmt.setUint16(22, 16, true);
  const liste = ekstraChunk ? [new TextEncoder().encode('LIST'), new Uint8Array([4, 0, 0, 0]), new TextEncoder().encode('INFO')] : [];
  const dataHoved = new DataView(new ArrayBuffer(8));
  dataHoved.setUint32(0, 0x64617461); dataHoved.setUint32(4, data.length, true);
  const krop = [new TextEncoder().encode('WAVE'), new Uint8Array(fmt.buffer), ...liste, new Uint8Array(dataHoved.buffer), data];
  const riff = new DataView(new ArrayBuffer(8));
  riff.setUint32(0, 0x52494646); riff.setUint32(4, krop.reduce((s, d) => s + d.length, 0), true);
  return { blob: new Blob([new Uint8Array(riff.buffer), ...krop]), data };
}

test('wav: indekset har varigheden og enheder på ét sekund', async () => {
  const { blob } = wav(30, { ekstraChunk: true });
  const i = await lavIndeks(blobKilde(blob), 'audio/wav');
  assert.equal(i.format, 'wav');
  assert.equal(i.varighedMs, 30000);
  assert.equal(i.enheder.length, 30);
});

test('wav: en bid har sit eget hoved og præcis originalens prøver', async () => {
  const { blob, data } = wav(30);
  const kilde = blobKilde(blob);
  const i = await lavIndeks(kilde, 'audio/wav');
  const plan = planlaegBidder(i.varighedMs, i.enheder, LILLE);
  assert.equal(plan.length, 3);
  const b = await lavBid(kilde, i, plan[1]);
  const igen = await lavIndeks(blobKilde(b), 'audio/wav');
  assert.equal(igen.varighedMs, plan[1].slutMs - plan[1].startMs);
  const ud = await bytes(b);
  const fra = (plan[1].startMs / 1000) * 16000;
  assert.deepEqual(ud.slice(-16000 * 12), data.slice(fra, fra + 16000 * 12));
});

// MP3

test('mp3: ID3 springes over, og varigheden findes ud fra rammerne', async () => {
  const i = await lavIndeks(blobKilde(lyd('tone.mp3')), 'audio/mpeg');
  assert.equal(i.format, 'mp3');
  assert.ok(Math.abs(i.varighedMs - 30000) < 200, String(i.varighedMs));
});

test('mp3: bidder starter på en ramme, er uden Xing og har originalens bytes', async () => {
  const blob = lyd('tone.mp3');
  const original = await bytes(blob);
  const kilde = blobKilde(blob);
  const i = await lavIndeks(kilde, 'audio/mpeg');
  const plan = planlaegBidder(i.varighedMs, i.enheder, LILLE);
  assert.equal(plan.length, 3);
  let sum = 0;
  for (const p of plan) {
    const b = await bytes(await lavBid(kilde, i, p));
    assert.equal(b[0], 0xff, 'starter med en rammes synkronisering');
    assert.equal(indeholder(b, new TextEncoder().encode('Xing')), -1);
    assert.equal(indeholder(b, new TextEncoder().encode('Info')), -1);
    assert.ok(indeholder(original, b) > 0, 'bidden er et sammenhængende udsnit af originalen');
    const igen = await lavIndeks(blobKilde(new Blob([b])), 'audio/mpeg');
    assert.ok(Math.abs(igen.varighedMs - (p.slutMs - p.startMs)) <= 1000, `${igen.varighedMs} mod ${p.slutMs - p.startMs}`);
    sum += igen.varighedMs - p.overlapMs;
  }
  assert.ok(Math.abs(sum - i.varighedMs) <= 1000, 'bidderne dækker hele filen');
});

test('ødelagt eller ukendt lyd giver null', async () => {
  assert.equal(await lavIndeks(blobKilde(new Blob([new Uint8Array(500).fill(7)])), 'audio/mpeg'), null);
  assert.equal(await lavIndeks(blobKilde(new Blob(['RIFF....WAVEjunk'])), 'audio/wav'), null);
  assert.equal(await lavIndeks(blobKilde(lyd('tone.mp3')), 'audio/ogg'), null);
});

// Appens egne optagelser (Chromium: fragmenteret MP4 og WebM med klynger af ukendt størrelse)

const KORT = { bidMs: 4000, overlapMs: 1000, delFraMs: 5000 };

async function tjekBidder(navn, mime, valg, format) {
  const blob = lyd(navn);
  const original = await bytes(blob);
  const kilde = blobKilde(blob);
  const i = await lavIndeks(kilde, mime);
  assert.ok(i, 'kan indekseres');
  assert.equal(i.format, format);
  const plan = planlaegBidder(i.varighedMs, i.enheder, valg);
  assert.ok(plan.length >= 3, `${plan.length} bidder`);
  const bidder = [];
  for (const p of plan) {
    const b = await lavBid(kilde, i, p);
    const igen = await lavIndeks(blobKilde(b), mime);
    assert.ok(igen, `bid ${p.nr} kan læses igen`);
    assert.equal(igen.enheder[0].tidMs, 0, `bid ${p.nr} starter ved 0`);
    assert.ok(Math.abs(igen.varighedMs - (p.slutMs - p.startMs)) <= 1100, `bid ${p.nr}: ${igen.varighedMs} mod ${p.slutMs - p.startMs}`);
    bidder.push({ p, b: await bytes(b), igen });
  }
  return { original, i, bidder };
}

test('mp4f: hver bid har filens hoved, starter ved 0 og har originalens lyddata', async () => {
  const { original, i, bidder } = await tjekBidder('optagelse.mp4', 'audio/mp4;codecs=mp4a.40.2', KORT, 'mp4f');
  assert.ok(Math.abs(i.varighedMs - 12000) < 1500, String(i.varighedMs));
  const hovedLaengde = i.enheder[0].fra;
  for (const { p, b } of bidder) {
    assert.deepEqual(b.slice(0, hovedLaengde), original.slice(0, hovedLaengde), 'ftyp og moov er uændret');
    for (let e = p.fraEnhed; e < p.tilEnhed; e++) {
      const { moofTil, til } = i.enheder[e];
      assert.ok(indeholder(b, original.slice(moofTil, til)) > 0, `mdat i enhed ${e} er uændret`);
    }
  }
});

test('webm: hver bid har hoved, Info og Tracks, starter ved 0 og har hele klynger', async () => {
  const { original, i, bidder } = await tjekBidder('optagelse.webm', 'audio/webm;codecs=opus', { bidMs: 10000, overlapMs: 2000, delFraMs: 12000 }, 'webm');
  assert.ok(Math.abs(i.varighedMs - 30000) < 1500, String(i.varighedMs));
  assert.ok(i.enheder.length >= 3, 'klynger af ukendt størrelse findes på elementniveau');
  for (const { p, b } of bidder) {
    assert.deepEqual([...b.slice(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
    for (let e = p.fraEnhed; e < p.tilEnhed; e++) {
      const { blokFra, til } = i.enheder[e];
      assert.ok(indeholder(b, original.slice(blokFra, til)) > 0, `lyden i klynge ${e} er uændret`);
    }
  }
});

test('mp4 og webm: ødelagte filer giver null', async () => {
  const halv = (await bytes(lyd('optagelse.mp4'))).slice(0, 300);
  assert.equal(await lavIndeks(blobKilde(new Blob([halv])), 'audio/mp4'), null);
  assert.equal(await lavIndeks(blobKilde(new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80])])), 'audio/webm'), null);
});

// Almindelig MP4 (Memoer, Samsung): ny moov med kun bidens prøver

import { kasser, find, u32 } from '../js/opdeling/mp4.js';

const kasse = (type, ...indhold) => {
  const data = indhold.flatMap((d) => [...d]);
  const b = new Uint8Array(8 + data.length);
  new DataView(b.buffer).setUint32(0, b.length);
  b.set(new TextEncoder().encode(type), 4);
  b.set(data, 8);
  return b;
};
const tal32 = (...v) => { const b = new Uint8Array(v.length * 4); const d = new DataView(b.buffer); v.forEach((x, i) => d.setUint32(i * 4, x)); return b; };
const tal64 = (...v) => { const b = new Uint8Array(v.length * 8); const d = new DataView(b.buffer); v.forEach((x, i) => d.setBigUint64(i * 8, BigInt(x))); return b; };

/** Prøvernes placering og størrelse i en fil med moov sidst og én chunk. */
function proever(b) {
  const moov = kasser(b).find((k) => k.type === 'moov');
  const stbl = find(b, moov, ['trak', 'mdia', 'minf', 'stbl']);
  const stsz = find(b, stbl, ['stsz']);
  const antal = u32(b, stsz.data + 8);
  const str = Array.from({ length: antal }, (_, i) => u32(b, stsz.data + 12 + 4 * i));
  let p = u32(b, find(b, stbl, ['stco']).data + 8);
  const pos = str.map((s) => { const x = p; p += s; return x; });
  return { moov, stbl, str, pos };
}

/** Samme fil, men med chunks på skiftevis 7 og 13 prøver (stsc med mange rækker) og evt. co64. */
function omChunk(original, { co64 = false } = {}) {
  const b = original.slice();
  const { moov, stbl, pos } = proever(b);
  const forste = [];
  const raekker = [];
  for (let i = 0, c = 0; i < pos.length; c++) {
    const n = Math.min(c % 2 ? 13 : 7, pos.length - i);
    forste.push(pos[i]);
    if (!raekker.length || raekker.at(-1)[1] !== n) raekker.push([c + 1, n]);
    i += n;
  }
  const boern = kasser(b, stbl.data, stbl.slut).filter((k) => !['stsc', 'stco'].includes(k.type)).map((k) => b.slice(k.start, k.slut));
  const stsc = kasse('stsc', tal32(0, raekker.length), ...raekker.map(([c, n]) => tal32(c, n, 1)));
  const co = co64 ? kasse('co64', tal32(0, forste.length), tal64(...forste)) : kasse('stco', tal32(0, forste.length), tal32(...forste));
  const nyStbl = kasse('stbl', ...boern, stsc, co);
  const delta = nyStbl.length - (stbl.slut - stbl.start);
  // Forfædrenes størrelser vokser med det samme. moov ligger sidst, så ingen positioner flytter sig.
  const ud = new Uint8Array(b.length + delta);
  ud.set(b.subarray(0, stbl.start));
  ud.set(nyStbl, stbl.start);
  ud.set(b.subarray(stbl.slut), stbl.start + nyStbl.length);
  const v = new DataView(ud.buffer);
  for (const sti of [[], ['trak'], ['trak', 'mdia'], ['trak', 'mdia', 'minf']]) {
    const k = sti.length ? find(b, moov, sti) : moov;
    v.setUint32(k.start, v.getUint32(k.start) + delta);
  }
  return ud;
}

async function tjekAlmindelig(original) {
  const kilde = blobKilde(new Blob([original]));
  const i = await lavIndeks(kilde, 'audio/mp4');
  assert.ok(i, 'kan indekseres');
  assert.equal(i.format, 'mp4');
  assert.ok(Math.abs(i.varighedMs - 30000) < 300, String(i.varighedMs));
  const plan = planlaegBidder(i.varighedMs, i.enheder, LILLE);
  assert.equal(plan.length, 3);
  let proeverIalt = 0;
  for (const p of plan) {
    const b = await bytes(await lavBid(kilde, i, p));
    const igen = await lavIndeks(blobKilde(new Blob([b])), 'audio/mp4');
    assert.ok(igen, `bid ${p.nr} kan læses igen`);
    assert.ok(Math.abs(igen.varighedMs - (p.slutMs - p.startMs)) <= 1100, `bid ${p.nr}: ${igen.varighedMs} mod ${p.slutMs - p.startMs}`);
    // Hver prøve i bidden er byte for byte en prøve fra originalen, i samme rækkefølge.
    const ny = proeverAf(b);
    const fra = i.enheder[p.fraEnhed].foersteProeve;
    const gammel = proeverAf(original);
    ny.forEach((x, k) => assert.deepEqual(b.subarray(x.pos, x.pos + x.str), original.subarray(gammel[fra + k].pos, gammel[fra + k].pos + gammel[fra + k].str)));
    proeverIalt += ny.length;
  }
  assert.ok(proeverIalt >= proeverAf(original).length, 'ingen prøver mangler');
  return i;
}

/** Alle prøver i en almindelig MP4 ud fra stsz, stsc og stco/co64: [{ pos, str }]. */
function proeverAf(b) {
  const moov = kasser(b).find((k) => k.type === 'moov');
  const stbl = find(b, moov, ['trak', 'mdia', 'minf', 'stbl']);
  const stsz = find(b, stbl, ['stsz']);
  const fast = u32(b, stsz.data + 4);
  const antal = u32(b, stsz.data + 8);
  const str = Array.from({ length: antal }, (_, k) => fast || u32(b, stsz.data + 12 + 4 * k));
  const co = find(b, stbl, ['stco']) || find(b, stbl, ['co64']);
  const bred = co.type === 'co64';
  const chunks = Array.from({ length: u32(b, co.data + 4) }, (_, k) => (bred ? u32(b, co.data + 8 + 8 * k) * 2 ** 32 + u32(b, co.data + 12 + 8 * k) : u32(b, co.data + 8 + 4 * k)));
  const stsc = find(b, stbl, ['stsc']);
  const raekker = Array.from({ length: u32(b, stsc.data + 4) }, (_, k) => [u32(b, stsc.data + 8 + 12 * k), u32(b, stsc.data + 12 + 12 * k)]);
  const ud = [];
  let s = 0;
  chunks.forEach((c, k) => {
    const n = raekker.filter(([f]) => f <= k + 1).at(-1)[1];
    let p = c;
    for (let j = 0; j < n && s < antal; j++, s++) { ud.push({ pos: p, str: str[s] }); p += str[s]; }
  });
  return ud;
}

test('mp4: moov sidst', async () => { await tjekAlmindelig(await bytes(lyd('tone-moov-sidst.m4a'))); });
test('mp4: faststart', async () => { await tjekAlmindelig(await bytes(lyd('tone-faststart.m4a'))); });
test('mp4: 3gp4 fra Samsung', async () => { await tjekAlmindelig(await bytes(lyd('tone-3gp4.m4a'))); });
test('mp4: stsc med flere rækker', async () => { await tjekAlmindelig(omChunk(await bytes(lyd('tone-moov-sidst.m4a')))); });
test('mp4: co64', async () => { await tjekAlmindelig(omChunk(await bytes(lyd('tone-moov-sidst.m4a')), { co64: true })); });

test('mp4: to spor giver null', async () => {
  const b = await bytes(lyd('tone-moov-sidst.m4a'));
  const moov = kasser(b).find((k) => k.type === 'moov');
  const trak = find(b, moov, ['trak']);
  const nyMoov = kasse('moov', b.subarray(moov.data, moov.slut), b.subarray(trak.start, trak.slut));
  const ud = new Uint8Array([...b.subarray(0, moov.start), ...nyMoov]);
  assert.equal(await lavIndeks(blobKilde(new Blob([ud])), 'audio/mp4'), null);
});
