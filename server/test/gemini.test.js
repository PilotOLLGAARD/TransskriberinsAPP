'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { lavGemini, GeminiFejl, hentUdenGraense, geminiMime } = require('../src/gemini.js');

const NOEGLE = 'hemmelig-testnoegle';
const FIL = { name: 'files/abc', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc' };
const SVAR_OK = { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Hej' }] }] };

function json(status, krop, headers = {}) {
  return new Response(JSON.stringify(krop), { status, headers });
}

// Falsk Google. `interaktion` afgør svaret på transskriptionen.
function falskHent({ interaktion = () => json(200, SVAR_OK), startSvar, uploadSvar, filer = [] } = {}) {
  const kald = [];
  let navn = FIL.name;
  const hent = async (url, valg = {}) => {
    const s = String(url);
    kald.push({ url: s, metode: valg.method, headers: valg.headers || {}, krop: valg.body, duplex: valg.duplex });
    if (s.endsWith('/upload/v1beta/files')) {
      navn = JSON.parse(valg.body).file?.name || FIL.name;
      if (startSvar) return startSvar();
      return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example/u1' } });
    }
    if (s === 'https://upload.example/u1') {
      for await (const _ of valg.body) { /* læs strømmen */ }
      if (uploadSvar) return uploadSvar(valg);
      return json(200, { file: { name: navn, uri: `https://generativelanguage.googleapis.com/v1beta/${navn}` } });
    }
    if (s.includes('/v1beta/files?') && (valg.method || 'GET') === 'GET') return json(200, { files: filer });
    if (s.endsWith('/v1beta/interactions')) return interaktion(valg);
    if (valg.method === 'DELETE') return new Response('{}', { status: 200 });
    throw new Error(`Uventet kald: ${s}`);
  };
  return { hent, kald };
}

function lav(hent, ekstra = {}) {
  return lavGemini({
    noegle: NOEGLE,
    model: 'gemini-3.5-transcribe',
    flashModel: 'gemini-3.8-flash',
    transcribeMaksSek: 400,
    sprog: 'da-DK',
    tilstand: 'smart',
    ordliste: ['ØLLGAARD', 'lægte'],
    timeoutMs: 60000,
    hent,
    // Ingen rigtige pauser i tests. Midten af spredningen giver præcis 2, 4 og 8 s.
    vent: async () => {},
    tilfaeldig: () => 0.5,
    ...ekstra,
  });
}

const lyd = () => Readable.from([Buffer.from('lyd')]);
const valg = (mime = 'audio/mp4', ekstra = {}) => ({ bytes: 3, mime, signal: new AbortController().signal, ...ekstra });
// Over grænsen for Transcribe: går direkte til Flash.
const langLyd = () => valg('audio/mp4', { varighedSek: 401 });

function interaktionsKrop(kald) {
  return JSON.parse(kald.find((k) => k.url.endsWith('/v1beta/interactions')).krop);
}

test('sender store false', async () => {
  const { hent, kald } = falskHent();
  await lav(hent).transskriber(lyd(), valg());
  assert.equal(interaktionsKrop(kald).store, false);
});

test('sender dansk og ordliste', async () => {
  const { hent, kald } = falskHent();
  await lav(hent).transskriber(lyd(), valg());
  const cfg = interaktionsKrop(kald).generation_config.transcription_config;
  assert.deepEqual(cfg.language_codes, ['da-DK']);
  assert.deepEqual(cfg.custom_vocabulary, ['ØLLGAARD', 'lægte']);
  assert.equal(cfg.mode, 'smart');
});

test('verbatim sendes som objekt', async () => {
  const { hent, kald } = falskHent();
  await lav(hent, { tilstand: 'verbatim' }).transskriber(lyd(), valg());
  assert.deepEqual(interaktionsKrop(kald).generation_config.transcription_config.mode, { type: 'verbatim' });
});

test('tom ordliste udelades', async () => {
  const { hent, kald } = falskHent();
  await lav(hent, { ordliste: [] }).transskriber(lyd(), valg());
  assert.equal('custom_vocabulary' in interaktionsKrop(kald).generation_config.transcription_config, false);
});

test('oversætter iPhone-format', async () => {
  const { hent, kald } = falskHent();
  await lav(hent).transskriber(lyd(), valg('audio/mp4;codecs=mp4a.40.2'));
  assert.equal(kald[0].headers['X-Goog-Upload-Header-Content-Type'], 'audio/m4a');
  assert.equal(interaktionsKrop(kald).input[0].mime_type, 'audio/m4a');
});

test('oversætter Android-format', async () => {
  const { hent, kald } = falskHent();
  await lav(hent).transskriber(lyd(), valg('audio/webm;codecs=opus'));
  assert.equal(interaktionsKrop(kald).input[0].mime_type, 'audio/webm');
});

test('upload bruger strøm og oplyst længde', async () => {
  const { hent, kald } = falskHent();
  await lav(hent).transskriber(lyd(), valg());
  assert.equal(kald[0].headers['X-Goog-Upload-Header-Content-Length'], '3');
  assert.equal(kald[1].headers['X-Goog-Upload-Command'], 'upload, finalize');
  assert.equal(kald[1].headers['X-Goog-Upload-Offset'], '0');
  assert.equal(kald[1].duplex, 'half');
  assert.equal(interaktionsKrop(kald).input[0].uri, `https://generativelanguage.googleapis.com/v1beta/${startNavn(kald)}`);
});

test('nøglen sendes som header og aldrig i adressen', async () => {
  const { hent, kald } = falskHent();
  await lav(hent).transskriber(lyd(), valg());
  assert.equal(kald[0].headers['x-goog-api-key'], NOEGLE);
  assert.ok(kald.every((k) => !k.url.includes(NOEGLE)));
});

test('læser teksten fra model_output-steps', async () => {
  const { hent } = falskHent({
    interaktion: () => json(200, {
      status: 'completed',
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: 'IKKE MED' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'Første' }, { type: 'text', text: 'Anden' }] },
      ],
    }),
  });
  assert.deepEqual(await lav(hent).transskriber(lyd(), valg()), { tekst: 'Første\nAnden' });
});

test('læser også output_text og outputs', async () => {
  const a = falskHent({ interaktion: () => json(200, { status: 'completed', output_text: ' Hej ' }) });
  assert.equal((await lav(a.hent).transskriber(lyd(), valg())).tekst, 'Hej');
  const b = falskHent({ interaktion: () => json(200, { status: 'completed', outputs: [{ type: 'text', text: 'Hej2' }] }) });
  assert.equal((await lav(b.hent).transskriber(lyd(), valg())).tekst, 'Hej2');
});

const startNavn = (kald) => JSON.parse(kald.find((k) => k.url.endsWith('/upload/v1beta/files')).krop).file.name;

test('sletter fil efter succes', async () => {
  const { hent, kald } = falskHent();
  await lav(hent).transskriber(lyd(), valg());
  const slet = kald.find((k) => k.metode === 'DELETE');
  assert.ok(slet.url.endsWith(`/v1beta/${startNavn(kald)}`));
});

test('sletter fil efter fejl', async () => {
  const { hent, kald } = falskHent({ interaktion: () => json(500, {}) });
  await assert.rejects(lav(hent).transskriber(lyd(), valg()), GeminiFejl);
  assert.ok(kald.some((k) => k.metode === 'DELETE'));
});

test('fejl ved sletning vælter ikke svaret', async () => {
  const { hent } = falskHent();
  const advarsler = [];
  const medFejl = async (url, v = {}) => {
    if (v.method === 'DELETE') throw new Error('nede');
    return hent(url, v);
  };
  const svar = await lav(medFejl, { advar: (b) => advarsler.push(b) }).transskriber(lyd(), valg());
  assert.equal(svar.tekst, 'Hej');
  assert.equal(advarsler.length, 1);
});

test('status incomplete er fejl', async () => {
  const { hent } = falskHent({
    interaktion: () => json(200, {
      status: 'incomplete',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'halv tekst' }] }],
    }),
  });
  await assert.rejects(lav(hent).transskriber(lyd(), valg()), (e) => e instanceof GeminiFejl && e.kode === 'tjeneste');
});

test('tom tekst er ikke fejl', async () => {
  const { hent } = falskHent({ interaktion: () => json(200, { status: 'completed', steps: [] }) });
  assert.deepEqual(await lav(hent).transskriber(lyd(), valg()), { tekst: '' });
});

for (const status of [429, 500, 503]) {
  test(`${status} giver tjeneste`, async () => {
    const { hent } = falskHent({ interaktion: () => json(status, {}) });
    await assert.rejects(lav(hent).transskriber(lyd(), valg()), (e) => e.kode === 'tjeneste');
  });
}

for (const status of [401, 403]) {
  test(`${status} giver noegle`, async () => {
    const { hent } = falskHent({ startSvar: () => json(status, {}) });
    await assert.rejects(lav(hent).transskriber(lyd(), valg()), (e) => e.kode === 'noegle');
  });
}

test('400 giver format', async () => {
  const { hent } = falskHent({ interaktion: () => json(400, {}) });
  await assert.rejects(lav(hent).transskriber(lyd(), valg()), (e) => e.kode === 'format');
});

test('timeout afbryder kaldet', async () => {
  const { hent } = falskHent({
    interaktion: (v) => new Promise((_, afvis) => {
      v.signal.addEventListener('abort', () => afvis(v.signal.reason));
    }),
  });
  await assert.rejects(lav(hent, { timeoutMs: 20 }).transskriber(lyd(), valg()), (e) => e.kode === 'tjeneste');
});

test('klientens afbrydelse afbryder kaldet og sletter filen', async () => {
  const ctrl = new AbortController();
  const { hent, kald } = falskHent({
    interaktion: (v) => new Promise((_, afvis) => {
      v.signal.addEventListener('abort', () => afvis(v.signal.reason));
      setTimeout(() => ctrl.abort(), 5);
    }),
  });
  await assert.rejects(lav(hent).transskriber(lyd(), { bytes: 3, mime: 'audio/mp4', signal: ctrl.signal }), GeminiFejl);
  assert.ok(kald.some((k) => k.metode === 'DELETE'));
});

test('rigtig fetch kan sende strømmen med oplyst længde', async () => {
  const http = require('node:http');
  let modtaget = null;
  let laengde = null;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/start') {
      res.writeHead(200, { 'x-goog-upload-url': `http://localhost:${server.address().port}/data` });
      res.end('{}');
      return;
    }
    laengde = req.headers['content-length'];
    const dele = [];
    for await (const d of req) dele.push(d);
    modtaget = Buffer.concat(dele).toString();
    res.writeHead(200);
    res.end(JSON.stringify({ file: FIL }));
  });
  await new Promise((ok) => server.listen(0, ok));
  try {
    const hent = (url, v) => {
      if (String(url).endsWith('/upload/v1beta/files')) return fetch(`http://localhost:${server.address().port}/start`, v);
      if (String(url).endsWith('/v1beta/interactions')) return Promise.resolve(json(200, SVAR_OK));
      if (v.method === 'DELETE') return Promise.resolve(new Response('{}'));
      return fetch(url, v);
    };
    await lav(hent).transskriber(Readable.from([Buffer.from('ly'), Buffer.from('d')]), valg());
    assert.equal(modtaget, 'lyd');
    assert.equal(laengde, '3');
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('transskriptionen bruger kaldet uden svartidsgrænse', async () => {
  const { hent, kald } = falskHent();
  const langsomme = [];
  const hentLangsom = async (url, v) => {
    langsomme.push(String(url));
    return json(200, SVAR_OK);
  };
  await lav(hent, { hentLangsom }).transskriber(lyd(), valg());
  assert.ok(langsomme[0].endsWith('/v1beta/interactions'));
  assert.ok(!kald.some((k) => k.url.endsWith('/v1beta/interactions')));
});

test('hentUdenGraense læser svaret og sender headers og krop', async () => {
  const http = require('node:http');
  let modtaget;
  const server = http.createServer(async (req, res) => {
    let krop = '';
    for await (const d of req) krop += d;
    modtaget = { krop, noegle: req.headers['x-goog-api-key'], metode: req.method };
    setTimeout(() => { res.writeHead(202); res.end('{"a":1}'); }, 30);
  });
  await new Promise((ok) => server.listen(0, ok));
  try {
    const svar = await hentUdenGraense(`http://localhost:${server.address().port}/x`, {
      method: 'POST',
      headers: { 'x-goog-api-key': 'n' },
      body: '{"b":2}',
      signal: new AbortController().signal,
    });
    assert.equal(svar.ok, true);
    assert.equal(svar.status, 202);
    assert.deepEqual(await svar.json(), { a: 1 });
    assert.deepEqual(modtaget, { krop: '{"b":2}', noegle: 'n', metode: 'POST' });
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('hentUdenGraense kan afbrydes', async () => {
  const http = require('node:http');
  const server = http.createServer(() => {});
  await new Promise((ok) => server.listen(0, ok));
  const ctrl = new AbortController();
  try {
    const kald = hentUdenGraense(`http://localhost:${server.address().port}/x`, {
      method: 'POST',
      headers: {},
      body: '{}',
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 20);
    await assert.rejects(kald);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('nøglen indgår aldrig i en fejlbesked', async () => {
  const hent = async () => { throw new Error(`nede ${NOEGLE}`); };
  await assert.rejects(lav(hent).transskriber(lyd(), valg()), (e) => {
    assert.ok(!e.message.includes(NOEGLE));
    return e instanceof GeminiFejl && e.kode === 'tjeneste';
  });
});

// Filen slettes i alle tilfælde

test('filen får et nyt navn, vi selv vælger, før upload', async () => {
  const a = falskHent();
  const g = lav(a.hent);
  await g.transskriber(lyd(), valg());
  await g.transskriber(lyd(), valg());
  const navne = a.kald.filter((k) => k.url.endsWith('/upload/v1beta/files')).map((k) => JSON.parse(k.krop).file.name);
  for (const n of navne) assert.match(n, /^files\/opt-[0-9a-f]{32}$/);
  assert.notEqual(navne[0], navne[1]);
});

test('filen slettes, selvom svaret på upload aldrig kommer', async () => {
  const { hent, kald } = falskHent({ uploadSvar: () => { throw new TypeError('forbindelsen røg'); } });
  await assert.rejects(lav(hent).transskriber(lyd(), valg()), GeminiFejl);
  const slet = kald.filter((k) => k.metode === 'DELETE');
  assert.equal(slet.length, 1);
  assert.ok(slet[0].url.endsWith(`/v1beta/${startNavn(kald)}`));
});

test('intet slettes, hvis upload aldrig blev startet', async () => {
  const { hent, kald } = falskHent({ startSvar: () => json(500, {}) });
  await assert.rejects(lav(hent).transskriber(lyd(), valg()), GeminiFejl);
  assert.equal(kald.filter((k) => k.metode === 'DELETE').length, 0);
});

test('sletAktive sletter filer, der stadig er i gang, ved nedlukning', async () => {
  const { hent, kald } = falskHent({ interaktion: () => new Promise(() => {}) });
  const g = lav(hent, { timeoutMs: 60000 });
  g.transskriber(lyd(), valg()).catch(() => {});
  for (let i = 0; i < 50 && !kald.some((k) => k.url.endsWith('/v1beta/interactions')); i++) await new Promise((ok) => setTimeout(ok, 1));
  await g.sletAktive();
  const slet = kald.filter((k) => k.metode === 'DELETE');
  assert.equal(slet.length, 1);
  assert.ok(slet[0].url.endsWith(`/v1beta/${startNavn(kald)}`));
});

test('sletAktive uden noget i gang gør intet', async () => {
  const { hent, kald } = falskHent();
  await lav(hent).sletAktive();
  assert.equal(kald.length, 0);
});

const MIN = 60 * 1000;

test('oprydning sletter filer over 20 minutter, højst hvert 10. minut', async () => {
  let tid = Date.UTC(2026, 10, 3, 12);
  const filer = [
    { name: 'files/gammel', createTime: new Date(tid - 25 * MIN).toISOString() },
    { name: 'files/ny', createTime: new Date(tid - 5 * MIN).toISOString() },
  ];
  const { hent, kald } = falskHent({ filer });
  const g = lav(hent, { nu: () => tid, oprydning: { hvertMs: 10 * MIN, aeldreEndMs: 20 * MIN } });
  await g.transskriber(lyd(), valg());
  await g.rydGamle.igang;
  await g.transskriber(lyd(), valg());
  await g.rydGamle.igang;
  const lister = () => kald.filter((k) => k.url.includes('/v1beta/files?')).length;
  assert.equal(lister(), 1);
  assert.ok(kald.some((k) => k.metode === 'DELETE' && k.url.endsWith('/v1beta/files/gammel')));
  assert.ok(!kald.some((k) => k.metode === 'DELETE' && k.url.endsWith('/v1beta/files/ny')));
  tid += 11 * MIN;
  await g.transskriber(lyd(), valg());
  await g.rydGamle.igang;
  assert.equal(lister(), 2);
  for (const k of kald.filter((x) => x.url.includes('/v1beta/files?'))) assert.equal(k.headers['x-goog-api-key'], NOEGLE);
});

test('oprydning er slået fra uden indstilling, og en fejl vælter ikke transskriptionen', async () => {
  const a = falskHent();
  await lav(a.hent).transskriber(lyd(), valg());
  assert.ok(!a.kald.some((k) => k.url.includes('/v1beta/files?')));
  const advarsler = [];
  const b = falskHent();
  const medFejl = async (url, v = {}) => {
    if (String(url).includes('/v1beta/files?')) throw new Error('nede');
    return b.hent(url, v);
  };
  const g = lav(medFejl, { oprydning: { hvertMs: 10 * MIN, aeldreEndMs: 20 * MIN }, advar: (x) => advarsler.push(x) });
  assert.equal((await g.transskriber(lyd(), valg())).tekst, 'Hej');
  await g.rydGamle.igang;
  assert.ok(advarsler.some((x) => x.startsWith('oprydning')));
});

test('en sletning, der fejler, prøves igen af oprydningen på samme server', async () => {
  let tid = Date.UTC(2026, 10, 3, 12);
  const filer = [];
  const a = falskHent({ filer });
  let foersteSletning = true;
  const hent = async (url, v = {}) => {
    if (v.method === 'DELETE' && foersteSletning) {
      foersteSletning = false;
      a.kald.push({ url: String(url), metode: 'DELETE', headers: v.headers || {} });
      return json(500, {});
    }
    return a.hent(url, v);
  };
  const g = lav(hent, { nu: () => tid, oprydning: { hvertMs: 10 * MIN, aeldreEndMs: 20 * MIN } });
  await g.transskriber(lyd(), valg());
  await g.rydGamle.igang;
  const navn = startNavn(a.kald);
  filer.push({ name: navn, createTime: new Date(tid).toISOString() });
  tid += 25 * MIN;
  await g.transskriber(lyd(), valg());
  await g.rydGamle.igang;
  const sletninger = a.kald.filter((k) => k.metode === 'DELETE' && k.url.endsWith(`/v1beta/${navn}`));
  assert.equal(sletninger.length, 2);
});

// Genforsøg ved midlertidige fejl fra Google

/** Svar i rækkefølge. Det sidste gentages. */
function raekke(...svar) {
  let i = 0;
  return () => {
    const s = svar[Math.min(i++, svar.length - 1)];
    return typeof s === 'function' ? s() : json(s, s === 200 ? SVAR_OK : {});
  };
}

function startOk() {
  return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example/u1' } });
}

function maaltVent() {
  const ventet = [];
  return { ventet, vent: async (ms) => { ventet.push(ms); } };
}

const antal = (kald, slut) => kald.filter((k) => k.url.endsWith(slut)).length;

test('transskriptionen genforsøges ved 503, 500 og 502 med 2, 4 og 8 s', async () => {
  const { hent, kald } = falskHent({ interaktion: raekke(503, 500, 502, 200) });
  const v = maaltVent();
  const svar = await lav(hent, { vent: v.vent }).transskriber(lyd(), valg());
  assert.equal(svar.tekst, 'Hej');
  assert.deepEqual(v.ventet, [2000, 4000, 8000]);
  assert.equal(antal(kald, '/v1beta/interactions'), 4);
  // Lyden uploades kun én gang. Det er den samme fil, der transskriberes igen.
  assert.equal(antal(kald, '/upload/v1beta/files'), 1);
});

test('ventetiden spredes tilfældigt omkring 2, 4 og 8 s', async () => {
  const a = falskHent({ interaktion: raekke(503, 503, 200) });
  const lavt = maaltVent();
  await lav(a.hent, { vent: lavt.vent, tilfaeldig: () => 0 }).transskriber(lyd(), valg());
  const b = falskHent({ interaktion: raekke(503, 503, 200) });
  const hoejt = maaltVent();
  await lav(b.hent, { vent: hoejt.vent, tilfaeldig: () => 0.999 }).transskriber(lyd(), valg());
  assert.deepEqual(lavt.ventet, [1000, 2000]);
  assert.ok(hoejt.ventet[0] > 2900 && hoejt.ventet[0] < 3000);
  assert.ok(hoejt.ventet[1] > 5900 && hoejt.ventet[1] < 6000);
});

test('opgiver efter 3 genforsøg og giver tjeneste med status og sted', async () => {
  const { hent, kald } = falskHent({ interaktion: raekke(503) });
  const v = maaltVent();
  await assert.rejects(lav(hent, { vent: v.vent }).transskriber(lyd(), langLyd()), (e) => {
    assert.equal(e.kode, 'tjeneste');
    assert.equal(e.status, 503);
    assert.equal(e.hvor, 'interactions');
    return true;
  });
  assert.equal(antal(kald, '/v1beta/interactions'), 4);
  assert.equal(v.ventet.length, 3);
  assert.ok(kald.some((k) => k.metode === 'DELETE'));
});

test('Retry-After i sekunder respekteres', async () => {
  const { hent } = falskHent({ interaktion: raekke(() => json(503, {}, { 'retry-after': '7' }), 200) });
  const v = maaltVent();
  await lav(hent, { vent: v.vent, timeoutMs: 60000 }).transskriber(lyd(), valg());
  assert.deepEqual(v.ventet, [7000]);
});

test('Retry-After som dato respekteres', async () => {
  const tid = Date.UTC(2026, 10, 3, 12);
  const dato = new Date(tid + 12000).toUTCString();
  const { hent } = falskHent({ interaktion: raekke(() => json(503, {}, { 'retry-after': dato }), 200) });
  const v = maaltVent();
  await lav(hent, { vent: v.vent, timeoutMs: 60000, nu: () => tid }).transskriber(lyd(), valg());
  assert.deepEqual(v.ventet, [12000]);
});

test('en kortere Retry-After end den stigende ventetid giver den stigende ventetid', async () => {
  const { hent } = falskHent({ interaktion: raekke(() => json(503, {}, { 'retry-after': '1' }), 200) });
  const v = maaltVent();
  await lav(hent, { vent: v.vent }).transskriber(lyd(), valg());
  assert.deepEqual(v.ventet, [2000]);
});

for (const status of [400, 401, 403, 404, 409]) {
  test(`${status} genforsøges aldrig`, async () => {
    const a = falskHent({ interaktion: raekke(status, 200) });
    const v = maaltVent();
    await assert.rejects(lav(a.hent, { vent: v.vent }).transskriber(lyd(), valg()), GeminiFejl);
    assert.equal(antal(a.kald, '/v1beta/interactions'), 1);
    const b = falskHent({ startSvar: raekke(() => json(status, {}), startOk) });
    await assert.rejects(lav(b.hent, { vent: v.vent }).transskriber(lyd(), valg()), GeminiFejl);
    assert.equal(antal(b.kald, '/upload/v1beta/files'), 1);
    assert.deepEqual(v.ventet, []);
  });
}

test('genforsøg holder sig inden for den samlede tidsgrænse', async () => {
  let tid = Date.UTC(2026, 10, 3, 12);
  const { hent, kald } = falskHent({ interaktion: raekke(503) });
  const ventet = [];
  const vent = async (ms) => { ventet.push(ms); tid += ms; };
  await assert.rejects(lav(hent, { vent, nu: () => tid, timeoutMs: 10000 }).transskriber(lyd(), valg()), GeminiFejl);
  // 2 + 4 s når inden for 10 s. 8 s mere ville ikke.
  assert.deepEqual(ventet, [2000, 4000]);
  assert.equal(antal(kald, '/v1beta/interactions'), 3);
});

test('en Retry-After ud over tidsgrænsen giver straks fejl', async () => {
  const { hent, kald } = falskHent({ interaktion: raekke(() => json(429, {}, { 'retry-after': '900' }), 200) });
  const v = maaltVent();
  await assert.rejects(lav(hent, { vent: v.vent, timeoutMs: 840000 }).transskriber(lyd(), langLyd()), (e) => e.status === 429);
  assert.deepEqual(v.ventet, []);
  assert.equal(antal(kald, '/v1beta/interactions'), 1);
});

test('upload-start genforsøges ved 503 og netværksfejl', async () => {
  let n = 0;
  const { hent, kald } = falskHent({
    startSvar: () => {
      n++;
      if (n === 1) return json(503, {});
      if (n === 2) throw new TypeError('fetch failed');
      return startOk();
    },
  });
  const v = maaltVent();
  assert.equal((await lav(hent, { vent: v.vent }).transskriber(lyd(), valg())).tekst, 'Hej');
  assert.equal(antal(kald, '/upload/v1beta/files'), 3);
  assert.deepEqual(v.ventet, [2000, 4000]);
});

test('selve lyden uploades aldrig igen, da strømmen ikke kan spoles tilbage', async () => {
  const { hent, kald } = falskHent({ uploadSvar: () => json(503, {}) });
  const v = maaltVent();
  await assert.rejects(lav(hent, { vent: v.vent }).transskriber(lyd(), valg()), (e) => e.kode === 'tjeneste' && e.hvor === 'upload');
  assert.equal(kald.filter((k) => k.url === 'https://upload.example/u1').length, 1);
  assert.deepEqual(v.ventet, []);
  assert.ok(kald.some((k) => k.metode === 'DELETE'));
});

test('netværksfejl ved transskriptionen genforsøges', async () => {
  let n = 0;
  const { hent, kald } = falskHent({
    interaktion: () => {
      if (n++ === 0) throw new TypeError('other side closed');
      return json(200, SVAR_OK);
    },
  });
  const v = maaltVent();
  assert.equal((await lav(hent, { vent: v.vent }).transskriber(lyd(), valg())).tekst, 'Hej');
  assert.equal(antal(kald, '/v1beta/interactions'), 2);
  assert.deepEqual(v.ventet, [2000]);
});

test('et afbrudt kald genforsøges ikke', async () => {
  const ctrl = new AbortController();
  const { hent, kald } = falskHent({
    interaktion: (v) => new Promise((_, afvis) => {
      v.signal.addEventListener('abort', () => afvis(v.signal.reason));
      setTimeout(() => ctrl.abort(), 5);
    }),
  });
  const v = maaltVent();
  await assert.rejects(lav(hent, { vent: v.vent }).transskriber(lyd(), { bytes: 3, mime: 'audio/mp4', signal: ctrl.signal }), GeminiFejl);
  assert.equal(antal(kald, '/v1beta/interactions'), 1);
  assert.deepEqual(v.ventet, []);
});

test('venten afbrydes, når klienten går, og hænger aldrig', async () => {
  const ctrl = new AbortController();
  const { hent, kald } = falskHent({ interaktion: raekke(503) });
  // Den rigtige vente-funktion: 2 s, som skal afbrydes efter 20 ms.
  const g = lav(hent, { vent: undefined, timeoutMs: 60000 });
  setTimeout(() => ctrl.abort(), 20);
  const start = Date.now();
  await assert.rejects(g.transskriber(lyd(), { bytes: 3, mime: 'audio/mp4', signal: ctrl.signal }), GeminiFejl);
  assert.ok(Date.now() - start < 1000);
  assert.equal(antal(kald, '/v1beta/interactions'), 1);
});

test('genforsøg logges kun med koder og tal', async () => {
  const { hent } = falskHent({ interaktion: raekke(503, 200) });
  const logs = [];
  await lav(hent, { log: (o) => logs.push(o) }).transskriber(lyd(), valg());
  assert.deepEqual(logs.filter((o) => o.haendelse === 'gemini-genforsoeg'),
    [{ haendelse: 'gemini-genforsoeg', hvor: 'interactions', status: 503, forsoeg: 1, ventMs: 2000 }]);
});

test('hentUdenGraense giver svarets headere, så Retry-After kan læses', async () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => { res.writeHead(429, { 'retry-after': '5' }); res.end('{}'); });
  await new Promise((ok) => server.listen(0, ok));
  try {
    const svar = await hentUdenGraense(`http://localhost:${server.address().port}/x`, {
      method: 'POST', headers: {}, body: '{}', signal: new AbortController().signal,
    });
    assert.equal(svar.status, 429);
    assert.equal(svar.headers.get('Retry-After'), '5');
    assert.equal(svar.headers.get('x-findes-ikke'), null);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

// Googles egen fejlkode, så årsagen kan ses i Cloud Logging. Aldrig beskeden.

const KVOTE = {
  error: {
    code: 429,
    message: 'HEMMELIG-BESKED Quota exceeded for metric generate_content_input_token_count',
    status: 'RESOURCE_EXHAUSTED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }],
  },
};

test('fejlen har Googles status, fejlkode og trin, men aldrig beskeden', async () => {
  const { hent } = falskHent({ interaktion: () => json(429, KVOTE) });
  await assert.rejects(lav(hent, { timeoutMs: 1000 }).transskriber(lyd(), valg()), (e) => {
    assert.equal(e.kode, 'tjeneste');
    assert.equal(e.status, 429);
    assert.equal(e.googleKode, 'RESOURCE_EXHAUSTED');
    assert.equal(e.trin, 'transskription');
    assert.ok(!e.message.includes('HEMMELIG'));
    assert.ok(!JSON.stringify(e).includes('HEMMELIG'));
    return true;
  });
});

test('en fejlkode, der ikke ligner Googles faste koder, medtages ikke', async () => {
  const { hent } = falskHent({ interaktion: () => json(503, { error: { status: 'hej med dig, Peter' } }) });
  await assert.rejects(lav(hent, { timeoutMs: 1000 }).transskriber(lyd(), valg()), (e) => {
    assert.equal(e.status, 503);
    assert.equal(e.googleKode, undefined);
    return true;
  });
});

test('fejl ved upload-start og ved selve lyden har trin upload', async () => {
  const a = falskHent({ startSvar: () => json(403, { error: { status: 'PERMISSION_DENIED' } }) });
  await assert.rejects(lav(a.hent).transskriber(lyd(), valg()), (e) => e.trin === 'upload' && e.googleKode === 'PERMISSION_DENIED' && e.kode === 'noegle');
  const b = falskHent({ uploadSvar: () => json(500, { error: { status: 'INTERNAL' } }) });
  await assert.rejects(lav(b.hent).transskriber(lyd(), valg()), (e) => e.trin === 'upload' && e.googleKode === 'INTERNAL' && e.status === 500);
});

test('netværksfejl har trin og fejltype, men ingen besked', async () => {
  const { hent } = falskHent({ interaktion: () => { throw new TypeError('HEMMELIG fetch failed'); } });
  await assert.rejects(lav(hent, { timeoutMs: 1000 }).transskriber(lyd(), valg()), (e) => {
    assert.equal(e.trin, 'transskription');
    assert.equal(e.fejltype, 'TypeError');
    assert.ok(!JSON.stringify(e).includes('HEMMELIG') && !e.message.includes('HEMMELIG'));
    return true;
  });
});

test('retryDelay i Googles fejlsvar respekteres', async () => {
  const { hent } = falskHent({ interaktion: raekke(() => json(429, KVOTE), 200) });
  const v = maaltVent();
  const logs = [];
  await lav(hent, { vent: v.vent, log: (o) => logs.push(o) }).transskriber(lyd(), langLyd());
  assert.deepEqual(v.ventet, [37000]);
  assert.deepEqual(logs.filter((o) => o.haendelse === 'gemini-genforsoeg'), [{ haendelse: 'gemini-genforsoeg', hvor: 'interactions', status: 429, googleKode: 'RESOURCE_EXHAUSTED', forsoeg: 1, ventMs: 37000 }]);
});

test('mange kald, der rammer Flashs minutgrænse, venter grænsen ud i stedet for at fejle', async () => {
  // Som testbænken: Google svarer 429 i et minut og derefter igen normalt.
  let tid = Date.UTC(2026, 10, 3, 12);
  const aabner = tid + 60000;
  const { hent } = falskHent({ interaktion: () => (tid < aabner ? json(429, KVOTE) : json(200, SVAR_OK)) });
  const vent = async (ms) => { tid += ms; };
  const g = lav(hent, { vent, nu: () => tid, timeoutMs: 840000 });
  for (let i = 0; i < 5; i++) assert.equal((await g.transskriber(lyd(), langLyd())).tekst, 'Hej');
});

// Googles dagsgrænse (Tier 1: 100 transskriptioner om dagen), som testbænken ramte 4. nov. 2026.
const DAGSGRAENSE = {
  error: {
    message: 'Rate limit exceeded for model gemini-3.5-transcribe (limit: 100 requests per day on Tier 1). Please retry in 18h17m or upgrade your tier at https://ai.dev/rate-limit.',
    code: 'too_many_requests',
  },
};

test('dagsgrænsen hos Google genforsøges ikke og giver kvote med Googles kode', async () => {
  const { hent, kald } = falskHent({ interaktion: () => json(429, DAGSGRAENSE) });
  const v = maaltVent();
  await assert.rejects(lav(hent, { vent: v.vent }).transskriber(lyd(), langLyd()), (e) => {
    assert.equal(e.kode, 'kvote');
    assert.equal(e.status, 429);
    assert.equal(e.googleKode, 'too_many_requests');
    assert.ok(!JSON.stringify(e).includes('Rate limit'));
    return true;
  });
  assert.equal(antal(kald, '/interactions'), 1);
  assert.deepEqual(v.ventet, []);
});

// Fund fra den afsluttende gennemgang

test('upload-start venter højst 45 s i alt, så telefonens vagt på 90 s ikke afbryder', async () => {
  const retry37 = () => json(429, { error: { status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }] } });
  const { hent, kald } = falskHent({ startSvar: raekke(retry37, retry37, retry37, startOk) });
  const v = maaltVent();
  await assert.rejects(lav(hent, { vent: v.vent, timeoutMs: 840000 }).transskriber(lyd(), valg()), (e) => e.status === 429 && e.trin === 'upload');
  assert.ok(v.ventet.reduce((s, x) => s + x, 0) <= 45000, `ventede ${v.ventet}`);
  assert.equal(antal(kald, '/upload/v1beta/files'), 2);
});

test('en lang transskription, der fejler med 503, genforsøges ikke uden tid nok til et nyt forsøg', async () => {
  let tid = Date.UTC(2026, 10, 3, 12);
  // Første forsøg tager 500 s og fejler. Der er kun ca. 340 s tilbage af 840.
  const { hent, kald } = falskHent({ interaktion: () => { tid += 500000; return json(503, {}); } });
  const v = { ventet: [], vent: async (ms) => { v.ventet.push(ms); tid += ms; } };
  await assert.rejects(lav(hent, { vent: v.vent, nu: () => tid, timeoutMs: 840000 }).transskriber(lyd(), valg()), (e) => e.status === 503);
  assert.equal(antal(kald, '/v1beta/interactions'), 1);
});

test('dagsgrænsen genkendes også uden teksten "per day": lang ventetid eller quotaId PerDay', async () => {
  const lang = { error: { code: 'too_many_requests', message: 'Limit reached. Please retry in 18h17m.' } };
  const a = falskHent({ interaktion: () => json(429, lang) });
  await assert.rejects(lav(a.hent, { vent: async () => {} }).transskriber(lyd(), langLyd()), (e) => e.kode === 'kvote');
  const quota = { error: { status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }] }] } };
  const b = falskHent({ interaktion: () => json(429, quota) });
  await assert.rejects(lav(b.hent, { vent: async () => {} }).transskriber(lyd(), langLyd()), (e) => e.kode === 'kvote');
  // En minutgrænse er ikke en dagsgrænse.
  const minut = { error: { status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }] } };
  const c = falskHent({ interaktion: raekke(() => json(429, minut), 200) });
  assert.equal((await lav(c.hent, { vent: async () => {} }).transskriber(lyd(), langLyd())).tekst, 'Hej');
});

// Modelvalg: Transcribe til korte optagelser, Flash til lange og som reserve (Tier 1-grænserne).

const interaktionsKroppe = (kald) => kald.filter((k) => k.url.endsWith('/v1beta/interactions')).map((k) => JSON.parse(k.krop));
const modelIKald = (kald) => interaktionsKroppe(kald).map((k) => k.model);

/** Falsk Google, der svarer forskelligt efter model. */
function perModel({ transcribe = raekke(200), flash = raekke(200) }) {
  return (v) => (JSON.parse(v.body).model === 'gemini-3.8-flash' ? flash(v) : transcribe(v));
}

test('kort eller ukendt varighed bruger Transcribe', async () => {
  for (const varighedSek of [undefined, null, 0, 120, 400]) {
    const { hent, kald } = falskHent();
    await lav(hent).transskriber(lyd(), valg('audio/mp4', { varighedSek }));
    assert.deepEqual(modelIKald(kald), ['gemini-3.5-transcribe'], String(varighedSek));
  }
});

test('lyd over grænsen går direkte til Flash med den uploadede fil', async () => {
  const { hent, kald } = falskHent();
  const logs = [];
  const svar = await lav(hent, { log: (o) => logs.push(o) }).transskriber(lyd(), langLyd());
  assert.equal(svar.tekst, 'Hej');
  assert.deepEqual(modelIKald(kald), ['gemini-3.8-flash']);
  const krop = interaktionsKrop(kald);
  assert.deepEqual(krop.input[0], { type: 'audio', uri: `https://generativelanguage.googleapis.com/v1beta/${startNavn(kald)}`, mime_type: 'audio/m4a' });
  assert.equal(krop.input[1].type, 'text');
  assert.deepEqual(krop.generation_config, { thinking_level: 'low' });
  assert.equal(krop.store, false);
  assert.deepEqual(logs, [
    { haendelse: 'gemini-kald', model: 'flash' },
    { haendelse: 'model-skift', grund: 'laengde', fra: 'transcribe', til: 'flash' },
  ]);
  assert.equal(kald.filter((k) => k.metode === 'DELETE').length, 1);
});

test('grænsen for Transcribe kan ændres', async () => {
  const { hent, kald } = falskHent();
  await lav(hent, { transcribeMaksSek: 1200 }).transskriber(lyd(), valg('audio/mp4', { varighedSek: 900 }));
  assert.deepEqual(modelIKald(kald), ['gemini-3.5-transcribe']);
});

test('Flash-modellen kommer fra indstillingen', async () => {
  const { hent, kald } = falskHent();
  await lav(hent, { flashModel: 'gemini-x-flash' }).transskriber(lyd(), valg('audio/mp4', { varighedSek: 3000 }));
  assert.deepEqual(modelIKald(kald), ['gemini-x-flash']);
});

test('Flash-prompten er fast, dansk og har ordlisten med', async () => {
  const a = falskHent();
  await lav(a.hent).transskriber(lyd(), langLyd());
  const tekst = interaktionsKrop(a.kald).input[1].text;
  assert.match(tekst, /^Transskriber lyden ordret på dansk\./);
  assert.match(tekst, /"\[uklart\]"/);
  assert.match(tekst, /Opfind aldrig noget\./);
  assert.match(tekst, /Fagord, der kan forekomme: ØLLGAARD, lægte\.$/);
  const b = falskHent();
  await lav(b.hent, { ordliste: [] }).transskriber(lyd(), langLyd());
  assert.ok(!interaktionsKrop(b.kald).input[1].text.includes('Fagord'));
});

test('gemini-kald logges med kort modelnavn', async () => {
  const { hent } = falskHent();
  const logs = [];
  await lav(hent, { log: (o) => logs.push(o) }).transskriber(lyd(), valg());
  assert.deepEqual(logs, [{ haendelse: 'gemini-kald', model: 'transcribe' }]);
});

for (const [navn, krop] of [['minutgrænse', KVOTE], ['dagsgrænse', DAGSGRAENSE]]) {
  test(`Transcribes ${navn} giver straks Flash med samme fil, uden venten og ny upload`, async () => {
    const { hent, kald } = falskHent({ interaktion: perModel({ transcribe: () => json(429, krop) }) });
    const v = maaltVent();
    const logs = [];
    const svar = await lav(hent, { vent: v.vent, log: (o) => logs.push(o) }).transskriber(lyd(), valg());
    assert.equal(svar.tekst, 'Hej');
    assert.deepEqual(v.ventet, []);
    assert.deepEqual(modelIKald(kald), ['gemini-3.5-transcribe', 'gemini-3.8-flash']);
    assert.equal(antal(kald, '/upload/v1beta/files'), 1);
    const [t, f] = interaktionsKroppe(kald);
    assert.equal(f.input[0].uri, t.input[0].uri);
    assert.equal(f.input[0].mime_type, t.input[0].mime_type);
    assert.deepEqual(logs, [
      { haendelse: 'gemini-kald', model: 'transcribe' },
      { haendelse: 'model-skift', grund: '429', fra: 'transcribe', til: 'flash' },
    ]);
    assert.equal(kald.filter((k) => k.metode === 'DELETE').length, 1);
  });
}

test('Flash som reserve har de normale genforsøg', async () => {
  const { hent, kald } = falskHent({ interaktion: perModel({ transcribe: () => json(429, {}), flash: raekke(503, 200) }) });
  const v = maaltVent();
  assert.equal((await lav(hent, { vent: v.vent }).transskriber(lyd(), valg())).tekst, 'Hej');
  assert.deepEqual(v.ventet, [2000]);
  assert.deepEqual(modelIKald(kald), ['gemini-3.5-transcribe', 'gemini-3.8-flash', 'gemini-3.8-flash']);
});

test('Flash med dagsgrænse efter Transcribe 429 giver kvote', async () => {
  const { hent, kald } = falskHent({ interaktion: perModel({ transcribe: () => json(429, KVOTE), flash: () => json(429, DAGSGRAENSE) }) });
  await assert.rejects(lav(hent).transskriber(lyd(), valg()), (e) => e.kode === 'kvote' && e.status === 429);
  assert.deepEqual(modelIKald(kald), ['gemini-3.5-transcribe', 'gemini-3.8-flash']);
});

test('Transcribe 5xx efter genforsøg: Flash prøves, når der er tid nok', async () => {
  const { hent, kald } = falskHent({ interaktion: perModel({ transcribe: () => json(503, {}) }) });
  const logs = [];
  assert.equal((await lav(hent, { log: (o) => logs.push(o), timeoutMs: 840000 }).transskriber(lyd(), valg())).tekst, 'Hej');
  assert.deepEqual(modelIKald(kald), [...Array(4).fill('gemini-3.5-transcribe'), 'gemini-3.8-flash']);
  assert.ok(logs.some((o) => o.haendelse === 'model-skift' && o.grund === '5xx' && o.fra === 'transcribe' && o.til === 'flash'));
  assert.equal(antal(kald, '/upload/v1beta/files'), 1);
});

test('Transcribe 5xx: Flash kun med tid nok tilbage', async () => {
  // [varighed pr. forsøg, samlet frist, forventede modeller]
  const tilfaelde = [
    // 4 forsøg à 25 s + 14 s venten = 114 s brugt, 726 s tilbage: Flash.
    [25000, 840000, [...Array(4).fill('gemini-3.5-transcribe'), 'gemini-3.8-flash']],
    // 14 s brugt, men kun 56 s tilbage: under et minut, ingen Flash.
    [0, 70000, Array(4).fill('gemini-3.5-transcribe')],
    // Ét forsøg på 500 s, 340 s tilbage: Flash kunne tage lige så lang tid, ingen Flash.
    [500000, 840000, ['gemini-3.5-transcribe']],
  ];
  for (const [forsoegMs, timeoutMs, forventet] of tilfaelde) {
    let tid = Date.UTC(2026, 10, 3, 12);
    const { hent, kald } = falskHent({ interaktion: perModel({ transcribe: () => { tid += forsoegMs; return json(503, {}); } }) });
    await lav(hent, { vent: async (ms) => { tid += ms; }, nu: () => tid, timeoutMs }).transskriber(lyd(), valg()).catch(() => {});
    assert.deepEqual(modelIKald(kald), forventet, `${forsoegMs} ${timeoutMs}`);
  }
});

for (const [status, kode] of [[400, 'format'], [401, 'noegle'], [403, 'noegle']]) {
  test(`Transcribe ${status} skifter ikke til Flash`, async () => {
    const { hent, kald } = falskHent({ interaktion: perModel({ transcribe: () => json(status, {}) }) });
    await assert.rejects(lav(hent).transskriber(lyd(), valg()), (e) => e.kode === kode);
    assert.deepEqual(modelIKald(kald), ['gemini-3.5-transcribe']);
  });
}

test('et ufuldstændigt svar eller en netværksfejl fra Transcribe skifter ikke til Flash', async () => {
  const a = falskHent({ interaktion: perModel({ transcribe: () => json(200, { status: 'incomplete' }) }) });
  await assert.rejects(lav(a.hent).transskriber(lyd(), valg()), GeminiFejl);
  assert.deepEqual(modelIKald(a.kald), ['gemini-3.5-transcribe']);
  const b = falskHent({ interaktion: perModel({ transcribe: () => { throw new TypeError('fetch failed'); } }) });
  await assert.rejects(lav(b.hent).transskriber(lyd(), valg()), GeminiFejl);
  assert.ok(!modelIKald(b.kald).includes('gemini-3.8-flash'));
});

test('Flash bruger også kaldet uden svartidsgrænse', async () => {
  const { hent, kald } = falskHent();
  const langsomme = [];
  const hentLangsom = async (url, v) => { langsomme.push(JSON.parse(v.body).model); return json(200, SVAR_OK); };
  await lav(hent, { hentLangsom }).transskriber(lyd(), langLyd());
  assert.deepEqual(langsomme, ['gemini-3.8-flash']);
  assert.ok(!kald.some((k) => k.url.endsWith('/v1beta/interactions')));
});

// Uploadede lydfiler: typer, Google kender. Lyden sendes uændret.

test('geminiMime oversætter alle godkendte formater', () => {
  const forventet = {
    'audio/mp4': 'audio/m4a', 'audio/x-m4a': 'audio/m4a', 'audio/m4a': 'audio/m4a', 'audio/mp4;codecs=mp4a.40.2': 'audio/m4a',
    'audio/webm': 'audio/webm', 'audio/webm;codecs=opus': 'audio/webm',
    'audio/mpeg': 'audio/mp3', 'audio/mp3': 'audio/mp3', 'AUDIO/MPEG': 'audio/mp3',
    'audio/wav': 'audio/wav', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav',
    'audio/ogg': 'audio/ogg', 'audio/ogg; codecs=opus': 'audio/ogg',
    'audio/aac': 'audio/aac', 'audio/flac': 'audio/flac', 'audio/x-flac': 'audio/flac',
  };
  for (const [ind, ud] of Object.entries(forventet)) assert.equal(geminiMime(ind), ud, ind);
});

test('en mp3 uploades og transskriberes med Googles type', async () => {
  const { hent, kald } = falskHent();
  await lav(hent).transskriber(lyd(), valg('audio/mpeg'));
  assert.equal(kald[0].headers['X-Goog-Upload-Header-Content-Type'], 'audio/mp3');
  assert.equal(interaktionsKrop(kald).input[0].mime_type, 'audio/mp3');
});

// Flash som førstevalg (testbænken 6. nov. 2026: Flash 5,6 % mod Transcribe 17,4 % ordfejl;
// Transcribe tabte sætninger i møder). Transcribe er reserve for korte optagelser.

const BLOKERET = () => json(400, { error: { code: 'content_blocked', message: 'blocked' } });

test('Flash som førstevalg: også korte og ukendte optagelser går til Flash', async () => {
  for (const varighedSek of [undefined, 60, 400, 3600]) {
    const { hent, kald } = falskHent();
    await lav(hent, { foerst: 'flash' }).transskriber(lyd(), valg('audio/mp4', { varighedSek }));
    assert.deepEqual(modelIKald(kald), ['gemini-3.8-flash'], String(varighedSek));
  }
});

test('Flash blokeret (content_blocked): Transcribe tager over med samme fil, når optagelsen er kort', async () => {
  const { hent, kald } = falskHent({ interaktion: perModel({ flash: BLOKERET }) });
  const logs = [];
  const svar = await lav(hent, { foerst: 'flash', log: (o) => logs.push(o) }).transskriber(lyd(), valg('audio/mp4', { varighedSek: 60 }));
  assert.equal(svar.tekst, 'Hej');
  assert.deepEqual(modelIKald(kald), ['gemini-3.8-flash', 'gemini-3.5-transcribe']);
  assert.equal(antal(kald, '/upload/v1beta/files'), 1);
  assert.ok(logs.some((l) => l.haendelse === 'model-skift' && l.grund === 'blokeret' && l.fra === 'flash' && l.til === 'transcribe'));
});

test('Flash overbelastet efter genforsøg: Transcribe tager over, når optagelsen er kort', async () => {
  const { hent, kald } = falskHent({ interaktion: perModel({ flash: raekke(503) }) });
  const svar = await lav(hent, { foerst: 'flash' }).transskriber(lyd(), valg('audio/mp4', { varighedSek: 60 }));
  assert.equal(svar.tekst, 'Hej');
  assert.equal(modelIKald(kald).at(-1), 'gemini-3.5-transcribe');
});

test('lang optagelse: Transcribe er ikke reserve, fordi den er over grænsen pr. minut', async () => {
  const { hent, kald } = falskHent({ interaktion: perModel({ flash: BLOKERET }) });
  await assert.rejects(lav(hent, { foerst: 'flash' }).transskriber(lyd(), langLyd()), (e) => e.status === 400 && e.googleKode === 'content_blocked');
  assert.deepEqual(modelIKald(kald), ['gemini-3.8-flash']);
});
