'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http2 = require('node:http2');
const { lavServer } = require('../src/server.js');
const { lavHandler } = require('../src/handler.js');

const STOERRELSE = 33 * 1024 * 1024; // Over Cloud Runs grænse på 32 MiB for HTTP/1.

test('h2c-klient, der afbryder, stopper Gemini', async () => {
  let afbrudt;
  const stoppet = new Promise((ok) => { afbrudt = ok; });
  const handler = lavHandler({
    konfig: { tilladtOprindelse: 'https://x', maxBytes: 100 },
    tjekAdgang: async () => ({ ok: true }),
    gemini: {
      async transskriber(strom, { signal }) {
        signal.addEventListener('abort', afbrudt);
        await new Promise((_, afvis) => signal.addEventListener('abort', () => afvis(signal.reason)));
      },
    },
    log: () => {},
  });
  const server = lavServer(handler);
  await new Promise((ok) => server.listen(0, ok));
  const klient = http2.connect(`http://localhost:${server.address().port}`);
  try {
    const r = klient.request({
      ':method': 'POST',
      ':path': '/transskriber',
      'content-type': 'audio/mp4',
      'content-length': '3',
      authorization: 'Bearer x',
    });
    r.on('error', () => {});
    r.end('lyd');
    setTimeout(() => r.close(http2.constants.NGHTTP2_CANCEL), 30);
    await Promise.race([
      stoppet,
      new Promise((_, afvis) => setTimeout(() => afvis(new Error('Gemini blev ikke stoppet')), 2000)),
    ]);
  } finally {
    klient.destroy();
    server.close();
  }
});

test('h2c-klient kan sende 33 MiB', async () => {
  let modtaget = 0;
  const gemini = {
    async transskriber(strom) {
      for await (const d of strom) modtaget += d.length;
      return { tekst: 'Hej' };
    },
  };
  const handler = lavHandler({
    konfig: { tilladtOprindelse: 'https://x', maxBytes: STOERRELSE },
    tjekAdgang: async () => ({ ok: true }),
    gemini,
    referat: { lav: async () => ({ titel: 'T', kort: true, renTekst: 'x', opsummering: '', hovedpunkter: [], beslutninger: [], opgaver: [], fejlOgMangler: [], aabneSpoergsmaal: [] }) },
    pdf: { lavPdf: async () => Buffer.from('%PDF'), filnavn: () => 'x.pdf' },
    log: () => {},
  });
  const server = lavServer(handler);
  await new Promise((ok) => server.listen(0, ok));

  const klient = http2.connect(`http://localhost:${server.address().port}`);
  try {
    const svar = await new Promise((ok, fejl) => {
      const r = klient.request({
        ':method': 'POST',
        ':path': '/transskriber',
        'content-type': 'audio/mp4',
        'content-length': String(STOERRELSE),
        authorization: 'Bearer x',
      });
      let status;
      let krop = '';
      r.on('response', (h) => { status = h[':status']; });
      r.setEncoding('utf8');
      r.on('data', (d) => { krop += d; });
      r.on('end', () => ok({ status, krop }));
      r.on('error', fejl);
      r.end(Buffer.alloc(STOERRELSE));
    });
    assert.equal(svar.status, 200);
    assert.equal(JSON.parse(svar.krop).tekst, 'Hej');
    assert.equal(modtaget, STOERRELSE);
  } finally {
    klient.close();
    server.close();
  }
});
