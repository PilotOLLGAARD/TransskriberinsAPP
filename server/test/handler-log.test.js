'use strict';
/**
 * Alle fejlveje i handleren: hver fejl giver et svar med en fejl-kode, som appen kan oversætte,
 * og en log med en haendelse, så årsagen kan ses i Cloud Logging. Loggen må kun indeholde koder
 * og tal: aldrig lyd, tekst, titel, mailadresse, navne, beviset eller nøglen.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { lavHandler } = require('../src/handler.js');
const { GeminiFejl } = require('../src/gemini.js');

const OPRINDELSE = 'https://ollgaard.github.io';
const NOEGLE = 'HEMMELIG-NOEGLE-AIza';
const KONFIG = { tilladtOprindelse: OPRINDELSE, maxBytes: 1000, noegle: NOEGLE };
const BEVIS = 'Bearer HEMMELIGT.BEVIS.x';
const HEMMELIGT = [
  'HEMMELIG', 'peter@ollgaard.dk', 'Peter Hansen', 'HEMMELIGT.BEVIS', NOEGLE, 'LYD-BYTES', 'Hej',
];

// Appens oversættelse af HTTP-status læses direkte fra appen, så testen følger den.
const appKilde = fs.readFileSync(path.join(__dirname, '../../web/js/transskribering.js'), 'utf8');
const FEJLTYPER = Function(`return ${/const FEJLTYPER = (\{[^}]*\});/.exec(appKilde)[1]}`)();
const appType = (status) => FEJLTYPER[status] || 'tjeneste';

const lyd = () => Buffer.from('LYD-BYTES fra peter@ollgaard.dk');
const titel = encodeURIComponent('HEMMELIG titel til Peter Hansen, peter@ollgaard.dk');

function falskReq({ sti = '/transskriber', headers = {}, krop = lyd(), dele } = {}) {
  const req = Readable.from(dele || [krop]);
  Object.assign(req, {
    method: 'POST',
    url: sti,
    headers: {
      origin: OPRINDELSE,
      authorization: BEVIS,
      'content-type': 'audio/mp4',
      'content-length': String(krop.length),
      'x-titel': titel,
      ...headers,
    },
  });
  for (const [k, v] of Object.entries(req.headers)) if (v === undefined) delete req.headers[k];
  return req;
}

function koer(handlerValg, reqValg) {
  const logs = [];
  const handler = lavHandler({
    konfig: KONFIG,
    tjekAdgang: async () => ({ ok: true }),
    gemini: { async transskriber(strom) { for await (const _ of strom) { /* læs */ } return { tekst: 'Hej fra Peter Hansen' }; } },
    referat: { async lav() { return { titel: 'HEMMELIG', type: 'moede', opsummering: 'HEMMELIG' }; } },
    pdf: { async lavPdf() { return Buffer.from('%PDF'); }, filnavn: () => 'HEMMELIG.pdf' },
    log: (o) => logs.push(o),
    ...handlerValg,
  });
  return new Promise((ok) => {
    const res = {
      headersSent: false,
      writableEnded: false,
      on() {},
      once() {},
      writeHead(status, headers) { this.status = status; this.headers = headers || {}; this.headersSent = true; },
      end(krop) {
        this.writableEnded = true;
        ok({ status: this.status, headers: this.headers, krop: JSON.parse(String(krop || '{}')), logs });
      },
    };
    handler(falskReq(reqValg), res);
  });
}

const fejlGemini = (fejl) => ({ async transskriber(strom) { for await (const _ of strom) { /* læs */ } throw fejl; } });
const fejlReferat = (fejl) => ({ async lav() { throw fejl; } });
const gFejl = (kode, detaljer) => new GeminiFejl(kode, 'HEMMELIG besked fra Google om Peter Hansen', detaljer);
const json = (o) => Buffer.from(JSON.stringify(o));
const referatReq = (krop, headers = {}) => ({ sti: '/referat', krop, headers: { 'content-type': 'application/json', ...headers } });

// [navn, handler-valg, anmodning, status, appens type, forventet log (delvis)]
const FEJLVEJE = [
  ...[
    [401, 'ugyldigt-bevis'], [401, 'ugyldig-signatur'], [401, 'udloebet'], [401, 'ikke-gyldigt-endnu'], [401, 'ukendt-noegle'],
    [403, 'forkert-tenant'], [403, 'forkert-app'], [403, 'mangler-scope'], [403, 'ikke-medarbejder'],
    [503, 'noegler-utilgaengelige'], [401, 'mangler-konfiguration'],
  ].map(([status, grund]) => [`adgang: ${grund}`, { tjekAdgang: async () => ({ ok: false, status, grund }) }, {}, status,
    { 401: 'login', 403: 'adgang', 503: 'tjeneste' }[status], { haendelse: 'adgang-afvist', grund, status }]),
  ['adgang: /referat uden adgang', { tjekAdgang: async () => ({ ok: false, status: 401, grund: 'udloebet' }) }, referatReq(json({ tekster: ['HEMMELIG'] })), 401, 'login',
    { haendelse: 'adgang-afvist', grund: 'udloebet' }],
  ['adgang: tjekket kaster', { tjekAdgang: async () => { throw new Error('HEMMELIGT.BEVIS'); } }, {}, 500, 'tjeneste', { haendelse: 'uventet-fejl' }],
  ['server uden konfiguration', { konfig: null }, {}, 500, 'tjeneste', { haendelse: 'anmodning-afvist', grund: 'konfiguration-mangler' }],
  ['forkert format', {}, { headers: { 'content-type': 'text/plain' } }, 415, 'kanIkkeBehandles', { haendelse: 'anmodning-afvist', grund: 'forkert-format', status: 415 }],
  ['mangler længde', {}, { headers: { 'content-length': undefined } }, 411, 'kanIkkeBehandles', { haendelse: 'anmodning-afvist', grund: 'mangler-laengde', status: 411 }],
  ['ugyldig længde', {}, { headers: { 'content-length': '-5' } }, 411, 'kanIkkeBehandles', { haendelse: 'anmodning-afvist', grund: 'mangler-laengde' }],
  ['for stor', {}, { headers: { 'content-length': '1001' } }, 413, 'kanIkkeBehandles', { haendelse: 'anmodning-afvist', grund: 'for-stor', status: 413 }],
  ['strøm større end oplyst', {}, { headers: { 'content-length': '10' }, dele: [Buffer.alloc(50), Buffer.alloc(50)] }, 413, 'kanIkkeBehandles',
    { haendelse: 'anmodning-afvist', grund: 'for-mange-bytes', status: 413 }],
  ...[[429, 'RESOURCE_EXHAUSTED'], [500, 'INTERNAL'], [503, 'UNAVAILABLE'], [504, 'DEADLINE_EXCEEDED']].map(([status, googleKode]) => [
    `Gemini ${status}`, { gemini: fejlGemini(gFejl('tjeneste', { status, hvor: 'interactions', googleKode })) }, {}, 502, 'tjeneste',
    { haendelse: 'gemini-fejl', kode: 'tjeneste', trin: 'transskription', googleStatus: status, googleKode }]),
  ['Gemini 400', { gemini: fejlGemini(gFejl('format', { status: 400, hvor: 'interactions', googleKode: 'INVALID_ARGUMENT' })) }, {}, 422, 'kanIkkeBehandles',
    { haendelse: 'gemini-fejl', kode: 'format', googleStatus: 400 }],
  ...[401, 403].map((status) => [`Gemini ${status}`, { gemini: fejlGemini(gFejl('noegle', { status, hvor: 'upload-start' })) }, {}, 500, 'tjeneste',
    { haendelse: 'gemini-fejl', kode: 'noegle', trin: 'upload', googleStatus: status }]),
  ['Gemini upload fejler', { gemini: fejlGemini(gFejl('tjeneste', { status: 503, hvor: 'upload' })) }, {}, 502, 'tjeneste',
    { haendelse: 'gemini-fejl', trin: 'upload', googleStatus: 503 }],
  ['Gemini netværksfejl', { gemini: fejlGemini(gFejl('tjeneste', { trin: 'transskription', fejltype: 'TimeoutError' })) }, {}, 502, 'tjeneste',
    { haendelse: 'gemini-fejl', kode: 'tjeneste', trin: 'transskription', fejltype: 'TimeoutError' }],
  ['Gemini kaster noget uventet', { gemini: fejlGemini(new TypeError('HEMMELIG Peter Hansen')) }, {}, 502, 'tjeneste',
    { haendelse: 'gemini-fejl', kode: 'tjeneste', trin: 'transskription', fejltype: 'TypeError' }],
  ['referat 429', { referat: fejlReferat(gFejl('tjeneste', { status: 429, hvor: 'referat', googleKode: 'RESOURCE_EXHAUSTED' })) }, {}, 502, 'tjeneste',
    { haendelse: 'gemini-fejl', kode: 'tjeneste', trin: 'referat', googleStatus: 429, googleKode: 'RESOURCE_EXHAUSTED' }],
  ['referat nøgle afvist', { referat: fejlReferat(gFejl('noegle', { status: 403, hvor: 'referat' })) }, {}, 500, 'tjeneste',
    { haendelse: 'gemini-fejl', kode: 'noegle', trin: 'referat' }],
  ['referat kaster noget uventet', { referat: fejlReferat(new Error('HEMMELIG')) }, {}, 502, 'tjeneste',
    { haendelse: 'gemini-fejl', kode: 'tjeneste', trin: 'referat', fejltype: 'Error' }],
  ['PDF fejler', { pdf: { async lavPdf() { throw new RangeError('HEMMELIG'); }, filnavn: () => 'x' } }, {}, 502, 'tjeneste',
    { haendelse: 'gemini-fejl', kode: 'tjeneste', trin: 'pdf', fejltype: 'RangeError' }],
  ['/referat forkert format', {}, referatReq(json({ tekster: ['HEMMELIG'] }), { 'content-type': 'text/plain' }), 415, 'kanIkkeBehandles',
    { haendelse: 'anmodning-afvist', grund: 'forkert-format', status: 415 }],
  ['/referat mangler længde', {}, referatReq(json({ tekster: ['HEMMELIG'] }), { 'content-length': undefined }), 411, 'kanIkkeBehandles',
    { haendelse: 'anmodning-afvist', grund: 'mangler-laengde' }],
  ['/referat for stor', {}, referatReq(json({ tekster: ['HEMMELIG'] }), { 'content-length': String(3 * 1024 * 1024) }), 413, 'kanIkkeBehandles',
    { haendelse: 'anmodning-afvist', grund: 'for-stor' }],
  ['/referat strøm større end oplyst', {}, { ...referatReq(json({ tekster: ['HEMMELIG'] }), { 'content-length': '5' }) }, 413, 'kanIkkeBehandles',
    { haendelse: 'anmodning-afvist', grund: 'for-mange-bytes' }],
  ['/referat ikke JSON', {}, referatReq(Buffer.from('HEMMELIG ikke json')), 400, 'tjeneste', { haendelse: 'anmodning-afvist', grund: 'ugyldig-json', status: 400 }],
  ...[{ tekster: 'HEMMELIG' }, { tekster: [] }, { tekster: [1, 2] }, { tekster: Array(21).fill('HEMMELIG') }, null].map((krop) => [
    `/referat ugyldig krop ${JSON.stringify(krop).slice(0, 20)}`, {}, referatReq(json(krop)), 400, 'tjeneste',
    { haendelse: 'anmodning-afvist', grund: 'ugyldige-tekster', status: 400 }]),
  ['/referat referat-fejl', { referat: fejlReferat(gFejl('tjeneste', { status: 503, hvor: 'referat', googleKode: 'UNAVAILABLE' })) },
    referatReq(json({ tekster: ['HEMMELIG'], titel: 'HEMMELIG' })), 502, 'tjeneste',
    { haendelse: 'gemini-fejl', trin: 'referat', googleStatus: 503, googleKode: 'UNAVAILABLE' }],
];

/** En log må kun have koder (korte navne uden mellemrum) og tal. */
function tjekLog(o) {
  assert.equal(typeof o.haendelse, 'string', JSON.stringify(o));
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), k);
    else assert.match(String(v), /^[A-Za-z0-9_-]{1,64}$/, `${k} skal være en kode: ${JSON.stringify(o)}`);
    assert.equal(typeof v === 'object', false, k);
  }
  const tekst = JSON.stringify(o);
  for (const h of HEMMELIGT) assert.ok(!tekst.includes(h), `${h} i log: ${tekst}`);
}

for (const [navn, handlerValg, reqValg, status, type, forventetLog] of FEJLVEJE) {
  test(`fejlvej: ${navn}`, async () => {
    const svar = await koer(handlerValg, reqValg);
    assert.equal(svar.status, status);
    // Appen kan kun læse svaret, hvis CORS-headeren er med. Uden konfiguration kendes appens adresse ikke.
    if (handlerValg.konfig !== null) assert.equal(svar.headers['access-control-allow-origin'], OPRINDELSE);
    assert.equal(typeof svar.krop.fejl, 'string');
    assert.match(svar.krop.fejl, /^[a-z-]+$/);
    assert.equal(appType(status), type);
    for (const o of svar.logs) tjekLog(o);
    assert.ok(
      svar.logs.some((o) => Object.entries(forventetLog).every(([k, v]) => o[k] === v)),
      `mangler ${JSON.stringify(forventetLog)} i ${JSON.stringify(svar.logs)}`,
    );
  });
}

test('appen har en besked til hver type, serveren kan give', async () => {
  const { BESKEDER } = await import('../../web/js/beskeder.js');
  for (const [, , , status, type] of FEJLVEJE) assert.ok(BESKEDER[type], `${status} → ${type}`);
});

test('gemini-kald og model-skift fra den rigtige Gemini-del logger kun koder', async () => {
  const { lavGemini } = require('../src/gemini.js');
  // Falsk Google: Transcribe svarer 429 med en besked, der ikke må i loggen. Flash svarer.
  const hent = async (url, v = {}) => {
    const s = String(url);
    if (s.endsWith('/upload/v1beta/files')) return new Response('{}', { headers: { 'x-goog-upload-url': 'https://upload.example/u' } });
    if (s === 'https://upload.example/u') {
      for await (const _ of v.body) { /* læs */ }
      const navn = 'files/x';
      return Response.json({ file: { name: navn, uri: `https://g/${navn}` } });
    }
    if (s.endsWith('/v1beta/interactions')) {
      if (JSON.parse(v.body).model === 'gemini-3.5-transcribe') {
        return Response.json({ error: { status: 'RESOURCE_EXHAUSTED', message: 'HEMMELIG Peter Hansen' } }, { status: 429 });
      }
      return Response.json({ status: 'completed', output_text: 'Hej fra Peter Hansen' });
    }
    return new Response('{}');
  };
  const logs = [];
  const gemini = lavGemini({
    noegle: NOEGLE, model: 'gemini-3.5-transcribe', flashModel: 'gemini-3.8-flash', transcribeMaksSek: 400, sprog: 'da-DK',
    tilstand: 'verbatim', ordliste: ['ØLLGAARD'], timeoutMs: 60000, hent, vent: async () => {}, log: (o) => logs.push(o),
  });
  for (const varighed of ['30', '1200']) {
    const svar = await koer({ gemini, log: (o) => logs.push(o) }, { headers: { 'x-varighed': varighed } });
    assert.equal(svar.status, 200);
  }
  for (const o of logs) tjekLog(o);
  const linjer = logs.filter((o) => ['gemini-kald', 'model-skift'].includes(o.haendelse));
  assert.deepEqual(linjer, [
    { haendelse: 'gemini-kald', model: 'transcribe' },
    { haendelse: 'model-skift', grund: '429', fra: 'transcribe', til: 'flash' },
    { haendelse: 'gemini-kald', model: 'flash' },
    { haendelse: 'model-skift', grund: 'laengde', fra: 'transcribe', til: 'flash' },
  ]);
});

test('også et vellykket kald logger kun koder og tal', async () => {
  const svar = await koer({}, {});
  assert.equal(svar.status, 200);
  assert.ok(svar.logs.length > 0);
  for (const o of svar.logs) tjekLog(o);
});
