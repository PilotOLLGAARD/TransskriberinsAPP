'use strict';

/**
 * Prøver én lydfil mod rigtig Gemini. Koster penge og kræver GEMINI_API_KEY i .env.
 * Brug kun selvindtalte testoptagelser, aldrig rigtige byggepladsnoter.
 *
 * Brug: node --env-file=.env scripts/proev-gemini.js <fil> [audio/mp4]
 */

const fs = require('node:fs');
const path = require('node:path');
const { lavGemini } = require('../server/src/gemini.js');
const ordliste = require('../server/src/ordliste.js');

const FORMATER = { '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm' };

async function main() {
  const [fil, oplystFormat] = process.argv.slice(2);
  if (!fil) throw new Error('Brug: node --env-file=.env scripts/proev-gemini.js <fil> [audio/mp4]');
  const noegle = process.env.GEMINI_API_KEY;
  if (!noegle) throw new Error('GEMINI_API_KEY mangler. Husk --env-file=.env');
  const mime = oplystFormat || FORMATER[path.extname(fil).toLowerCase()];
  if (!mime) throw new Error('Ukendt format. Angiv det, fx audio/mp4');

  const gemini = lavGemini({
    noegle,
    model: process.env.GEMINI_MODEL || 'gemini-3.5-transcribe',
    sprog: process.env.SPROG || 'da-DK',
    tilstand: process.env.TRANSSKRIPTION_TILSTAND === 'verbatim' ? 'verbatim' : 'smart',
    ordliste,
    timeoutMs: 840000,
    advar: (besked) => console.error(`Advarsel: ${besked}`),
  });

  const { size } = fs.statSync(fil);
  const start = Date.now();
  const { tekst } = await gemini.transskriber(fs.createReadStream(fil), {
    bytes: size,
    mime,
    signal: new AbortController().signal,
  });
  console.log(`Fil: ${(size / 1024 / 1024).toFixed(1)} MB. Svartid: ${((Date.now() - start) / 1000).toFixed(1)} s.`);
  console.log(`Format og store: false blev accepteret.\n\n${tekst}`);
}

main().catch((e) => {
  console.error(`Fejl: ${e.message}${e.kode ? ` (${e.kode})` : ''}`);
  process.exitCode = 1;
});
