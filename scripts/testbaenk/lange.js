'use strict';
// Testbænk for lange optagelser: klipper lange filer i bidder med appens egen kode (app/js/opdeling/), sender hver
// bid gennem serverens rigtige handler med rigtig Gemini og samler dem i /referat, som appen gør.
// Måler tid, pris, ordfejl, tal og overgangene mellem bidderne (ord tabt eller gentaget).
// Testlyd: FLEURS (CC BY 4.0) og syntetisk tale fra manuskripter.js, sat sammen til 1, 2 og 3 timer og to filer.
// Ingen rigtige optagelser. KOSTER PENGE: spørg brugeren først. Stopper selv ved 20 kr. for denne test.
// Brug: node --env-file=.env scripts/testbaenk/lange.js [--lav] [--kun 1t,2t,3t,to,kontrol] [--navn lange-1]
//       --lav laver kun testlyden (gratis). --falsk prøver forløbet med falsk Gemini (gratis, måler intet).

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');
const { generateKeyPairSync, createSign, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { lavHandler } = require('../../server/src/handler.js');
const { lavAdgangsTjek } = require('../../server/src/adgang.js');
const { lavGemini, hentUdenGraense } = require('../../server/src/gemini.js');
const { lavReferat } = require('../../server/src/referat.js');
const pdf = require('../../server/src/pdf.js');
const ordliste = require('../../server/src/ordliste.js');
const manuskripter = require('./manuskripter.js');
const { wer, talNoejagtighed, kanonisk, overgang } = require('./maal.js');
const { tilfoejForbrug, forbrugIalt, KR_PR_USD } = require('./forbrug.js');

const ROD = path.resolve(__dirname, '..', '..');
const FFMPEG = path.join(ROD, '.vaerktoej/ffmpeg/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe');
const UD = path.join(ROD, 'testlyd/baenk/lange');
const TENANT = '00000000-0000-0000-0000-00000000000a';
const CLIENT = '00000000-0000-0000-0000-00000000000c';
const GRAENSE_KR = 20;
// Priser pr. mio. tokens til og med 31.12.2026 (ai.google.dev/gemini-api/docs/pricing).
const PRIS = { flash: { ind: 0.75, ud: 3.75 }, transcribe: { ind: 2, ud: 12 } };
const BIDDER = { bidMs: 30 * 60 * 1000, overlapMs: 30 * 1000, delFraMs: 35 * 60 * 1000 };
const RATE = 16000;
const valg = (navn, standard) => {
  const i = process.argv.indexOf(`--${navn}`);
  return i > 0 ? process.argv[i + 1] : standard;
};

// Testlyd

/** Bidder af tale med facit: FLEURS (én optagelse pr. sætning) og de syntetiske manuskripter. */
function talePulje() {
  const fleurs = new Map();
  for (const l of fs.readFileSync(path.join(ROD, 'testlyd/fleurs/dev.tsv'), 'utf8').trim().split('\n')) {
    const [id, fil, raa] = l.split('\t');
    if (!fleurs.has(id)) fleurs.set(id, { wav: path.join(ROD, 'testlyd/fleurs/lyd/dev', fil), facit: raa });
  }
  const syn = manuskripter
    .map((m) => ({ wav: path.join(ROD, 'testlyd/syntetisk', `${m.id}.wav`), facit: m.tekst.split('\n').map((x) => x.replace(/^[A-ZÆØÅ][a-zæøå]+: /, '')).join(' ').replace(/\[lang pause\]/g, ' ').replace(/\s+/g, ' ').trim() }))
    .filter((s) => fs.existsSync(s.wav));
  return [...fleurs.values(), ...syn];
}

/** Bland deterministisk, så samme navn altid giver samme fil. */
function bland(liste, frø) {
  const ud = [...liste];
  let x = frø;
  for (let i = ud.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const j = x % (i + 1);
    [ud[i], ud[j]] = [ud[j], ud[i]];
  }
  return ud;
}

const raaCache = new Map();
function raa(wav) {
  if (!raaCache.has(wav)) raaCache.set(wav, execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', wav, '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], { maxBuffer: 1 << 28 }));
  return raaCache.get(wav);
}

/** En fil på ca. minutter min. tale med 0,6 s pause mellem bidderne, kodet som telefonen (AAC 128 kbit/s) eller mp3. */
function lavFil(navn, minutter, frø, format = 'm4a') {
  const ud = path.join(UD, `${navn}.${format}`);
  const facitFil = path.join(UD, `${navn}.json`);
  if (fs.existsSync(ud) && fs.existsSync(facitFil)) return { fil: ud, ...JSON.parse(fs.readFileSync(facitFil, 'utf8')) };
  fs.mkdirSync(UD, { recursive: true });
  const raaFil = path.join(UD, `${navn}.raw`);
  const strøm = fs.openSync(raaFil, 'w');
  const pause = Buffer.alloc(Math.round(0.6 * RATE) * 2);
  const facit = [];
  let sek = 0;
  for (let runde = 0; sek < minutter * 60; runde++) {
    for (const s of bland(talePulje(), frø + runde)) {
      if (sek >= minutter * 60) break;
      const b = raa(s.wav);
      fs.writeSync(strøm, b);
      fs.writeSync(strøm, pause);
      sek += (b.length + pause.length) / 2 / RATE;
      facit.push(s.facit);
    }
  }
  fs.closeSync(strøm);
  const kode = format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '128k'] : ['-c:a', 'aac', '-b:a', '128k'];
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', raaFil, '-ar', '48000', ...kode, ud]);
  fs.unlinkSync(raaFil);
  const info = { sek: Math.round(sek), facit: facit.join(' ') };
  fs.writeFileSync(facitFil, JSON.stringify(info));
  return { fil: ud, ...info };
}

const KOERSLER = {
  '1t': () => ({ dele: [lavFil('lang-1t', 60, 11)] }),
  '2t': () => ({ dele: [lavFil('lang-2t', 120, 22)] }),
  '3t': () => ({ dele: [lavFil('lang-3t', 180, 33)] }),
  to: () => ({ dele: [lavFil('to-a', 45, 44), lavFil('to-b', 45, 55, 'mp3')], filnavne: ['Møde_del1.m4a', 'Møde_del2.mp3'] }),
  kontrol: () => ({ dele: [lavFil('lang-3t', 180, 33)], helt: true }),
};

// Serveren, som på Cloud Run, med falsk login og optælling af tokens pr. model

const kontekst = new AsyncLocalStorage();
function maaltHent(hent) {
  return async (url, v) => {
    const s = await hent(url, v);
    const maal = kontekst.getStore();
    if (!maal || !s.json) return s;
    const json = s.json.bind(s);
    s.json = async () => {
      const j = await json();
      const u = j?.usage;
      if (u) {
        const krop = String(v?.body ?? '');
        const model = krop.includes('transcribe') ? 'transcribe' : 'flash';
        maal[model].ind += u.total_input_tokens ?? 0;
        maal[model].ud += (u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0);
      }
      if (!s.ok) (maal.fejl ??= []).push(`${s.status} ${j?.error?.status ?? j?.error?.code ?? ''}`);
      return j;
    };
    return s;
  };
}

async function startServer() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const nu = Math.floor(Date.now() / 1000);
  const krop = `${b64({ alg: 'RS256', kid })}.${b64({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, scp: 'access_as_user', acct: 0, exp: nu + 6 * 3600, nbf: nu - 60 })}`;
  const bevis = `${krop}.${createSign('RSA-SHA256').update(krop).sign(privateKey).toString('base64url')}`;
  const noegle = process.env.GEMINI_API_KEY;
  const handler = lavHandler({
    konfig: { tilladtOprindelse: 'http://localhost', maxBytes: 524288000 },
    tjekAdgang: lavAdgangsTjek({ tenantId: TENANT, clientId: CLIENT, hent: async () => new Response(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid }] })) }),
    gemini: process.argv.includes('--falsk') ? falskGemini() : lavGemini({
      noegle, model: 'gemini-3.5-transcribe', flashModel: 'gemini-3.8-flash', foerst: 'flash', transcribeMaksSek: 400,
      sprog: 'da-DK', tilstand: 'verbatim', ordliste, timeoutMs: 840000,
      hent: maaltHent((...a) => fetch(...a)), hentLangsom: maaltHent(hentUdenGraense),
    }),
    referat: process.argv.includes('--falsk') ? { lav: async ({ titel }) => ({ titel, type: 'moede', kort: false, opsummering: 'Falsk.', hovedpunkter: [], beslutninger: [], opgaver: [], fejlOgMangler: [], maalOgMaengder: [], huskeliste: [], aabneSpoergsmaal: [], renTekst: '' }) } : lavReferat({ noegle, model: 'gemini-3.8-flash', timeoutMs: 50000, hent: maaltHent(hentUdenGraense) }),
    pdf,
    log: () => {},
  });
  const server = http.createServer((req, res) => kontekst.run(maalPr.get(req.headers['x-testid']), () => handler(req, res)));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { server, bevis, adresse: `http://127.0.0.1:${server.address().port}` };
}
/** Kun til --falsk: læser lyden og svarer med bytes og en tid, så klipning og samling kan prøves uden at betale. */
function falskGemini() {
  return {
    async transskriber(strom, { bytes }) {
      for await (const _ of strom);
      return { tekst: `[00:00] Falsk tekst med ${bytes} bytes.` };
    },
  };
}
const maalPr = new Map();
const nytMaal = () => ({ flash: { ind: 0, ud: 0 }, transcribe: { ind: 0, ud: 0 } });
const usd = (m) => Object.entries(PRIS).reduce((s, [k, p]) => s + (m[k].ind * p.ind + m[k].ud * p.ud) / 1e6, 0);

// Kørslen

function filKilde(fil) {
  const fd = fs.openSync(fil, 'r');
  const stoerrelse = fs.fstatSync(fd).size;
  const laes = async (fra, til) => {
    const b = Buffer.alloc(Math.max(0, Math.min(stoerrelse, til) - Math.max(0, fra)));
    fs.readSync(fd, b, 0, b.length, Math.max(0, fra));
    return new Uint8Array(b.buffer, b.byteOffset, b.length);
  };
  return { stoerrelse, laes, udsnit: async (fra, til) => new Blob([await laes(fra, til)]), luk: () => fs.closeSync(fd) };
}

async function post(miljoe, sti, { headers, body, testid }) {
  const s = await fetch(`${miljoe.adresse}${sti}`, {
    method: 'POST', headers: { authorization: `Bearer ${miljoe.bevis}`, 'x-testid': testid, ...headers }, body,
    signal: AbortSignal.timeout(16 * 60 * 1000),
  });
  return { status: s.status, svar: await s.json().catch(() => null) };
}

async function koer(miljoe, navn, opsaetning) {
  const opdeling = await import('../../app/js/opdeling/index.js');
  const maal = nytMaal();
  maalPr.set(navn, maal);
  const start = Date.now();
  const r = { navn, sek: opsaetning.dele.reduce((s, d) => s + d.sek, 0), bidder: [] };
  const facit = opsaetning.dele.map((d) => d.facit).join(' ');
  const mime = (fil) => (fil.endsWith('.mp3') ? 'audio/mpeg' : 'audio/mp4');

  if (opsaetning.helt) {
    // Kontrol: hele filen i ét kald, som appen gjorde før (uden x-varighed, da den er over 2½ time).
    const d = opsaetning.dele[0];
    const { status, svar } = await post(miljoe, '/transskriber', { testid: navn, headers: { 'content-type': mime(d.fil) }, body: fs.readFileSync(d.fil) });
    Object.assign(r, { status, fejl: svar?.fejl, tekst: svar?.tekst, referat: svar?.referat });
  } else {
    const delListe = [];
    const opgaver = [];
    for (const [i, d] of opsaetning.dele.entries()) {
      const kilde = filKilde(d.fil);
      const indeks = await opdeling.lavIndeks(kilde, mime(d.fil));
      if (!indeks) throw new Error(`${d.fil} kan ikke klippes`);
      const plan = opdeling.planlaegBidder(indeks.varighedMs, indeks.enheder, BIDDER);
      const del = { ...(opsaetning.filnavne ? { filnavn: opsaetning.filnavne[i] } : {}), afbrudt: false, varighedSek: indeks.varighedMs / 1000, bidder: [] };
      delListe.push(del);
      for (const b of plan) opgaver.push({ kilde, indeks, b, del, mime: mime(d.fil) });
    }
    const ventende = [...opgaver];
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (ventende.length) {
        const { kilde, indeks, b, del, mime: m } = ventende.shift();
        const t0 = Date.now();
        const lyd = await opdeling.lavBid(kilde, indeks, b);
        const sek = (b.slutMs - b.startMs) / 1000;
        const { status, svar } = await post(miljoe, '/transskriber', {
          testid: navn, body: lyd,
          headers: { 'content-type': m, 'x-kun-tekst': '1', 'x-afsnit': '1', 'x-varighed': String(Math.round(sek)) },
        });
        r.bidder.push({ nr: b.nr, sek, bytes: lyd.size, status, ms: Date.now() - t0, fejl: svar?.fejl });
        del.bidder[b.nr] = status === 200
          ? { startSek: b.startMs / 1000, overlapSek: b.overlapMs / 1000, varighedSek: sek, tekst: svar.tekst || '', ...(svar.afsnit ? { afsnit: svar.afsnit } : {}) }
          : { startSek: b.startMs / 1000, overlapSek: b.overlapMs / 1000, varighedSek: sek, tekst: '', mangler: true };
      }
    }));
    for (const kilde of new Set(opgaver.map((o) => o.kilde))) kilde.luk();
    const t0 = Date.now();
    const { status, svar } = await post(miljoe, '/referat', {
      testid: navn, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dele: delListe, titel: `Testbænk ${navn}`, varighedSek: Math.round(r.sek), optaget: Date.now() }),
    });
    Object.assign(r, { status, referatMs: Date.now() - t0, fejl: svar?.fejl, tekst: svar?.tekst, referat: svar?.referat, huller: svar?.huller ?? 0 });
    // Overgangene: hvor hver bid (efter den første) begynder i den samlede tekst.
    r.overgange = maalOvergange(facit, r.tekst ?? '', delListe);
    if (svar?.docx) fs.writeFileSync(path.join(UD, `${navn}.docx`), Buffer.from(svar.docx, 'base64'));
  }
  r.ms = Date.now() - start;
  r.usd = usd(maal);
  r.tokens = maal;
  if (r.tekst) r.wer = wer(facit, r.tekst);
  if (r.referat) r.tal = talNoejagtighed(r.referat, facit, []);
  delete r.tekst;
  if (!process.argv.includes('--falsk')) tilfoejForbrug({ hvad: `lange ${navn}`, usd: r.usd });
  return r;
}

// Overlappet er ca. 75 ord. Ord tabt eller gentaget tælles inden for 60 ord fra den næste bids start.
const VINDUE = { vindue: 120, kerne: 60 };

/**
 * For hver overgang: find den næste bids første ord i den samlede tekst og mål tabte og gentagne ord.
 * Til sammenligning det samme midt mellem to overgange (kontrol), så almindelige fejl i transskriptionen kan skelnes.
 */
function maalOvergange(facit, samlet, dele) {
  const ord = kanonisk(samlet);
  const ud = [];
  for (const del of dele) {
    for (const b of del.bidder.slice(1)) {
      if (b.mangler) continue;
      const pos = findRaekke(ord, kanonisk(b.tekst).slice(0, 8));
      ud.push({ startSek: b.startSek, pos, ...(pos < 0 ? { fundet: false } : overgang(facit, samlet, pos, VINDUE)) });
    }
  }
  const fundne = ud.filter((x) => x.pos >= 0).map((x) => x.pos);
  const midter = [0, ...fundne].map((p, i, a) => Math.round((p + (a[i + 1] ?? ord.length)) / 2));
  const kontrol = midter.map((p) => overgang(facit, samlet, p, VINDUE)).filter((x) => x.fundet);
  return { overgange: ud, kontrol: { antal: kontrol.length, tabt: kontrol.reduce((s, x) => s + x.tabt, 0), gentaget: kontrol.reduce((s, x) => s + x.gentaget, 0) } };
}

function findRaekke(ord, raekke) {
  if (!raekke.length) return -1;
  for (let i = 0; i + raekke.length <= ord.length; i++) if (raekke.every((w, k) => ord[i + k] === w)) return i;
  return -1;
}

(async () => {
  const kun = valg('kun', 'to,1t,2t,3t,kontrol').split(',');
  if (process.argv.includes('--lav')) {
    for (const k of kun) for (const d of KOERSLER[k]().dele) console.log(path.relative(ROD, d.fil), `${(d.sek / 60).toFixed(1)} min.`);
    return;
  }
  if (!process.env.GEMINI_API_KEY && !process.argv.includes('--falsk')) throw new Error('GEMINI_API_KEY mangler (node --env-file=.env …)');
  const navn = valg('navn', `lange-${new Date().toISOString().slice(0, 10)}`);
  const foer = forbrugIalt();
  const miljoe = await startServer();
  const resultater = [];
  for (const k of kun) {
    if ((forbrugIalt() - foer) * KR_PR_USD > GRAENSE_KR) {
      console.error(`Grænsen på ${GRAENSE_KR} kr. er nået. Stopper før ${k}.`);
      break;
    }
    const r = await koer(miljoe, k, KOERSLER[k]());
    resultater.push(r);
    const o = r.overgange?.overgange ?? [];
    const kt = r.overgange?.kontrol;
    console.log(`${k.padEnd(8)} ${(r.sek / 60).toFixed(0).padStart(4)} min  ${String(r.status).padEnd(4)} ${(r.ms / 1000).toFixed(0).padStart(5)} s  `
      + `${r.usd.toFixed(3)} USD  WER ${r.wer ? (r.wer.rate * 100).toFixed(1) : '-'} %  tal ${r.tal ? `${r.tal.korrekte}/${r.tal.uklart}/${r.tal.forkerte}` : '-'}  `
      + `overgange ${o.length}: tabt ${o.reduce((s, x) => s + (x.tabt ?? 0), 0)}, gentaget ${o.reduce((s, x) => s + (x.gentaget ?? 0), 0)}, ikke fundet ${o.filter((x) => !x.fundet).length}`
      + `${kt ? `  (kontrol ${kt.antal} steder: tabt ${kt.tabt}, gentaget ${kt.gentaget})` : ''}${r.fejl ? `  fejl ${r.fejl}` : ''}`);
    fs.writeFileSync(path.join(UD, `${navn}.json`), JSON.stringify({ navn, tid: new Date().toISOString(), resultater }, null, 1));
  }
  miljoe.server.close();
  console.log(`Brugt i denne test: ${((forbrugIalt() - foer) * KR_PR_USD).toFixed(2)} kr. Resultat: ${path.relative(ROD, path.join(UD, `${navn}.json`))}`);
})().catch((e) => { console.error('Fejl:', e.message); process.exit(1); });
