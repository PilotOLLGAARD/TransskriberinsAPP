import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendLyd, sendReferat } from '../js/transskribering.js';

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

test('en ødelagt titel stopper ikke afsendelsen', async () => {
  let kald;
  const hent = async (url, valg) => { kald = valg; return new Response(JSON.stringify({ tekst: 'Hej' }), { status: 200 }); };
  assert.deepEqual(await sendLyd(LYD, 'audio/mp4', 'b', { titel: 'Tag \uD83C' }, hent), { tekst: 'Hej' });
  assert.ok(decodeURIComponent(kald.headers['x-titel']).startsWith('Tag'));
});

test('x-type sendes, når typen er kendt', async () => {
  let kald;
  const hent = async (url, valg) => { kald = valg; return new Response(JSON.stringify({ tekst: '' }), { status: 200 }); };
  await sendLyd(LYD, 'audio/mp4', 'b', { type: 'byggenotat' }, hent);
  assert.equal(kald.headers['x-type'], 'byggenotat');
  await sendLyd(LYD, 'audio/mp4', 'b', { type: 'ond\nheader' }, hent);
  assert.equal(kald.headers['x-type'], undefined);
  await sendLyd(LYD, 'audio/mp4', 'b', {}, hent);
  assert.equal(kald.headers['x-type'], undefined);
});

test('x-kun-tekst sendes, når kunTekst er sat', async () => {
  let kald;
  const hent = async (url, valg) => { kald = valg; return new Response(JSON.stringify({ tekst: 'Del' }), { status: 200 }); };
  assert.deepEqual(await sendLyd(LYD, 'audio/mp4', 'b', { kunTekst: true }, hent), { tekst: 'Del' });
  assert.equal(kald.headers['x-kun-tekst'], '1');
  await sendLyd(LYD, 'audio/mp4', 'b', {}, hent);
  assert.equal(kald.headers['x-kun-tekst'], undefined);
});

test('sendReferat sender JSON med tekster, titel, type, varighed og tidspunkt', async () => {
  let kald;
  const hent = async (url, valg) => { kald = { url: String(url), valg }; return new Response(JSON.stringify({ tekst: 'A B', titel: 'T' }), { status: 200 }); };
  const svar = await sendReferat({ tekster: ['A', 'B'], titel: 'Møde', type: 'moede', varighedMs: 90500, oprettet: 7 }, 'beviset', hent);
  assert.equal(svar.titel, 'T');
  assert.match(kald.url, /\/referat$/);
  assert.equal(kald.valg.method, 'POST');
  assert.equal(kald.valg.headers.authorization, 'Bearer beviset');
  assert.equal(kald.valg.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(kald.valg.body), { tekster: ['A', 'B'], titel: 'Møde', type: 'moede', varighedSek: 91, optaget: 7 });
  assert.ok(kald.valg.signal instanceof AbortSignal);
});

test('sendReferat giver samme fejltyper som sendLyd', async () => {
  for (const [status, type] of [[401, 'login'], [403, 'adgang'], [400, 'tjeneste'], [502, 'tjeneste']]) {
    await assert.rejects(sendReferat({ tekster: ['a'] }, 'b', async () => new Response('{}', { status })), (e) => e.type === type, String(status));
  }
  await assert.rejects(sendReferat({ tekster: ['a'] }, 'b', async () => { throw new TypeError('x'); }), (e) => e.type === 'net');
});

test('vedSendt gives videre og kaldes, når lyden er sendt', async () => {
  let sendt = 0;
  const hent = async (url, valg) => { valg.vedSendt(); return new Response(JSON.stringify({ tekst: 'Hej' }), { status: 200 }); };
  await sendLyd(LYD, 'audio/mp4', 'b', {}, hent, { vedSendt: () => { sendt++; } });
  assert.equal(sendt, 1);
});

test('afbrydelse udefra giver net', async () => {
  const ctrl = new AbortController();
  const hent = (url, valg) => new Promise((_, afvis) => valg.signal.addEventListener('abort', () => afvis(new DOMException('x', 'AbortError'))));
  const loefte = sendLyd(LYD, 'audio/mp4', 'b', {}, hent, { signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(loefte, (e) => e.type === 'net');
});
