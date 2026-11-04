'use strict';
// Testbænk: belastning med mange samtidige brugere. Ingen rigtige kald til Google og ingen omkostning.
// Serverens rigtige handler, Gemini-kode (upload, genforsøg, sletning), referat-kode og PDF kører mod en
// falsk Google, der svarer langsomt og en del af tiden med 429 eller 503. Login er falsk.
// Klienterne kører i en separat proces, så hukommelsen, der måles, kun er serverens.
// Brug: node scripts/testbaenk/belastning.js [--lange 20] [--korte 20] [--mb 25] [--fart 1]
//   --fart 10 gør den falske Googles ventetider 10 gange kortere (til hurtige prøvekørsler).

const http2 = require('node:http2');
const { fork } = require('node:child_process');
const { Readable } = require('node:stream');
const { lavHandler } = require('../../server/src/handler.js');
const { lavGemini } = require('../../server/src/gemini.js');
const { lavReferat } = require('../../server/src/referat.js');
const { lavServer } = require('../../server/src/server.js');
const pdf = require('../../server/src/pdf.js');
const ordliste = require('../../server/src/ordliste.js');

const valg = (navn, standard) => {
  const i = process.argv.indexOf(`--${navn}`);
  return i > 0 ? Number(process.argv[i + 1]) : standard;
};
const LANGE = valg('lange', 20);
const KORTE = valg('korte', 20);
const MB = valg('mb', 25); // 45 minutter AAC 64 kbit/s ≈ 21 MB. 25 MB giver lidt luft.
const FART = valg('fart', 1);
const KORT_BYTES = 480 * 1024; // 1 minut AAC 64 kbit/s
const VAGT_MS = 20 * 60 * 1000; // Et svar, der ikke er kommet efter 20 minutter, regnes som hængende.

// ---------------------------------------------------------------------------------------------
// Klient: kører i sin egen proces og sender alle optagelser på én gang.

async function klient(port) {
  const STYKKE = Buffer.alloc(64 * 1024, 7);
  function lydStroem(bytes) {
    let tilbage = bytes;
    return new Readable({
      read() {
        if (tilbage <= 0) return this.push(null);
        const n = Math.min(tilbage, STYKKE.length);
        tilbage -= n;
        this.push(n === STYKKE.length ? STYKKE : STYKKE.subarray(0, n));
      },
    });
  }

  function send(nr, bytes, varighedSek) {
    const start = Date.now();
    return new Promise((ok) => {
      const session = http2.connect(`http://localhost:${port}`);
      session.on('error', () => {});
      const req = session.request({
        ':method': 'POST',
        ':path': '/transskriber',
        'content-type': 'audio/mp4',
        'content-length': String(bytes),
        authorization: 'Bearer falsk',
        'x-varighed': String(varighedSek),
        'x-titel': encodeURIComponent(`Belastning ${nr}`),
      });
      const vagt = setTimeout(() => { req.close(); ok({ nr, bytes, status: 'haenger', ms: Date.now() - start }); }, VAGT_MS);
      let status = 0;
      const dele = [];
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (d) => dele.push(d));
      req.on('end', () => {
        clearTimeout(vagt);
        session.close();
        let fejl = null;
        let pdfBytes = 0;
        try {
          const krop = JSON.parse(Buffer.concat(dele).toString('utf8'));
          fejl = krop.fejl || null;
          pdfBytes = krop.pdf ? Buffer.from(krop.pdf, 'base64').length : 0;
        } catch { fejl = 'ulaeseligt-svar'; }
        ok({ nr, bytes, status, fejl, pdfBytes, ms: Date.now() - start });
      });
      req.on('error', () => { clearTimeout(vagt); session.close(); ok({ nr, bytes, status: 'netvaerk', ms: Date.now() - start }); });
      lydStroem(bytes).pipe(req);
    });
  }

  const opgaver = [];
  for (let i = 0; i < LANGE; i++) opgaver.push(send(i, MB * 1024 * 1024, 2700));
  for (let i = 0; i < KORTE; i++) opgaver.push(send(LANGE + i, KORT_BYTES, 60));
  process.send({ resultater: await Promise.all(opgaver) });
}

// ---------------------------------------------------------------------------------------------
// Falsk Google: langsom, og en del af tiden 429 RESOURCE_EXHAUSTED eller 503.

const ORD = 'vi har set på fundamentet ved gavlen og der mangler armering i hjørnet entreprenøren skal udbedre det inden fredag'.split(' ');
function falskTekst(ord) {
  const ud = [];
  for (let i = 0; i < ord; i++) ud.push(ORD[i % ORD.length]);
  return `${ud.join(' ')}.`;
}

function lavFalskGoogle(taeller) {
  const filer = new Map(); // navn → { bytes, vedvarende }
  const pause = (ms, signal) => new Promise((ok, fejl) => {
    const t = setTimeout(ok, ms / FART);
    signal?.addEventListener('abort', () => { clearTimeout(t); fejl(signal.reason); }, { once: true });
  });
  const tilfaeldig = (fra, til) => fra + Math.random() * (til - fra);
  const svar = (status, krop, headers = {}) => new Response(JSON.stringify(krop), { status, headers });
  const kvote = () => svar(429, {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'falsk',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${Math.round(3 / FART)}s` }],
    },
  });

  return async function hent(url, v = {}) {
    const s = String(url);
    if (s.endsWith('/upload/v1beta/files')) {
      taeller.uploadStart++;
      await pause(tilfaeldig(100, 400), v.signal);
      if (Math.random() < 0.1) { taeller.svar429++; return kvote(); }
      const navn = JSON.parse(v.body).file.name;
      filer.set(navn, { bytes: 0, vedvarende: false });
      return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': `https://upload.falsk/${navn}` } });
    }
    if (s.startsWith('https://upload.falsk/')) {
      const navn = s.slice('https://upload.falsk/'.length);
      let bytes = 0;
      for await (const d of v.body) bytes += d.length;
      // Hver tiende fil får vedvarende 429, så det ses, at brugeren får en forståelig fejl.
      const fil = { bytes, vedvarende: Math.random() < 0.1 };
      if (fil.vedvarende) taeller.vedvarende429++;
      filer.set(navn, fil);
      taeller.uploadBytes += bytes;
      return svar(200, { file: { name: navn, uri: `https://generativelanguage.googleapis.com/v1beta/${navn}` } });
    }
    if (s.endsWith('/v1beta/interactions')) {
      const krop = JSON.parse(v.body);
      if (krop.input[0].type === 'audio') {
        taeller.transskription++;
        const fil = filer.get(krop.input[0].uri.split('/v1beta/')[1]) || { bytes: 0 };
        const lang = fil.bytes > 5 * 1024 * 1024;
        if (fil.vedvarende || Math.random() < 0.25) {
          await pause(tilfaeldig(200, 800), v.signal);
          taeller.svar429++;
          return kvote();
        }
        await pause(lang ? tilfaeldig(15000, 30000) : tilfaeldig(5000, 10000), v.signal);
        const tekst = falskTekst(lang ? 6000 : 150);
        return svar(200, { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: tekst }] }] });
      }
      taeller.referat++;
      await pause(tilfaeldig(2000, 8000), v.signal);
      if (Math.random() < 0.15) { taeller.svar503++; return svar(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'falsk' } }); }
      const referat = {
        titel: 'Belastning',
        type: 'byggenotat',
        opsummering: 'Fundamentet ved gavlen mangler armering.',
        hovedpunkter: Array.from({ length: 20 }, (_, i) => `Punkt ${i + 1} om fundamentet`),
        fejlOgMangler: ['Der mangler armering i hjørnet.'],
        opgaver: [{ hvem: 'Entreprenøren', hvad: 'udbedre armering', hvornaar: 'fredag' }],
        maalOgMaengder: [],
        aabneSpoergsmaal: [],
      };
      return svar(200, { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(referat) }] }] });
    }
    if (v.method === 'DELETE') { taeller.sletninger++; return svar(200, {}); }
    throw new Error(`uventet kald ${s}`);
  };
}

// ---------------------------------------------------------------------------------------------
// Server: rigtig handler som på Cloud Run (HTTP/2 uden kryptering).

async function server() {
  const taeller = { vedvarende429: 0, uploadStart: 0, uploadBytes: 0, transskription: 0, referat: 0, svar429: 0, svar503: 0, sletninger: 0 };
  const haendelser = {};
  const genforsoeg = { ventMs: 0 };
  const fejl = {};
  const log = (o) => {
    haendelser[o.haendelse] = (haendelser[o.haendelse] || 0) + 1;
    if (o.haendelse === 'gemini-genforsoeg') genforsoeg.ventMs += o.ventMs;
    if (o.haendelse === 'gemini-fejl') {
      const k = [o.kode, o.trin, o.googleStatus, o.googleKode, o.fejltype].filter(Boolean).join(' ');
      fejl[k] = (fejl[k] || 0) + 1;
    }
  };
  const hent = lavFalskGoogle(taeller);
  const gemini = lavGemini({
    noegle: 'falsk', model: 'gemini-3.5-transcribe', sprog: 'da-DK', tilstand: 'smart', ordliste,
    timeoutMs: 840000, hent, hentLangsom: hent, log, advar: () => {},
  });
  const referat = lavReferat({ noegle: 'falsk', model: 'gemini-3.8-flash', timeoutMs: 50000, hent, log });
  const handler = lavHandler({
    konfig: { tilladtOprindelse: 'https://x', maxBytes: 157286400 },
    tjekAdgang: async () => ({ ok: true }),
    gemini, referat, pdf, log,
  });

  const srv = lavServer(handler);
  await new Promise((ok) => srv.listen(0, ok));
  global.gc?.();
  const foer = process.memoryUsage();
  let maksRss = foer.rss;
  let maksHeap = foer.heapUsed;
  let maksExternal = foer.external + foer.arrayBuffers;
  const maaling = setInterval(() => {
    const m = process.memoryUsage();
    maksRss = Math.max(maksRss, m.rss);
    maksHeap = Math.max(maksHeap, m.heapUsed);
    maksExternal = Math.max(maksExternal, m.external + m.arrayBuffers);
  }, 50);

  const start = Date.now();
  const barn = fork(__filename, ['--klient', String(srv.address().port), ...process.argv.slice(2)]);
  const { resultater } = await new Promise((ok) => barn.once('message', ok));
  clearInterval(maaling);
  const samletMs = Date.now() - start;
  srv.close();

  const mb = (b) => Math.round(b / 1024 / 1024);
  const s = (ms) => Math.round(ms / 100) / 10;
  const opdel = (liste) => {
    const tider = liste.map((r) => r.ms).sort((a, b) => a - b);
    const status = {};
    for (const r of liste) {
      const k = `${r.status}${r.fejl ? ` ${r.fejl}` : ''}`;
      status[k] = (status[k] || 0) + 1;
    }
    return {
      antal: liste.length,
      status,
      svartidS: tider.length ? { min: s(tider[0]), median: s(tider[Math.floor(tider.length / 2)]), maks: s(tider[tider.length - 1]) } : null,
    };
  };
  const rapport = {
    indstillinger: { lange: LANGE, korte: KORTE, mbPrLang: MB, fart: FART },
    samletS: s(samletMs),
    hukommelseMB: { rssFoer: mb(foer.rss), rssMaks: mb(maksRss), heapMaks: mb(maksHeap), bufferMaks: mb(maksExternal) },
    lange: opdel(resultater.filter((r) => r.nr < LANGE)),
    korte: opdel(resultater.filter((r) => r.nr >= LANGE)),
    haengende: resultater.filter((r) => r.status === 'haenger').length,
    falskGoogle: { ...taeller, uploadMB: mb(taeller.uploadBytes) },
    logHaendelser: haendelser,
    geminiFejl: fejl,
    genforsoegVentetidSamletS: s(genforsoeg.ventMs),
  };
  console.log(JSON.stringify(rapport, null, 2));
  process.exit(0);
}

if (process.argv[2] === '--klient') klient(Number(process.argv[3]));
else server();
