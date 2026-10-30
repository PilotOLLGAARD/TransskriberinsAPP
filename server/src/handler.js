'use strict';

const { Transform, pipeline } = require('node:stream');
const { GeminiFejl } = require('./gemini.js');

const FORMATER = new Set(['audio/mp4', 'audio/webm']);

function standardLog(o) {
  console.log(JSON.stringify(o));
}

function lavBytevagt(maks) {
  let antal = 0;
  const vagt = new Transform({
    transform(stykke, _kodning, faerdig) {
      antal += stykke.length;
      if (antal > maks) {
        vagt.overskredet = true;
        faerdig(new Error('for-mange-bytes'));
        return;
      }
      faerdig(null, stykke);
    },
  });
  vagt.overskredet = false;
  return vagt;
}

/**
 * POST /transskriber. Virker med både node:http og node:http2 compat.
 * Adgangstjekket er det første, der sker, før lyden læses.
 */
function lavHandler({ konfig, tjekAdgang, gemini, log = standardLog }) {
  function sendJson(res, cors, status, krop) {
    res.writeHead(status, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(krop));
  }

  async function behandl(req, res) {
    const cors = {};
    if (konfig && req.headers.origin === konfig.tilladtOprindelse) {
      cors['access-control-allow-origin'] = konfig.tilladtOprindelse;
      cors.vary = 'Origin';
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }

    if (new URL(req.url, 'http://x').pathname !== '/transskriber') return sendJson(res, cors, 404, { fejl: 'ikke-fundet' });
    if (req.method !== 'POST') return sendJson(res, cors, 405, { fejl: 'forkert-metode' });
    if (!konfig) return sendJson(res, cors, 500, { fejl: 'server-ikke-klar' });

    const adgang = await tjekAdgang(req.headers.authorization);
    if (!adgang.ok) {
      log({ haendelse: 'adgang-afvist', grund: adgang.grund });
      return sendJson(res, cors, adgang.status, { fejl: adgang.status === 401 ? 'login-kraeves' : 'ingen-adgang' });
    }

    const mime = String(req.headers['content-type'] || '');
    if (!FORMATER.has(mime.split(';')[0].trim().toLowerCase())) {
      return sendJson(res, cors, 415, { fejl: 'kan-ikke-behandles' });
    }

    const raaLaengde = req.headers['content-length'];
    if (raaLaengde === undefined) return sendJson(res, cors, 411, { fejl: 'kan-ikke-behandles' });
    const bytes = Number(raaLaengde);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return sendJson(res, cors, 411, { fejl: 'kan-ikke-behandles' });
    if (bytes > konfig.maxBytes) return sendJson(res, cors, 413, { fejl: 'kan-ikke-behandles' });

    const afbryd = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) afbryd.abort();
    });

    const vagt = lavBytevagt(bytes);
    pipeline(req, vagt, () => {});

    log({ haendelse: 'gemini-kald' });
    try {
      const { tekst } = await gemini.transskriber(vagt, { bytes, mime, signal: afbryd.signal });
      sendJson(res, cors, 200, { tekst });
    } catch (e) {
      if (vagt.overskredet) return sendJson(res, cors, 413, { fejl: 'kan-ikke-behandles' });
      const kode = e instanceof GeminiFejl ? e.kode : 'tjeneste';
      log({ haendelse: 'gemini-fejl', kode });
      if (kode === 'format') return sendJson(res, cors, 422, { fejl: 'kan-ikke-behandles' });
      if (kode === 'noegle') return sendJson(res, cors, 500, { fejl: 'server-ikke-klar' });
      sendJson(res, cors, 502, { fejl: 'tjeneste' });
    }
  }

  return async function handler(req, res) {
    try {
      await behandl(req, res);
    } catch {
      log({ haendelse: 'uventet-fejl' });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ fejl: 'server-ikke-klar' }));
      }
    }
  };
}

module.exports = { lavHandler };
