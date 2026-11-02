import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendLyd } from '../js/transskribering.js';

const LYD = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' });

function svarMed(status, krop = {}) {
  return async () => new Response(JSON.stringify(krop), { status });
}

test('sender lyden uændret med bevis og format', async () => {
  let kald;
  const hent = async (url, valg) => {
    kald = { url, valg };
    return new Response(JSON.stringify({ tekst: 'Hej' }), { status: 200 });
  };
  const svar = await sendLyd(LYD, 'audio/mp4;codecs=mp4a.40.2', 'beviset', {}, hent);
  assert.deepEqual(svar, { tekst: 'Hej' });
  assert.equal(kald.valg.method, 'POST');
  assert.equal(kald.valg.headers.authorization, 'Bearer beviset');
  assert.equal(kald.valg.headers['content-type'], 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(kald.valg.body, LYD);
  assert.match(String(kald.url), /\/transskriber$/);
});

const TILFAELDE = [
  [401, 'login'],
  [403, 'adgang'],
  [411, 'kanIkkeBehandles'],
  [413, 'kanIkkeBehandles'],
  [415, 'kanIkkeBehandles'],
  [422, 'kanIkkeBehandles'],
  [500, 'tjeneste'],
  [502, 'tjeneste'],
  [503, 'tjeneste'],
  [504, 'tjeneste'],
];

for (const [status, type] of TILFAELDE) {
  test(`${status} giver ${type}`, async () => {
    await assert.rejects(sendLyd(LYD, 'audio/mp4', 'b', {}, svarMed(status)), (e) => e.type === type);
  });
}

test('netværksfejl giver net', async () => {
  const hent = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(sendLyd(LYD, 'audio/mp4', 'b', {}, hent), (e) => e.type === 'net');
});

test('200 uden tekst giver tjeneste', async () => {
  await assert.rejects(sendLyd(LYD, 'audio/mp4', 'b', {}, svarMed(200, {})), (e) => e.type === 'tjeneste');
});

test('200 med vrøvl giver tjeneste', async () => {
  const hent = async () => new Response('ikke json', { status: 200 });
  await assert.rejects(sendLyd(LYD, 'audio/mp4', 'b', {}, hent), (e) => e.type === 'tjeneste');
});

test('tom tekst er et gyldigt svar', async () => {
  assert.deepEqual(await sendLyd(LYD, 'audio/mp4', 'b', {}, svarMed(200, { tekst: '' })), { tekst: '' });
});

test('sender titel, varighed og tidspunkt som headere', async () => {
  let kald;
  const hent = async (url, valg) => { kald = valg; return new Response(JSON.stringify({ tekst: 'Hej' }), { status: 200 }); };
  await sendLyd(LYD, 'audio/mp4', 'b', { titel: 'Byggenotat E/F Nørrehus 🏗️', varighedMs: 12400, oprettet: 1793606700000 }, hent);
  assert.equal(decodeURIComponent(kald.headers['x-titel']), 'Byggenotat E/F Nørrehus 🏗️');
  assert.match(kald.headers['x-titel'], /^[\x20-\x7e]+$/);
  assert.equal(kald.headers['x-varighed'], '12');
  assert.equal(kald.headers['x-optaget'], '1793606700000');
});

test('udelader tomme headere', async () => {
  let kald;
  const hent = async (url, valg) => { kald = valg; return new Response(JSON.stringify({ tekst: 'Hej' }), { status: 200 }); };
  await sendLyd(LYD, 'audio/mp4', 'b', { titel: '  ' }, hent);
  for (const h of ['x-titel', 'x-varighed', 'x-optaget']) assert.equal(h in kald.headers, false, h);
});

test('returnerer referat, pdf og filnavn', async () => {
  const krop = { tekst: 'Hej', titel: 'T', referat: { opsummering: 'O' }, pdf: 'JVBERg==', filnavn: 'f.pdf' };
  assert.deepEqual(await sendLyd(LYD, 'audio/mp4', 'b', {}, svarMed(200, krop)), krop);
});
