'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { lavGemini, GeminiFejl, hentUdenGraense } = require('../src/gemini.js');

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
    sprog: 'da-DK',
    tilstand: 'smart',
    ordliste: ['ØLLGAARD', 'lægte'],
    timeoutMs: 1000,
    hent,
    ...ekstra,
  });
}

const lyd = () => Readable.from([Buffer.from('lyd')]);
const valg = (mime = 'audio/mp4') => ({ bytes: 3, mime, signal: new AbortController().signal });

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
