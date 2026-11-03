'use strict';

const http2 = require('node:http2');
const { hentKonfig } = require('./konfig.js');
const { lavAdgangsTjek } = require('./adgang.js');
const { lavGemini } = require('./gemini.js');
const { lavHandler } = require('./handler.js');
const { lavReferat } = require('./referat.js');
const pdf = require('./pdf.js');
const ordliste = require('./ordliste.js');

const REFERAT_TIMEOUT_MS = 50 * 1000;
// Filer over 20 minutter er efterladt af et afbrudt kald (et kald varer højst 15 minutter).
const OPRYDNING = { hvertMs: 10 * 60 * 1000, aeldreEndMs: 20 * 60 * 1000 };
// Cloud Run giver 10 sekunder fra SIGTERM, til instansen stoppes.
const NEDLUKNING_MS = 8000;

/** Cloud Run sender HTTP/2 uden kryptering (h2c) til containeren, når --use-http2 er sat. Det fjerner grænsen på 32 MiB. */
function lavServer(handler) {
  return http2.createServer(handler);
}

/** Sletter filer, der stadig er i gang hos Google, og afslutter, også hvis sletningen hænger. */
async function vedNedlukning({ gemini, afslut = (kode) => process.exit(kode), ventMs = NEDLUKNING_MS }) {
  try {
    const frist = new Promise((ok) => setTimeout(ok, ventMs).unref());
    await Promise.race([gemini?.sletAktive?.(), frist]);
  } catch { /* Filerne udløber selv efter 48 timer. */ }
  afslut(0);
}

function start() {
  const konfig = hentKonfig(process.env);
  const gemini = konfig ? lavGemini({
    ...konfig,
    ordliste,
    oprydning: OPRYDNING,
    advar: (besked) => console.log(JSON.stringify({ haendelse: 'advarsel', besked })),
  }) : null;
  const handler = lavHandler({
    konfig,
    tjekAdgang: konfig ? lavAdgangsTjek(konfig) : null,
    gemini,
    // Transskription (højst 840 s) og referat skal tilsammen nå under Cloud Runs grænse på 900 s.
    referat: konfig ? lavReferat({ noegle: konfig.noegle, model: konfig.referatModel, timeoutMs: REFERAT_TIMEOUT_MS }) : null,
    pdf,
  });
  if (!konfig) console.error(JSON.stringify({ haendelse: 'konfiguration-mangler' }));
  lavServer(handler).listen(Number(process.env.PORT) || 8080);
  process.once('SIGTERM', () => vedNedlukning({ gemini }));
}

if (require.main === module) start();

module.exports = { lavServer, vedNedlukning };
