'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { lavGemini, GeminiFejl } = require('../src/gemini.js');

const NOEGLE = 'hemmelig-testnoegle';
const FIL = { name: 'files/abc', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc' };
const SVAR_OK = { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Hej' }] }] };

function json(status, krop, headers = {}) {
  return new Response(JSON.stringify(krop), { status, headers });
}

// Falsk Google. `interaktion` afgør svaret på transskriptionen.
function falskHent({ interaktion = () => json(200, SVAR_OK), startSvar } = {}) {
  const kald = [];
  const hent = async (url, valg = {}) => {
    const s = String(url);
    kald.push({ url: s, metode: valg.method, headers: valg.headers || {}, krop: valg.body, duplex: valg.duplex });
    if (s.endsWith('/upload/v1beta/files')) {
      if (startSvar) return startSvar();
      return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example/u1' } });
    }
    if (s === 'https://upload.example/u1') {
      for await (const _ of valg.body) { /* læs strømmen */ }
      return json(200, { file: FIL });
    }
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
  assert.equal(interaktionsKrop(kald).input[0].uri, FIL.uri);
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

test('sletter fil efter succes', async () => {
  const { hent, kald } = falskHent();
  await lav(hent).transskriber(lyd(), valg());
  const slet = kald.find((k) => k.metode === 'DELETE');
  assert.ok(slet.url.endsWith('/v1beta/files/abc'));
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

test('nøglen indgår aldrig i en fejlbesked', async () => {
  const hent = async () => { throw new Error(`nede ${NOEGLE}`); };
  await assert.rejects(lav(hent).transskriber(lyd(), valg()), (e) => {
    assert.ok(!e.message.includes(NOEGLE));
    return e instanceof GeminiFejl && e.kode === 'tjeneste';
  });
});
