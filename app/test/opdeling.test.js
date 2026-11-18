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
