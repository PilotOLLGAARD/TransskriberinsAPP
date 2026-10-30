'use strict';

const http2 = require('node:http2');
const { hentKonfig } = require('./konfig.js');
const { lavAdgangsTjek } = require('./adgang.js');
const { lavGemini } = require('./gemini.js');
const { lavHandler } = require('./handler.js');
const ordliste = require('./ordliste.js');

/** Cloud Run sender HTTP/2 uden kryptering (h2c) til containeren, når --use-http2 er sat. Det fjerner grænsen på 32 MiB. */
function lavServer(handler) {
  return http2.createServer(handler);
}

function start() {
  const konfig = hentKonfig(process.env);
  const handler = lavHandler({
    konfig,
    tjekAdgang: konfig ? lavAdgangsTjek(konfig) : null,
    gemini: konfig ? lavGemini({
      ...konfig,
      ordliste,
      advar: (besked) => console.log(JSON.stringify({ haendelse: 'advarsel', besked })),
    }) : null,
  });
  if (!konfig) console.error(JSON.stringify({ haendelse: 'konfiguration-mangler' }));
  lavServer(handler).listen(Number(process.env.PORT) || 8080);
}

if (require.main === module) start();

module.exports = { lavServer };
