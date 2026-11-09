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

const REFERAT = {
  titel: 'AI-titel', type: 'moede', kort: false, opsummering: 'HEMMELIGT-REFERAT', hovedpunkter: [], beslutninger: [],
  opgaver: [], fejlOgMangler: [], aabneSpoergsmaal: [], renTekst: '',
};

function falskReferat(svar = async (v) => ({ ...REFERAT, titel: v.titel || REFERAT.titel })) {
  const r = { kald: 0, async lav(valg) { r.kald++; r.valg = valg; return svar(valg); } };
  return r;
}

function falskPdf() {
  const p = {
    kald: 0,
    async lavPdf(valg) { p.kald++; p.valg = valg; return Buffer.from('%PDF-falsk'); },
    filnavn: ({ titel, tidspunkt }) => `${new Date(tidspunkt).toISOString().slice(0, 10)} ${titel}.pdf`,
  };
  return p;
}

function falskDocx(svar = () => Buffer.from('PK-falsk')) {
  const d = { kald: 0, lavDocx(valg) { d.kald++; d.valg = valg; return svar(valg); } };
  return d;
}

async function start({
  konfig = KONFIG, tjekAdgang = adgangOk, gemini = falskGemini(), referat = falskReferat(), pdf = falskPdf(), docx = falskDocx(),
} = {}) {
  const logs = [];
  const laest = [];
  // docx: false bruger handlerens egen, rigtige Word-del.
  const handler = lavHandler({
    konfig, tjekAdgang, gemini, referat, pdf, ...(docx ? { docx } : {}), log: (o) => logs.push(JSON.stringify(o)),
  });
  const server = http.createServer((req, res) => {
    const slut = res.end.bind(res);
    // Node tømmer selv en ulæst krop efter svaret, så det måles, idet svaret sendes.
    res.end = (...a) => { laest.push(req.readableDidRead); return slut(...a); };
    handler(req, res);
  });
  servere.push(server);
  await new Promise((ok) => server.listen(0, ok));
  const adresse = `http://localhost:${server.address().port}`;
  return { adresse, gemini, referat, pdf, docx, logs, laest };
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
    assert.equal(s.referat.kald, 0);
    assert.equal(s.pdf.kald, 0);
    assert.deepEqual(s.laest, [false]);
  });
}

test('nøgler utilgængelige giver 503 uden Gemini-kald', async () => {
  const s = await start({ tjekAdgang: async () => ({ ok: false, status: 503, grund: 'noegler-utilgaengelige' }) });
  const svar = await post(s.adresse);
  assert.equal(svar.status, 503);
  assert.deepEqual(await svar.json(), { fejl: 'tjeneste' });
  assert.equal(s.gemini.kald, 0);
});

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
  for (const h of ['x-titel', 'x-varighed', 'x-optaget', 'x-type']) {
    assert.ok(svar.headers.get('access-control-allow-headers').includes(h), h);
  }
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
  await post(s.adresse, { headers: { authorization: 'Bearer HEMMELIGT-BEVIS', 'x-titel': 'HEMMELIG-TITEL' } });
  const alt = s.logs.join('\n');
  assert.ok(!alt.includes('HEMMELIG-TITEL'));
  assert.ok(!alt.includes('HEMMELIGT-REFERAT'));
  assert.ok(!alt.includes('HEMMELIG-TEKST'));
  assert.ok(!alt.includes('HEMMELIGT-BEVIS'));
  assert.ok(alt.includes('referat-kald'));
});

test('gemini-kald logges af Gemini-delen med model, ikke af handleren', async () => {
  // Handleren kender ikke modellen. Gemini-delen logger gemini-kald og evt. model-skift.
  const s = await start();
  await post(s.adresse);
  assert.ok(!s.logs.join('\n').includes('gemini-kald'));
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

test('Googles dagsgrænse giver 503 med fejlkoden kvote', async () => {
  const s = await start({ gemini: falskGemini(async () => { throw new GeminiFejl('kvote', 'x'); }) });
  const svar = await post(s.adresse);
  assert.equal(svar.status, 503);
  assert.deepEqual(await svar.json(), { fejl: 'kvote' });
});

test('medarbejder får tekst, og lyden sendes uændret', async () => {
  const s = await start();
  const krop = Buffer.from([0, 1, 2, 255, 254]);
  const svar = await post(s.adresse, { krop, headers: { 'content-type': 'audio/webm;codecs=opus' } });
  assert.equal(svar.status, 200);
  assert.equal((await svar.json()).tekst, 'Hej');
  assert.deepEqual(s.gemini.modtaget, krop);
  assert.equal(s.gemini.valg.bytes, 5);
  assert.equal(s.gemini.valg.mime, 'audio/webm;codecs=opus');
});

test('tom tekst gives videre og kalder ikke referat', async () => {
  const s = await start({ gemini: falskGemini(async () => ({ tekst: '' })) });
  assert.deepEqual(await (await post(s.adresse)).json(), { tekst: '' });
  assert.equal(s.referat.kald, 0);
  assert.equal(s.pdf.kald, 0);
});

const TID = Date.UTC(2026, 10, 2, 12, 5);
const kodet = (t) => encodeURIComponent(t);

test('svar indeholder titel, referat, pdf og filnavn', async () => {
  const s = await start();
  const svar = await post(s.adresse, { headers: { 'x-titel': kodet('Møde om tag'), 'x-varighed': '252', 'x-optaget': String(TID) } });
  const j = await svar.json();
  assert.equal(svar.status, 200);
  assert.equal(j.tekst, 'Hej');
  assert.equal(j.titel, 'Møde om tag');
  assert.equal(j.referat.opsummering, 'HEMMELIGT-REFERAT');
  assert.equal(Buffer.from(j.pdf, 'base64').toString(), '%PDF-falsk');
  assert.equal(j.filnavn, '2026-11-02 Møde om tag.pdf');
  assert.equal(s.referat.valg.tekst, 'Hej');
  assert.equal(s.referat.valg.varighedSek, 252);
  assert.ok(s.referat.valg.signal instanceof AbortSignal);
  assert.equal(s.pdf.valg.tidspunkt, TID);
  assert.equal(s.pdf.valg.titel, 'Møde om tag');
  assert.equal(s.pdf.valg.varighedSek, 252);
  assert.equal(s.pdf.valg.tekst, 'Hej');
});

test('svar indeholder Word-dokument med samme navn som PDF-filen og samme indhold', async () => {
  const s = await start();
  const svar = await post(s.adresse, { headers: { 'x-titel': kodet('Møde om tag'), 'x-varighed': '252', 'x-optaget': String(TID) } });
  const j = await svar.json();
  assert.equal(Buffer.from(j.docx, 'base64').toString(), 'PK-falsk');
  assert.equal(j.docxFilnavn, '2026-11-02 Møde om tag.docx');
  assert.equal(s.docx.kald, 1);
  assert.deepEqual(s.docx.valg, s.pdf.valg);
});

test('uden en Word-del i opsætningen bruges den rigtige', async () => {
  const s = await start({ docx: false });
  const j = await (await post(s.adresse, { headers: { 'x-titel': kodet('Møde om tag'), 'x-optaget': String(TID) } })).json();
  assert.equal(Buffer.from(j.docx, 'base64').subarray(0, 4).toString('latin1'), 'PK\u0003\u0004');
  assert.equal(j.docxFilnavn, '2026-11-02 Møde om tag.docx');
});

test('fejler Word-dokumentet, sendes referatet uden, og kun koden logges', async () => {
  const s = await start({ docx: falskDocx(() => { throw new RangeError('HEMMELIG-DOCX'); }) });
  const svar = await post(s.adresse, { headers: { 'x-titel': kodet('Møde om tag'), 'x-optaget': String(TID) } });
  const j = await svar.json();
  assert.equal(svar.status, 200);
  assert.equal(Buffer.from(j.pdf, 'base64').toString(), '%PDF-falsk');
  assert.equal(j.filnavn, '2026-11-02 Møde om tag.pdf');
  assert.equal(j.docx, undefined);
  assert.equal(j.docxFilnavn, undefined);
  assert.equal(j.referatMangler, undefined);
  assert.ok(s.logs.includes(JSON.stringify({ haendelse: 'docx-fejl' })));
  assert.ok(!s.logs.join('\n').includes('HEMMELIG-DOCX'));
});

test('tom titel giver AI-titel', async () => {
  const s = await start();
  const j = await (await post(s.adresse)).json();
  assert.equal(s.referat.valg.titel, '');
  assert.equal(j.titel, 'AI-titel');
});

test('titel med specialtegn', async () => {
  const s = await start();
  const titel = 'Byggenotat E/F Nørrehus 🏗️ "tag" æøå';
  await post(s.adresse, { headers: { 'x-titel': kodet(titel) } });
  assert.equal(s.referat.valg.titel, titel);
});

test('for lang titel afkortes til 120 tegn', async () => {
  const s = await start();
  await post(s.adresse, { headers: { 'x-titel': kodet('å'.repeat(300)) } });
  assert.equal(s.referat.valg.titel.length, 120);
});

test('ugyldig titel og kontroltegn ignoreres', async () => {
  const s = await start();
  await post(s.adresse, { headers: { 'x-titel': '%E0%A4%A' } });
  assert.equal(s.referat.valg.titel, '');
  await post(s.adresse, { headers: { 'x-titel': kodet('a\nb\tc') } });
  assert.equal(s.referat.valg.titel, 'abc');
});

test('varigheden gives til Gemini, så lang lyd kan gå direkte til Flash', async () => {
  const s = await start();
  await post(s.adresse, { headers: { 'x-varighed': '252' } });
  assert.equal(s.gemini.valg.varighedSek, 252);
  // En uploadet fil kan være længere end en time. Til modelvalget tæller den stadig som lang.
  await post(s.adresse, { headers: { 'x-varighed': '5400' } });
  assert.equal(s.gemini.valg.varighedSek, 5400);
  assert.equal(s.referat.valg.varighedSek, null);
  for (const v of [undefined, '', 'abc', '-5']) {
    await post(s.adresse, { headers: { 'x-varighed': v } });
    assert.equal(s.gemini.valg.varighedSek, null, String(v));
  }
});

const LYDFORMATER = [
  'audio/mp4', 'audio/webm', 'audio/webm;codecs=opus', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/ogg', 'audio/ogg; codecs=opus', 'audio/aac', 'audio/flac', 'audio/x-flac', 'audio/x-m4a', 'audio/m4a',
];
for (const format of LYDFORMATER) {
  test(`uploadet lyd godtages og sendes uændret: ${format}`, async () => {
    const s = await start();
    const krop = Buffer.from([0x49, 0x44, 0x33, 0, 255]);
    const svar = await post(s.adresse, { krop, headers: { 'content-type': format } });
    assert.equal(svar.status, 200);
    assert.deepEqual(s.gemini.modtaget, krop);
    assert.equal(s.gemini.valg.mime, format);
  });
}

for (const format of ['video/mp4', 'audio/x-ms-wma', 'application/octet-stream', 'audio/']) {
  test(`andet end lyd afvises: ${format}`, async () => {
    const s = await start();
    assert.equal((await post(s.adresse, { headers: { 'content-type': format } })).status, 415);
    assert.equal(s.gemini.kald, 0);
  });
}

for (const v of ['abc', '-5', '5000', '']) {
  test(`ugyldig varighed ignoreres: "${v}"`, async () => {
    const s = await start();
    await post(s.adresse, { headers: { 'x-varighed': v } });
    assert.equal(s.referat.valg.varighedSek, null);
  });
}

test('ugyldigt tidspunkt giver nu', async () => {
  const s = await start();
  const foer = Date.now();
  await post(s.adresse, { headers: { 'x-optaget': 'vrøvl' } });
  assert.ok(s.pdf.valg.tidspunkt >= foer && s.pdf.valg.tidspunkt <= Date.now());
});

// Transskriptionen er betalt. Fejler referat eller PDF bagefter, får appen teksten, så kun referatet laves igen.
for (const [navn, fejl] of [
  ['tjeneste', new GeminiFejl('tjeneste', 'x')],
  ['kvote', new GeminiFejl('kvote', 'x')],
  ['nøgle', new GeminiFejl('noegle', 'x')],
  ['uventet', new Error('x')],
]) {
  test(`referat-fejl (${navn}) efter transskription giver teksten med referatMangler og ingen PDF`, async () => {
    const s = await start({ referat: falskReferat(async () => { throw fejl; }) });
    const svar = await post(s.adresse, { headers: { 'x-referat-mangler': '1' } });
    assert.equal(svar.status, 200);
    assert.deepEqual(await svar.json(), { tekst: 'Hej', referatMangler: true });
    assert.equal(s.gemini.kald, 1);
    assert.equal(s.pdf.kald, 0);
    assert.ok(s.logs.some((l) => JSON.parse(l).haendelse === 'gemini-fejl' && JSON.parse(l).trin === 'referat'), s.logs.join());
  });
}

test('PDF-fejl efter transskription giver teksten med referatMangler', async () => {
  const pdf = falskPdf();
  pdf.lavPdf = async () => { throw new Error('pdf'); };
  const s = await start({ pdf });
  const svar = await post(s.adresse, { headers: { 'x-referat-mangler': '1' } });
  assert.equal(svar.status, 200);
  assert.deepEqual(await svar.json(), { tekst: 'Hej', referatMangler: true });
  assert.ok(s.logs.some((l) => JSON.parse(l).trin === 'pdf'), s.logs.join());
});

// En time og et kvarter ad gangen er grænsen hos Gemini. Over 2½ time afvises filen, før lyden læses.
test('x-varighed over 9000 s giver 413 for-lang, før lyden læses', async () => {
  const s = await start();
  const svar = await post(s.adresse, { headers: { 'x-varighed': '9001' } });
  assert.equal(svar.status, 413);
  assert.deepEqual(await svar.json(), { fejl: 'for-lang' });
  assert.equal(s.gemini.kald, 0);
  assert.deepEqual(s.laest, [false]);
  assert.equal((await post(s.adresse, { headers: { 'x-varighed': '9000' } })).status, 200);
});

test('for lang afvises først efter adgangstjekket', async () => {
  const s = await start({ tjekAdgang: async () => ({ ok: false, status: 401, grund: 'x' }) });
  assert.equal((await post(s.adresse, { headers: { 'x-varighed': '20000' } })).status, 401);
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

test('x-type sendes til referatet, ukendt bliver automatisk', async () => {
  const s = await start();
  await post(s.adresse, { headers: { 'x-type': 'byggenotat' } });
  assert.equal(s.referat.valg.type, 'byggenotat');
  await post(s.adresse, { headers: { 'x-type': 'ond' } });
  assert.equal(s.referat.valg.type, 'automatisk');
  await post(s.adresse);
  assert.equal(s.referat.valg.type, 'automatisk');
});

test('svaret har type, emne og html', async () => {
  const s = await start();
  const j = await (await post(s.adresse, { headers: { 'x-titel': kodet('Møde om tag'), 'x-optaget': String(TID) } })).json();
  assert.equal(j.type, 'moede');
  assert.equal(j.emne, 'Møde: Møde om tag – 2. nov. 2026');
  assert.ok(j.html.includes('HEMMELIGT-REFERAT'));
});

// Kun tekst og ét referat af flere dele

function postReferat(adresse, krop, { headers = {} } = {}) {
  const tekst = typeof krop === 'string' ? krop : JSON.stringify(krop);
  return fetch(`${adresse}/referat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer x', ...headers },
    body: tekst,
  });
}

test('x-kun-tekst giver kun teksten og intet referat', async () => {
  const s = await start();
  const j = await (await post(s.adresse, { headers: { 'x-kun-tekst': '1' } })).json();
  assert.deepEqual(j, { tekst: 'Hej' });
  assert.equal(s.referat.kald, 0);
  assert.equal(s.pdf.kald, 0);
});

test('/referat kræver adgang, før kroppen læses', async () => {
  const s = await start({ tjekAdgang: async () => ({ ok: false, status: 401, grund: 'x' }) });
  const svar = await postReferat(s.adresse, { tekster: ['a'] });
  assert.equal(svar.status, 401);
  assert.deepEqual(s.laest, [false]);
  assert.equal(s.referat.kald, 0);
});

test('/referat samler teksterne med markøren og laver ét referat', async () => {
  const s = await start();
  const svar = await postReferat(s.adresse, { tekster: [' Første del. ', 'Anden del.'], titel: 'Møde om tag', type: 'moede', varighedSek: 600, optaget: TID });
  const j = await svar.json();
  assert.equal(svar.status, 200);
  assert.equal(j.tekst, 'Første del.\n\n[Optagelsen blev afbrudt her]\n\nAnden del.');
  assert.equal(s.referat.kald, 1);
  assert.equal(s.referat.valg.tekst, j.tekst);
  assert.equal(s.referat.valg.titel, 'Møde om tag');
  assert.equal(s.referat.valg.type, 'moede');
  assert.equal(s.referat.valg.varighedSek, 600);
  assert.equal(s.pdf.valg.tidspunkt, TID);
  assert.equal(s.pdf.valg.tekst, j.tekst);
  assert.equal(j.emne, 'Møde: Møde om tag – 2. nov. 2026');
  assert.equal(Buffer.from(j.pdf, 'base64').toString(), '%PDF-falsk');
  assert.equal(j.filnavn, '2026-11-02 Møde om tag.pdf');
  assert.equal(Buffer.from(j.docx, 'base64').toString(), 'PK-falsk');
  assert.equal(j.docxFilnavn, '2026-11-02 Møde om tag.docx');
  assert.equal(s.docx.valg.tekst, j.tekst);
});

test('/referat sendes uden Word-dokument, hvis det fejler', async () => {
  const s = await start({ docx: falskDocx(() => { throw new Error('x'); }) });
  const svar = await postReferat(s.adresse, { tekster: ['a', 'b'], titel: 'Tag', optaget: TID });
  const j = await svar.json();
  assert.equal(svar.status, 200);
  assert.ok(j.pdf);
  assert.equal(j.docx, undefined);
  assert.ok(s.logs.includes(JSON.stringify({ haendelse: 'docx-fejl' })));
});

test('/referat springer tomme tekster over, og kun tomme giver tom tekst', async () => {
  const s = await start();
  const j = await (await postReferat(s.adresse, { tekster: ['', '  ', 'Kun denne.'] })).json();
  assert.equal(j.tekst, 'Kun denne.');
  const tom = await (await postReferat(s.adresse, { tekster: ['', ' '] })).json();
  assert.deepEqual(tom, { tekst: '' });
  assert.equal(s.referat.kald, 1);
});

test('/referat afviser forkert format, for stor krop og mere end 20 tekster', async () => {
  const s = await start();
  assert.equal((await postReferat(s.adresse, { tekster: ['a'] }, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await postReferat(s.adresse, 'ikke json')).status, 400);
  assert.equal((await postReferat(s.adresse, { tekster: 'a' })).status, 400);
  assert.equal((await postReferat(s.adresse, { tekster: [] })).status, 400);
  assert.equal((await postReferat(s.adresse, { tekster: [1, 2] })).status, 400);
  assert.equal((await postReferat(s.adresse, { tekster: Array(21).fill('a') })).status, 400);
  assert.equal((await postReferat(s.adresse, { tekster: ['x'.repeat(3 * 1024 * 1024)] })).status, 413);
  assert.equal(s.referat.kald, 0);
});

test('/referat renser titlen og ignorerer ukendt type', async () => {
  const s = await start();
  await postReferat(s.adresse, { tekster: ['a'], titel: `a\nb${'å'.repeat(300)}`, type: 'ond' });
  assert.equal(s.referat.valg.titel.length, 120);
  assert.ok(!s.referat.valg.titel.includes('\n'));
  assert.equal(s.referat.valg.type, 'automatisk');
});

test('CORS tillader x-kun-tekst', async () => {
  const s = await start();
  const svar = await fetch(`${s.adresse}/referat`, { method: 'OPTIONS', headers: { origin: OPRINDELSE, 'access-control-request-method': 'POST' } });
  assert.equal(svar.status, 204);
  assert.ok(svar.headers.get('access-control-allow-headers').includes('x-kun-tekst'));
});

test('logs indeholder ingen tekst fra /referat', async () => {
  const s = await start();
  await postReferat(s.adresse, { tekster: ['HEMMELIG-DELTEKST'], titel: 'HEMMELIG-TITEL' });
  const alt = s.logs.join('\n');
  assert.ok(!alt.includes('HEMMELIG-DELTEKST'));
  assert.ok(!alt.includes('HEMMELIG-TITEL'));
  assert.ok(alt.includes('referat-kald'));
});

test('en ældre app uden x-referat-mangler får den gamle fejl, når referatet fejler', async () => {
  const s = await start({ referat: falskReferat(async () => { throw new GeminiFejl('tjeneste', 'x'); }) });
  const svar = await post(s.adresse);
  assert.equal(svar.status, 502);
  assert.deepEqual(await svar.json(), { fejl: 'tjeneste' });
});

test('x-referat-mangler er tilladt i CORS', async () => {
  const s = await start();
  const svar = await fetch(`${s.adresse}/transskriber`, { method: 'OPTIONS', headers: { origin: OPRINDELSE, 'access-control-request-method': 'POST' } });
  assert.match(svar.headers.get('access-control-allow-headers') || '', /x-referat-mangler/);
});

// Tidspunkter fra Flash: kun til at dele bilaget op

const MED_TIDER = '[00:00] Taget er utæt.\n[04:26] Facaden mangler fuger.';
const medTiderGemini = (tekst = MED_TIDER) => falskGemini(async () => ({ tekst }));

test('svarets tekst og referatets kilde er uden tidsmarkører', async () => {
  const s = await start({ gemini: medTiderGemini() });
  const j = await (await post(s.adresse, { headers: { 'x-varighed': '300' } })).json();
  assert.equal(j.tekst, 'Taget er utæt.\nFacaden mangler fuger.');
  assert.equal(s.referat.valg.tekst, 'Taget er utæt.\nFacaden mangler fuger.');
  assert.equal(s.pdf.valg.tekst, 'Taget er utæt.\nFacaden mangler fuger.');
});

test('x-kun-tekst giver teksten uden tidsmarkører', async () => {
  const s = await start({ gemini: medTiderGemini() });
  const j = await (await post(s.adresse, { headers: { 'x-kun-tekst': '1', 'x-varighed': '300' } })).json();
  assert.deepEqual(j, { tekst: 'Taget er utæt.\nFacaden mangler fuger.' });
});

test('referatet får afsnittene med tider rettet efter varigheden', async () => {
  const s = await start({ gemini: medTiderGemini('[00:00] a b c d\n[04:00] e f g h') });
  await post(s.adresse, { headers: { 'x-varighed': '600' } });
  // Flashs slut anslås til 2 × 240 = 480 s. Optagelsen er 600 s, så 04:00 bliver 05:00.
  assert.deepEqual(s.referat.valg.afsnit, [{ sek: 0, tekst: 'a b c d' }, { sek: 300, tekst: 'e f g h' }]);
});

test('en uploadet fil over en time rettes også efter sin varighed', async () => {
  const s = await start({ gemini: medTiderGemini('[00:00] a b c d\n[30:00] e f g h') });
  await post(s.adresse, { headers: { 'x-varighed': '4000' } });
  assert.equal(s.referat.valg.afsnit[1].sek, 2000);
});

test('PDF og Word får bilaget med emnerne, og appen får referatet uden emner', async () => {
  const referat = falskReferat(async () => ({ ...REFERAT, emner: [{ fra: 0, undertitel: 'Tag' }, { fra: 1, undertitel: 'Facade' }] }));
  const s = await start({ gemini: medTiderGemini(), referat });
  // Uden varighed bruges Flashs tider uændret.
  const j = await (await post(s.adresse)).json();
  const bilag = [{ sek: 0, undertitel: 'Tag', afsnit: ['Taget er utæt.'] }, { sek: 266, undertitel: 'Facade', afsnit: ['Facaden mangler fuger.'] }];
  assert.deepEqual(s.pdf.valg.bilag, bilag);
  assert.deepEqual(s.docx.valg.bilag, bilag);
  assert.ok(!('emner' in s.pdf.valg.referat));
  assert.ok(!('emner' in j.referat));
});

test('kort optagelse uden emner: hvert afsnit med sin tid', async () => {
  const s = await start({ gemini: medTiderGemini() });
  await post(s.adresse);
  assert.deepEqual(s.pdf.valg.bilag, [{ sek: 0, afsnit: ['Taget er utæt.'] }, { sek: 266, afsnit: ['Facaden mangler fuger.'] }]);
});

test('uden tidspunkter (Transcribe) er der intet opdelt bilag', async () => {
  const s = await start();
  await post(s.adresse, { headers: { 'x-varighed': '300' } });
  assert.equal(s.pdf.valg.bilag, null);
  assert.equal(s.pdf.valg.tekst, 'Hej');
});

test('flere dele via /referat har intet opdelt bilag', async () => {
  const s = await start();
  const svar = await postReferat(s.adresse, { tekster: ['Del et.', 'Del to.'] });
  assert.equal(svar.status, 200);
  assert.equal(s.pdf.valg.bilag, null);
  assert.equal(s.referat.valg.afsnit, undefined);
});

// En samtale, hvor Flash kun skrev [00:00]: afsnittet deles, så emnerne kan få tider.

const SAMTALE = Array.from({ length: 120 }, (_, i) => `Replik nummer ${i + 1} handler om pladsen ved vinduet.`).join(' ');

test('ét langt afsnit med kun [00:00] deles til referatet, men appens tekst er uændret', async () => {
  const s = await start({ gemini: medTiderGemini(`[00:00] ${SAMTALE}`) });
  const j = await (await post(s.adresse, { headers: { 'x-varighed': '600' } })).json();
  assert.equal(j.tekst, SAMTALE);
  assert.equal(s.referat.valg.tekst, SAMTALE);
  const afsnit = s.referat.valg.afsnit;
  assert.ok(afsnit.length >= 10, `kun ${afsnit.length} afsnit`);
  assert.equal(afsnit.map((a) => a.tekst).join(' '), SAMTALE);
  assert.ok(afsnit.at(-1).sek > 500);
});

test('loggen viser antal afsnit fra Flash og efter deling, aldrig tekst', async () => {
  const s = await start({ gemini: medTiderGemini(`[00:00] ${SAMTALE}`) });
  await post(s.adresse, { headers: { 'x-varighed': '600' } });
  const linje = s.logs.map((l) => JSON.parse(l)).find((l) => l.haendelse === 'afsnit');
  assert.ok(linje, s.logs.join());
  assert.equal(linje.fraFlash, 1);
  assert.ok(linje.efterDeling >= 10);
  assert.deepEqual(Object.keys(linje).sort(), ['efterDeling', 'fraFlash', 'haendelse']);
  assert.ok(!s.logs.join('\n').includes('Replik'));
});

test('uden tidspunkter logges ingen afsnit', async () => {
  const s = await start();
  await post(s.adresse, { headers: { 'x-varighed': '300' } });
  assert.ok(!s.logs.some((l) => JSON.parse(l).haendelse === 'afsnit'));
});

test('bilaget til PDF og Word får flere emner, når Flash kun skrev [00:00]', async () => {
  const referat = falskReferat(async ({ afsnit }) => ({
    ...REFERAT, emner: [{ fra: 0, undertitel: 'Start' }, { fra: Math.floor(afsnit.length / 2), undertitel: 'Midt' }],
  }));
  const s = await start({ gemini: medTiderGemini(`[00:00] ${SAMTALE}`), referat });
  await post(s.adresse, { headers: { 'x-varighed': '600' } });
  assert.equal(s.pdf.valg.bilag.length, 2);
  assert.ok(s.pdf.valg.bilag[1].sek > 200, `fik ${s.pdf.valg.bilag[1].sek}`);
});

test('dele af en afbrudt optagelse (x-kun-tekst) logger ingen deling', async () => {
  const s = await start({ gemini: medTiderGemini(`[00:00] ${SAMTALE}`) });
  const j = await (await post(s.adresse, { headers: { 'x-kun-tekst': '1', 'x-varighed': '600' } })).json();
  assert.deepEqual(j, { tekst: SAMTALE });
  assert.ok(!s.logs.some((l) => JSON.parse(l).haendelse === 'afsnit'));
});
