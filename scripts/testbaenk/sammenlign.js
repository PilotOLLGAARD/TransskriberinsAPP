'use strict';
// Sammenligner Gemini 3.5 Transcribe og Gemini 3.8 Flash som transskribent på samme filer.
// Hver fil uploades én gang og transskriberes af begge fra samme fil. Derefter referat af begge tekster.
// Måler ordfejlrate, tal mod facit, nye egennavne, tid og pris. Kun selvlavet lyd og FLEURS.
// Brug: node --env-file=.env scripts/testbaenk/sammenlign.js [--navn sammenligning-1] [--kun-flash fil]

const fs = require('node:fs');
const path = require('node:path');
const { lavReferat } = require('../../server/src/referat.js');
const ordliste = require('../../server/src/ordliste.js');
const { wer, talNoejagtighed, nyeEgennavne } = require('./maal.js');
const { tilfoejForbrug, forbrugIalt, KR_PR_USD } = require('./forbrug.js');

const ROD = path.resolve(__dirname, '..', '..');
const BASE = 'https://generativelanguage.googleapis.com';
const H = { 'x-goog-api-key': process.env.GEMINI_API_KEY };
const GRAENSE_USD = 10 / KR_PR_USD; // Brugerens grænse for denne test: 10 kr.
const valg = (n, s) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : s; };

const FLASH_PROMPT = 'Transskriber lyden ordret på dansk. Skriv kun det, der bliver sagt, uden kommentarer, overskrifter, talernavne eller tidskoder. '
  + 'Skriv tal, som de bliver sagt. Skriv "[uklart]", hvor noget ikke kan høres. Opfind aldrig noget.'
  + (ordliste.length ? ` Fagord, der kan forekomme: ${ordliste.join(', ')}.` : '');
const PRIS = { transcribe: { ind: 2, ud: 12 }, flash: { ind: 0.75, ud: 3.75 } };

async function upload(fil) {
  const bytes = fs.statSync(fil).size;
  const mime = fil.endsWith('.webm') ? 'audio/webm' : 'audio/m4a';
  const s = await fetch(`${BASE}/upload/v1beta/files`, { method: 'POST', headers: { ...H, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(bytes), 'X-Goog-Upload-Header-Content-Type': mime, 'Content-Type': 'application/json' }, body: JSON.stringify({ file: { display_name: 'sammenligning' } }) });
  const r = await fetch(s.headers.get('x-goog-upload-url'), { method: 'POST', headers: { 'Content-Length': String(bytes), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: fs.readFileSync(fil) });
  return { ...(await r.json()).file, mime };
}

const tekstAf = (j) => (j.steps || []).flatMap((s) => s.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim() || (j.output_text ?? '').trim();

async function transskriber(model, fil) {
  const start = Date.now();
  const body = model === 'transcribe'
    ? { model: 'gemini-3.5-transcribe', input: [{ type: 'audio', uri: fil.uri, mime_type: fil.mime }], generation_config: { transcription_config: { language_codes: ['da-DK'], mode: { type: 'verbatim' }, custom_vocabulary: ordliste } }, store: false }
    : { model: 'gemini-3.8-flash', input: [{ type: 'audio', uri: fil.uri, mime_type: fil.mime }, { type: 'text', text: FLASH_PROMPT }], generation_config: { thinking_level: 'low' }, store: false };
  const s = await fetch(`${BASE}/v1beta/interactions`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(840000) });
  const j = await s.json();
  const ms = Date.now() - start;
  const u = j.usage ?? {};
  const usd = ((u.total_input_tokens ?? 0) * PRIS[model].ind + ((u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0)) * PRIS[model].ud) / 1e6;
  tilfoejForbrug({ hvad: `sammenlign ${model}`, usd });
  if (!s.ok || j.status !== 'completed') return { fejl: `${s.status} ${j.error?.code ?? j.error?.status ?? j.status ?? ''}`, ms, usd };
  return { tekst: tekstAf(j), ms, usd };
}

async function referat(tekst, sek) {
  let tokens = { ind: 0, ud: 0 };
  const hent = async (url, v) => {
    const s = await fetch(url, v);
    const json = s.json.bind(s);
    s.json = async () => { const j = await json(); const u = j.usage ?? {}; tokens = { ind: u.total_input_tokens ?? 0, ud: (u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0) }; return j; };
    return s;
  };
  const start = Date.now();
  const r = await lavReferat({ noegle: process.env.GEMINI_API_KEY, model: 'gemini-3.8-flash', timeoutMs: 120000, hent })
    .lav({ tekst, titel: '', varighedSek: sek, signal: new AbortController().signal });
  const usd = (tokens.ind * 0.75 + tokens.ud * 3.75) / 1e6;
  tilfoejForbrug({ hvad: 'sammenlign referat', usd });
  return { r, ms: Date.now() - start, usd };
}

function valgteFiler(liste) {
  const syn = liste.filter((f) => f.kilde === 'syntetisk' && f.forhold === 'ren' && f.format === 'm4a');
  const svaere = liste.filter((f) => f.kilde === 'syntetisk' && ['s07-byggemoede', 's17-lang-moede', 's04-rettelser'].includes(f.id) && ['byggeplads', 'vind', 'ekko', 'lav'].includes(f.forhold));
  const fleurs = liste.filter((f) => f.kilde === 'fleurs' && f.format === 'm4a').slice(0, 18);
  return [...syn, ...svaere, ...fleurs];
}

(async () => {
  const navn = valg('navn', 'sammenligning-1');
  const kunFlash = valg('kun-flash', null);
  const liste = JSON.parse(fs.readFileSync(path.join(ROD, 'testlyd/baenk/liste.json'), 'utf8'));
  const filer = kunFlash
    ? [{ fil: kunFlash, id: path.basename(kunFlash), kilde: 'lang', forhold: 'lang', facit: (() => { const l = liste.find((f) => f.id === 'lang-45min'); return `${l.facit} ${l.facit}`; })(), forkerte: [], sek: 5414 }]
    : valgteFiler(liste);
  const startForbrug = forbrugIalt();
  const minutter = filer.reduce((s, f) => s + (f.sek || 0), 0) / 60;
  console.log(`${filer.length} filer, ${minutter.toFixed(1)} min. Brugt i denne test tæller fra ${startForbrug.toFixed(3)} USD. Grænse 10 kr.`);
  const resultater = [];
  for (const f of filer) {
    if ((forbrugIalt() - startForbrug) > GRAENSE_USD * 0.9) { console.error('Nær grænsen på 10 kr. Stopper.'); break; }
    const fil = await upload(path.join(ROD, f.fil));
    const r = { fil: f.fil, id: f.id, kilde: f.kilde, forhold: f.forhold, sek: f.sek };
    try {
      for (const model of kunFlash ? ['flash'] : ['transcribe', 'flash']) {
        const t = await transskriber(model, fil);
        const m = { ms: t.ms, usd: t.usd, fejl: t.fejl };
        if (t.tekst !== undefined) {
          m.tekst = t.tekst;
          m.wer = wer(f.facit, t.tekst);
          const ref = await referat(t.tekst, f.sek);
          m.referatMs = ref.ms;
          m.usd += ref.usd;
          m.tal = talNoejagtighed(ref.r, f.facit, f.forkerte ?? []);
          m.nyeNavne = nyeEgennavne(ref.r, f.facit);
          m.referat = ref.r;
        }
        r[model] = m;
      }
    } finally {
      await fetch(`${BASE}/v1beta/${fil.name}`, { method: 'DELETE', headers: H });
    }
    resultater.push(r);
    const kort = (m) => (m ? (m.fejl ? `FEJL ${m.fejl}` : `WER ${(m.wer.rate * 100).toFixed(1)}% tal ${m.tal.korrekte}/${m.tal.uklart}/${m.tal.forkerte} ${(m.ms / 1000).toFixed(1)}s`) : '-');
    console.log(`${f.id.padEnd(28)} ${f.forhold.padEnd(10)} T: ${kort(r.transcribe).padEnd(36)} F: ${kort(r.flash)}`);
  }
  fs.writeFileSync(path.join(ROD, `testlyd/baenk/${navn}.json`), JSON.stringify(resultater, null, 1));
  console.log(`Brugt i denne test: ${((forbrugIalt() - startForbrug) * KR_PR_USD).toFixed(2)} kr.`);
})().catch((e) => { console.error('Fejl:', e.message); process.exit(1); });
