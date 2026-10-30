'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const { lavHandler } = require('../src/handler.js');
const { GeminiFejl } = require('../src/gemini.js');

const OPRINDELSE = 'https://ollgaard.github.io';
const KONFIG = { tilladtOprindelse: OPRINDELSE, maxBytes: 100 };
const AFVISNINGER = [
  ['uden bevis', 401, 'ugyldigt-bevis'],
  ['udløbet', 401, 'udloebet'],
  ['anden tenant', 403, 'forkert-tenant'],
  ['mangler rolle', 403, 'mangler-rolle'],
  ['gæst', 403, 'ikke-medarbejder'],
];

const servere = [];
after(() => servere.forEach((s) => { s.close(); s.closeAllConnections(); }));

function falskGemini(svar = async () => ({ tekst: 'Hej' })) {
  const g = {
    kald: 0,
    modtaget: null,
    async transskriber(strom, valg) {
      g.kald++;
      g.valg = valg;
      const dele = [];
      for await (const d of strom) dele.push(d);
      g.modtaget = Buffer.concat(dele);
      return svar(valg);
    },
  };
  return g;
}

const adgangOk = async () => ({ ok: true });

async function start({ konfig = KONFIG, tjekAdgang = adgangOk, gemini = falskGemini() } = {}) {
  const logs = [];
  const laest = [];
  const handler = lavHandler({ konfig, tjekAdgang, gemini, log: (o) => logs.push(JSON.stringify(o)) });
  const server = http.createServer((req, res) => {
    const slut = res.end.bind(res);
    // Node tømmer selv en ulæst krop efter svaret, så det måles, idet svaret sendes.
    res.end = (...a) => { laest.push(req.readableDidRead); return slut(...a); };
    handler(req, res);
  });
  servere.push(server);
  await new Promise((ok) => server.listen(0, ok));
  const adresse = `http://localhost:${server.address().port}`;
  return { adresse, gemini, logs, laest };
}

function post(adresse, { headers = {}, krop = Buffer.from('lyd'), sti = '/transskriber' } = {}) {
  return fetch(`${adresse}${sti}`, {
    method: 'POST',
    headers: { 'content-type': 'audio/mp4', authorization: 'Bearer x', ...headers },
    body: krop,
  });
}

for (const [navn, status, grund] of AFVISNINGER) {
  test(`fremmed afvises uden Gemini-kald: ${navn}`, async () => {
    const s = await start({ tjekAdgang: async () => ({ ok: false, status, grund }) });
    const svar = await post(s.adresse);
    assert.equal(svar.status, status);
    assert.deepEqual(await svar.json(), { fejl: status === 401 ? 'login-kraeves' : 'ingen-adgang' });
    assert.equal(s.gemini.kald, 0);
    assert.deepEqual(s.laest, [false]);
  });
}

test('afvisning sker før format og størrelse', async () => {
  const s = await start({ tjekAdgang: async () => ({ ok: false, status: 401, grund: 'x' }) });
  const svar = await post(s.adresse, { headers: { 'content-type': 'text/plain' }, krop: Buffer.alloc(500) });
  assert.equal(svar.status, 401);
});

test('manglende konfiguration afviser alt', async () => {
  const s = await start({ konfig: null, tjekAdgang: adgangOk });
  const svar = await post(s.adresse);
  assert.equal(svar.status, 500);
  assert.deepEqual(await svar.json(), { fejl: 'server-ikke-klar' });
  assert.equal(s.gemini.kald, 0);
});

test('forkert format giver 415 for medarbejder', async () => {
  const s = await start();
  const svar = await post(s.adresse, { headers: { 'content-type': 'text/plain' } });
  assert.equal(svar.status, 415);
  assert.deepEqual(await svar.json(), { fejl: 'kan-ikke-behandles' });
  assert.equal(s.gemini.kald, 0);
});

test('for stor fil giver 413', async () => {
  const s = await start();
  const svar = await post(s.adresse, { krop: Buffer.alloc(101) });
  assert.equal(svar.status, 413);
  assert.equal(s.gemini.kald, 0);
  assert.deepEqual(s.laest, [false]);
});

test('mangler længde giver 411', async () => {
  const s = await start();
  const status = await new Promise((ok, fejl) => {
    const r = http.request(`${s.adresse}/transskriber`, {
      method: 'POST',
      headers: { 'content-type': 'audio/mp4', authorization: 'Bearer x' },
    }, (svar) => { svar.resume(); ok(svar.statusCode); });
    r.on('error', fejl);
    r.write('lyd');
    r.end();
  });
  assert.equal(status, 411);
  assert.equal(s.gemini.kald, 0);
});

test('strøm større end oplyst afbrydes', async () => {
  const gemini = falskGemini();
  const logs = [];
  const handler = lavHandler({ konfig: KONFIG, tjekAdgang: adgangOk, gemini, log: (o) => logs.push(o) });
  const req = Readable.from([Buffer.alloc(50), Buffer.alloc(50)]);
  Object.assign(req, {
    method: 'POST',
    url: '/transskriber',
    headers: { 'content-type': 'audio/mp4', 'content-length': '10', authorization: 'Bearer x' },
  });
  const svar = await new Promise((ok) => {
    const res = {
      once() {},
      on() {},
      writableFinished: false,
      writeHead(status) { this.status = status; },
      end() { ok(this.status); },
    };
    handler(req, res);
  });
  assert.equal(svar, 413);
});

test('preflight svarer uden Gemini', async () => {
  const s = await start({ tjekAdgang: async () => ({ ok: false, status: 401, grund: 'x' }) });
  const svar = await fetch(`${s.adresse}/transskriber`, {
    method: 'OPTIONS',
    headers: { origin: OPRINDELSE, 'access-control-request-method': 'POST' },
  });
  assert.equal(svar.status, 204);
  assert.equal(svar.headers.get('access-control-allow-origin'), OPRINDELSE);
  assert.match(svar.headers.get('access-control-allow-headers'), /authorization/i);
  assert.equal(s.gemini.kald, 0);
});

test('anden oprindelse får ikke CORS-header', async () => {
  const s = await start();
  const svar = await post(s.adresse, { headers: { origin: 'https://ond.example' } });
  assert.equal(svar.headers.get('access-control-allow-origin'), null);
});

test('rigtig oprindelse får CORS-header på svaret', async () => {
  const s = await start();
  const svar = await post(s.adresse, { headers: { origin: OPRINDELSE } });
  assert.equal(svar.headers.get('access-control-allow-origin'), OPRINDELSE);
});

test('klient afbryder stopper Gemini', async () => {
  let afbrudt;
  const stoppet = new Promise((ok) => { afbrudt = ok; });
  const gemini = {
    async transskriber(strom, { signal }) {
      signal.addEventListener('abort', afbrudt);
      await new Promise(() => {});
    },
  };
  const s = await start({ gemini });
  const r = http.request(`${s.adresse}/transskriber`, {
    method: 'POST',
    headers: { 'content-type': 'audio/mp4', 'content-length': '3', authorization: 'Bearer x' },
  });
  r.on('error', () => {});
  r.end('lyd');
  setTimeout(() => r.destroy(), 30);
  await stoppet;
});

test('log indeholder hverken bevis eller tekst', async () => {
  const s = await start({ gemini: falskGemini(async () => ({ tekst: 'HEMMELIG-TEKST' })) });
  await post(s.adresse, { headers: { authorization: 'Bearer HEMMELIGT-BEVIS' } });
  const alt = s.logs.join('\n');
  assert.ok(!alt.includes('HEMMELIG-TEKST'));
  assert.ok(!alt.includes('HEMMELIGT-BEVIS'));
  assert.ok(alt.includes('gemini-kald'));
});

test('afvisning logges med grund', async () => {
  const s = await start({ tjekAdgang: async () => ({ ok: false, status: 403, grund: 'mangler-rolle' }) });
  await post(s.adresse);
  assert.ok(s.logs.join('\n').includes('"haendelse":"adgang-afvist","grund":"mangler-rolle"'));
  assert.ok(!s.logs.join('\n').includes('gemini-kald'));
});

test('tjeneste-fejl giver 502', async () => {
  const s = await start({ gemini: falskGemini(async () => { throw new GeminiFejl('tjeneste', 'x'); }) });
  const svar = await post(s.adresse);
  assert.equal(svar.status, 502);
  assert.deepEqual(await svar.json(), { fejl: 'tjeneste' });
});

test('format-fejl giver 422', async () => {
  const s = await start({ gemini: falskGemini(async () => { throw new GeminiFejl('format', 'x'); }) });
  const svar = await post(s.adresse);
  assert.equal(svar.status, 422);
  assert.deepEqual(await svar.json(), { fejl: 'kan-ikke-behandles' });
});

test('nøgle-fejl giver 500', async () => {
  const s = await start({ gemini: falskGemini(async () => { throw new GeminiFejl('noegle', 'x'); }) });
  const svar = await post(s.adresse);
  assert.equal(svar.status, 500);
  assert.deepEqual(await svar.json(), { fejl: 'server-ikke-klar' });
});

test('medarbejder får tekst, og lyden sendes uændret', async () => {
  const s = await start();
  const krop = Buffer.from([0, 1, 2, 255, 254]);
  const svar = await post(s.adresse, { krop, headers: { 'content-type': 'audio/webm;codecs=opus' } });
  assert.equal(svar.status, 200);
  assert.deepEqual(await svar.json(), { tekst: 'Hej' });
  assert.deepEqual(s.gemini.modtaget, krop);
  assert.equal(s.gemini.valg.bytes, 5);
  assert.equal(s.gemini.valg.mime, 'audio/webm;codecs=opus');
});

test('tom tekst gives videre', async () => {
  const s = await start({ gemini: falskGemini(async () => ({ tekst: '' })) });
  assert.deepEqual(await (await post(s.adresse)).json(), { tekst: '' });
});

test('anden sti giver 404', async () => {
  const s = await start();
  assert.equal((await post(s.adresse, { sti: '/andet' })).status, 404);
  assert.equal(s.gemini.kald, 0);
});

test('GET giver 405', async () => {
  const s = await start();
  assert.equal((await fetch(`${s.adresse}/transskriber`)).status, 405);
  assert.equal(s.gemini.kald, 0);
});
