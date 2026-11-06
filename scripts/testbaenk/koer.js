'use strict';
// Testbænk: kører hele kæden (adgang → format → transskription → referat → kontrol af tal → PDF) gennem
// serverens rigtige handler med rigtig Gemini på alle filer i testlyd/baenk/liste.json.
// Login er falsk (egen nøgle), alt andet er som på Cloud Run.
// Brug: node --env-file=.env scripts/testbaenk/koer.js [--filter tekst] [--samtidige 4] [--navn koersel-1]
// Stopper selv, hvis forbruget når grænsen i forbrug.js. Skriver resultat i testlyd/baenk/ og en rapport i docs/test-resultater.md.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');
const { generateKeyPairSync, createSign, randomUUID } = require('node:crypto');
const { lavHandler } = require('../../server/src/handler.js');
const { lavAdgangsTjek } = require('../../server/src/adgang.js');
const { lavGemini, hentUdenGraense } = require('../../server/src/gemini.js');
const { lavReferat } = require('../../server/src/referat.js');
const pdf = require('../../server/src/pdf.js');
const ordliste = require('../../server/src/ordliste.js');
const { wer, talNoejagtighed, nyeEgennavne, pris } = require('./maal.js');
const { tilfoejForbrug, forbrugIalt, GRAENSE_USD, KR_PR_USD } = require('./forbrug.js');

const ROD = path.resolve(__dirname, '..', '..');
const valg = (navn, standard) => {
  const i = process.argv.indexOf(`--${navn}`);
  return i > 0 ? process.argv[i + 1] : standard;
};
const TENANT = '00000000-0000-0000-0000-00000000000a';
const CLIENT = '00000000-0000-0000-0000-00000000000c';
const MIME = { m4a: 'audio/mp4', webm: 'audio/webm', mp3: 'audio/mpeg', wav: 'audio/wav' };

function lavBevis() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const nu = Math.floor(Date.now() / 1000);
  const krop = `${b64({ alg: 'RS256', kid })}.${b64({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, scp: 'access_as_user', acct: 0, exp: nu + 6 * 3600, nbf: nu - 60 })}`;
  return { jwk, bevis: `${krop}.${createSign('RSA-SHA256').update(krop).sign(privateKey).toString('base64url')}` };
}

/** Tæller Googles tokens pr. fil, også når flere filer kører samtidig. */
const kontekst = new AsyncLocalStorage();
function maaltHent(hent) {
  return async (url, v) => {
    const fil = kontekst.getStore();
    let s;
    try {
      s = await hent(url, v);
    } catch (e) {
      // Netværksfejl gemmes med årsag, så de kan skelnes fra fejl hos Google.
      if (fil) (fil.googleFejl ??= []).push(`kast ${e.name}: ${e.message} ${e.cause?.code ?? e.code ?? ''} ${e.cause?.message ?? ''}`.trim());
      throw e;
    }
    if (!fil || !s.json) return s;
    // Googles svar ved fejl gemmes i resultatet (kun status og fejlkode, ingen indhold), så årsagen kan ses.
    if (!s.ok) {
      // Svaret fra hentUdenGraense har ingen clone(). Kroppen læses én gang og gives videre uændret.
      const krop = await s.json().catch(() => null);
      s.json = async () => krop;
      const kode = krop?.error?.status ?? krop?.error?.code ?? '';
      const sti = String(url).split('?')[0].replace(/.*\/v1beta\//, '').replace(/files\/[\w-]+/, 'files/ID');
      (fil.googleFejl ??= []).push(`${s.status} ${kode} ${sti}${/per day/i.test(krop?.error?.message ?? '') ? ' (dagsgrænse)' : ''}`);
    }
    return new Proxy(s, {
      get(mål, navn) {
        if (navn !== 'json') {
          const x = Reflect.get(mål, navn, mål);
          return typeof x === 'function' ? x.bind(mål) : x;
        }
        return async () => {
          const j = await mål.json();
          const u = j?.usage ?? j?.usageMetadata;
          if (u) {
            const referat = String(v?.body ?? '').includes('"response_format"');
            const ind = u.total_input_tokens ?? u.promptTokenCount ?? 0;
            const ud = (u.total_output_tokens ?? u.candidatesTokenCount ?? 0) + (u.total_thought_tokens ?? u.thoughtsTokenCount ?? 0);
            if (referat) fil.tokens.referat = { ind: fil.tokens.referat.ind + ind, ud: fil.tokens.referat.ud + ud };
            else fil.tokens.tekst += ud;
          }
          return j;
        };
      },
    });
  };
}

async function startServer(logge) {
  const { jwk, bevis } = lavBevis();
  const noegle = process.env.GEMINI_API_KEY;
  const handler = lavHandler({
    konfig: { tilladtOprindelse: 'http://localhost', maxBytes: 157286400 },
    tjekAdgang: lavAdgangsTjek({ tenantId: TENANT, clientId: CLIENT, hent: async () => new Response(JSON.stringify({ keys: [jwk] })) }),
    gemini: lavGemini({
      noegle, model: 'gemini-3.5-transcribe', sprog: 'da-DK', tilstand: 'verbatim', ordliste, timeoutMs: 840000,
      hent: maaltHent((...a) => fetch(...a)), hentLangsom: maaltHent(hentUdenGraense),
      advar: (besked) => logge.push({ haendelse: 'advarsel', besked }),
    }),
    referat: lavReferat({ noegle, model: 'gemini-3.8-flash', timeoutMs: 50000, hent: maaltHent(hentUdenGraense) }),
    pdf,
    log: (l) => logge.push(l),
  });
  const filer = new Map();
  const server = http.createServer((req, res) => {
    const fil = filer.get(req.headers['x-testfil']) ?? { tokens: { tekst: 0, referat: { ind: 0, ud: 0 } } };
    kontekst.run(fil, () => handler(req, res));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { server, bevis, filer, adresse: `http://127.0.0.1:${server.address().port}` };
}

async function koerFil(miljoe, f) {
  const data = fs.readFileSync(path.join(ROD, f.fil));
  const maal = { tokens: { tekst: 0, referat: { ind: 0, ud: 0 } } };
  miljoe.filer.set(f.fil, maal);
  const start = Date.now();
  let status = 0;
  let svar = null;
  try {
    const s = await fetch(`${miljoe.adresse}/transskriber`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${miljoe.bevis}`, 'content-type': MIME[f.format], 'x-testfil': f.fil,
        'x-varighed': String(Math.round(f.sek || 0)), 'x-optaget': String(Date.now()),
      },
      body: data,
      signal: AbortSignal.timeout(16 * 60 * 1000),
    });
    status = s.status;
    svar = await s.json().catch(() => null);
  } catch (e) {
    svar = { fejl: `klient: ${e.name}` };
  }
  const ms = Date.now() - start;
  const usd = pris({ sek: status === 200 || status === 502 ? f.sek : 0, tekstTokens: maal.tokens.tekst, referat: maal.tokens.referat });
  tilfoejForbrug({ hvad: `baenk ${f.fil}`, usd });
  const r = { fil: f.fil, kilde: f.kilde, id: f.id, forhold: f.forhold, format: f.format, sek: f.sek, status, ms, usd, fejl: svar?.fejl, googleFejl: maal.googleFejl };
  if (svar?.tekst && f.facit) r.wer = wer(f.facit, svar.tekst);
  if (svar?.referat && f.facit) {
    r.tal = talNoejagtighed(svar.referat, f.facit, f.forkerte);
    r.nyeNavne = nyeEgennavne(svar.referat, f.facit);
  }
  if (svar?.type) r.type = { valgt: svar.type, forventet: f.type };
  if (svar?.pdf) r.pdfOk = Buffer.from(svar.pdf, 'base64').subarray(0, 4).toString() === '%PDF';
  r.tekst = svar?.tekst;
  r.referat = svar?.referat;
  return r;
}

/** For stor fil: serveren skal svare 413 uden at læse lyden. Koster intet. */
function forStor(miljoe) {
  return new Promise((ok) => {
    const req = http.request(`${miljoe.adresse}/transskriber`, {
      method: 'POST',
      headers: { authorization: `Bearer ${miljoe.bevis}`, 'content-type': 'audio/mp4', 'content-length': String(160 * 1024 * 1024) },
    }, (res) => {
      ok({ fil: '(160 MB, kun header)', kilde: 'fejl', id: 'for-stor', forhold: 'fejl', format: 'm4a', status: res.statusCode, ms: 0, usd: 0 });
      req.destroy();
    });
    req.on('error', () => {});
    req.flushHeaders();
  });
}

function estimat(liste) {
  return liste.reduce((s, f) => s + pris({ sek: f.sek || 0, tekstTokens: ((f.sek || 0) / 60) * 175 }) + (f.facit === null ? 0 : 0.004), 0);
}

(async () => {
  const filter = valg('filter', '');
  const samtidige = Number(valg('samtidige', 4));
  const navn = valg('navn', `koersel-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`);
  const liste = JSON.parse(fs.readFileSync(path.join(ROD, 'testlyd/baenk/liste.json'), 'utf8')).filter((f) => f.fil.includes(filter));
  const forventet = estimat(liste);
  const brugt = forbrugIalt();
  console.log(`${liste.length} filer, ${(liste.reduce((s, f) => s + (f.sek || 0), 0) / 60).toFixed(1)} min. Forventet ${forventet.toFixed(3)} USD (${(forventet * KR_PR_USD).toFixed(1)} kr.). Brugt indtil nu ${brugt.toFixed(3)} USD. Grænse ${GRAENSE_USD.toFixed(2)} USD.`);
  if (brugt + forventet > GRAENSE_USD) {
    console.error('Kørslen ville gå over budgetgrænsen. Stopper uden at køre.');
    process.exit(2);
  }
  const logge = [];
  const miljoe = await startServer(logge);
  const resultater = [];
  const koe = [...liste].sort((a, b) => (b.sek || 0) - (a.sek || 0));
  let stop = false;
  await Promise.all(Array.from({ length: samtidige }, async () => {
    while (koe.length && !stop) {
      const f = koe.shift();
      const r = await koerFil(miljoe, f);
      resultater.push(r);
      console.log(`${String(r.status).padEnd(4)} ${(r.ms / 1000).toFixed(1).padStart(6)} s  ${r.wer ? `WER ${(r.wer.rate * 100).toFixed(1)}%` : ''.padEnd(9)}  ${r.tal ? `tal ${r.tal.korrekte}/${r.tal.uklart}/${r.tal.forkerte}` : ''}  ${f.fil}`);
      if (forbrugIalt() > GRAENSE_USD) {
        stop = true;
        console.error('Budgetgrænsen er nået. Stopper.');
      }
    }
  }));
  if (!filter || 'fejl'.includes(filter)) resultater.push(await forStor(miljoe));
  miljoe.server.close();
  const ud = path.join(ROD, `testlyd/baenk/${navn}.json`);
  fs.writeFileSync(ud, JSON.stringify({ navn, tid: new Date().toISOString(), resultater, logge }, null, 1));
  console.log(`Resultat: ${path.relative(ROD, ud)}. Forbrug i alt ${forbrugIalt().toFixed(3)} USD (${(forbrugIalt() * KR_PR_USD).toFixed(1)} kr.).`);
})().catch((e) => { console.error('Fejl:', e.message); process.exit(1); });
