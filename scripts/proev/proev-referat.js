'use strict';

/**
 * Prøver referat og PDF mod rigtig Gemini ud fra en tekstfil eller en lydfil. Koster penge og kræver .env.
 * Brug kun selvindtalte eller opdigtede tekster, aldrig rigtige byggepladsnoter.
 *
 * Brug: node --env-file=.env scripts/proev/proev-referat.js <fil.txt|fil.m4a> [--titel "..."] [--type moede] [--varighed 120] [--pdf mappe]
 */

const fs = require('node:fs');
const path = require('node:path');
const { lavReferat } = require('../../server/src/referat.js');
const { lavGemini, hentUdenGraense } = require('../../server/src/gemini.js');
const ordliste = require('../../server/src/ordliste.js');

function valg(navn) {
  const i = process.argv.indexOf(`--${navn}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const fil = process.argv[2];
  if (!fil || !process.env.GEMINI_API_KEY) throw new Error('Brug: node --env-file=.env scripts/proev/proev-referat.js <fil> [--titel ...]');
  const signal = new AbortController().signal;
  let tekst;
  if (/\.(m4a|mp4|webm)$/i.test(fil)) {
    const gemini = lavGemini({
      noegle: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL || 'gemini-3.5-transcribe',
      sprog: 'da-DK', tilstand: 'smart', ordliste, timeoutMs: 840000,
    });
    const mime = /\.webm$/i.test(fil) ? 'audio/webm' : 'audio/mp4';
    ({ tekst } = await gemini.transskriber(fs.createReadStream(fil), { bytes: fs.statSync(fil).size, mime, signal }));
  } else {
    tekst = fs.readFileSync(fil, 'utf8');
  }
  const varighed = valg('varighed');
  const start = Date.now();
  let forbrug = null;
  const hent = async (url, v) => {
    const s = await hentUdenGraense(url, v);
    const json = s.json;
    return { ...s, json: async () => { const j = await json(); forbrug = j.usage; return j; } };
  };
  const referat = await lavReferat({
    noegle: process.env.GEMINI_API_KEY, model: process.env.REFERAT_MODEL || 'gemini-3.8-flash', timeoutMs: 120000, hent,
  }).lav({ tekst, titel: valg('titel') || '', type: valg('type'), varighedSek: varighed === undefined ? null : Number(varighed), signal });
  console.log(`Referat på ${((Date.now() - start) / 1000).toFixed(1)} s:\n${JSON.stringify(referat, null, 2)}`);
  if (forbrug) {
    // Gemini 3.8 Flash, betalt niveau, til 31. december 2026: 0,75 USD pr. mio. tokens ind og 3,75 ud. Tænkning tæller som ud.
    const ind = forbrug.total_input_tokens || 0;
    const ud = (forbrug.total_output_tokens || 0) + (forbrug.total_thought_tokens || 0);
    console.log(`Tokens: ${ind} ind, ${ud} ud. Pris ca. ${((ind * 0.75 + ud * 3.75) / 1e6).toFixed(5)} USD`);
  }

  const pdfSti = valg('pdf');
  if (pdfSti) {
    const { lavPdf, filnavn } = require('../../server/src/pdf.js');
    const tidspunkt = Date.now();
    const pdf = await lavPdf({ titel: referat.titel, tidspunkt, varighedSek: varighed === undefined ? null : Number(varighed), referat, tekst });
    const ud = path.join(pdfSti, filnavn({ titel: referat.titel, tidspunkt }));
    fs.writeFileSync(ud, pdf);
    console.log(`PDF: ${ud} (${pdf.length} bytes)`);
  }
}

main().catch((e) => {
  console.error(`Fejl: ${e.message}${e.kode ? ` (${e.kode})` : ''}`);
  process.exitCode = 1;
});
