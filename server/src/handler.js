'use strict';

const { Transform, pipeline } = require('node:stream');
const { GeminiFejl, fejltype } = require('./gemini.js');
const { laesType } = require('./typer.js');
const { lavEmne, lavHtml } = require('./besked.js');

const FORMATER = new Set(['audio/mp4', 'audio/webm']);
const MAX_TITEL = 120;
const MAX_VARIGHED_SEK = 3600;
const TIDLIGSTE_TIDSPUNKT = Date.UTC(2020, 0, 1);
const DAG_MS = 24 * 60 * 60 * 1000;
const MAX_REFERAT_BYTES = 2 * 1024 * 1024;
const MAX_DELE = 20;
const MARKOER = '\n\n[Optagelsen blev afbrudt her]\n\n';

/** Fjerner kontroltegn og afkorter i hele tegn, så en emoji aldrig deles. */
function renTitel(titel) {
  return [...String(titel).replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, MAX_TITEL).join('').trim();
}

/** Brugerens navn på optagelsen. Telefonen sender det URL-kodet, da headere kun må indeholde ASCII. */
function laesTitel(raa) {
  if (!raa) return '';
  try {
    return renTitel(decodeURIComponent(String(raa)));
  } catch {
    return '';
  }
}

function laesVarighed(raa) {
  if (raa === undefined || raa === '') return null;
  const n = Number(raa);
  return Number.isFinite(n) && n >= 0 && n <= MAX_VARIGHED_SEK ? n : null;
}

function laesTidspunkt(raa) {
  const n = Number(raa);
  const nu = Date.now();
  return Number.isSafeInteger(n) && n >= TIDLIGSTE_TIDSPUNKT && n <= nu + DAG_MS ? n : nu;
}
const ADGANG_FEJL = { 401: 'login-kraeves', 403: 'ingen-adgang' };

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

/** Delteksterne fra en afbrudt optagelse. null, hvis kroppen ikke er gyldig. */
function laesTekster(krop) {
  const tekster = krop?.tekster;
  if (!Array.isArray(tekster) || tekster.length < 1 || tekster.length > MAX_DELE) return null;
  if (!tekster.every((x) => typeof x === 'string')) return null;
  return tekster.map((x) => x.trim()).filter(Boolean);
}

/**
 * POST /transskriber og POST /referat. Virker med både node:http og node:http2 compat.
 * Adgangstjekket er det første, der sker, før kroppen læses.
 * /transskriber med x-kun-tekst: 1 giver kun teksten. /referat laver ét referat af flere delteksters.
 */
function lavHandler({ konfig, tjekAdgang, gemini, referat, pdf, log = standardLog }) {
  function sendJson(res, cors, status, krop) {
    res.writeHead(status, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(krop));
  }

  /** Afviser en anmodning og logger hvorfor, kun med en fast grund og status. */
  function afvis(res, cors, status, grund, fejl = 'kan-ikke-behandles') {
    log({ haendelse: 'anmodning-afvist', grund, status });
    return sendJson(res, cors, status, { fejl });
  }

  /** Referat, PDF og mail af en tekst. Fælles for én optagelse og flere dele. */
  async function lavResultat({ tekst, titel, type, varighedSek, tidspunkt, signal }, spor) {
    log({ haendelse: 'referat-kald' });
    spor.trin = 'referat';
    const r = await referat.lav({ tekst, titel, type, varighedSek, signal });
    spor.trin = 'pdf';
    const fil = await pdf.lavPdf({ titel: r.titel, tidspunkt, varighedSek, referat: r, tekst });
    return {
      tekst,
      titel: r.titel,
      type: r.type,
      referat: r,
      pdf: fil.toString('base64'),
      filnavn: pdf.filnavn({ titel: r.titel, tidspunkt }),
      emne: lavEmne({ type: r.type, titel: r.titel, tidspunkt }),
      html: lavHtml({ titel: r.titel, referat: r }),
    };
  }

  /**
   * Logger kun koder og tal: trin, Googles HTTP-status og faste fejlkode (fx RESOURCE_EXHAUSTED)
   * og fejlens navn. Aldrig fejlbeskeden, da den kan indeholde detaljer fra kaldet.
   */
  function sendFejl(res, cors, e, trin) {
    const geminiFejl = e instanceof GeminiFejl;
    const kode = geminiFejl ? e.kode : 'tjeneste';
    const linje = { haendelse: 'gemini-fejl', kode, trin: (geminiFejl && e.trin) || trin };
    if (geminiFejl && Number.isInteger(e.status)) linje.googleStatus = e.status;
    if (geminiFejl && e.googleKode) linje.googleKode = e.googleKode;
    const type = geminiFejl ? e.fejltype : fejltype(e);
    if (type) linje.fejltype = type;
    log(linje);
    if (kode === 'format') return sendJson(res, cors, 422, { fejl: 'kan-ikke-behandles' });
    if (kode === 'noegle') return sendJson(res, cors, 500, { fejl: 'server-ikke-klar' });
    return sendJson(res, cors, 502, { fejl: 'tjeneste' });
  }

  function lavAfbryder(res) {
    const afbryd = new AbortController();
    // writableFinished er true på en nulstillet HTTP/2-strøm, så det kan ikke bruges her.
    res.on('close', () => {
      if (!res.writableEnded) afbryd.abort();
    });
    return afbryd;
  }

  async function referatAfDele(req, res, cors) {
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      return afvis(res, cors, 415, 'forkert-format');
    }
    const bytes = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return afvis(res, cors, 411, 'mangler-laengde');
    if (bytes > MAX_REFERAT_BYTES) return afvis(res, cors, 413, 'for-stor');

    const afbryd = lavAfbryder(res);
    const dele = [];
    try {
      for await (const d of req.pipe(lavBytevagt(bytes))) dele.push(d);
    } catch {
      return afvis(res, cors, 413, 'for-mange-bytes');
    }
    let krop;
    try {
      krop = JSON.parse(Buffer.concat(dele).toString('utf8'));
    } catch {
      return afvis(res, cors, 400, 'ugyldig-json');
    }
    const tekster = laesTekster(krop);
    if (!tekster) return afvis(res, cors, 400, 'ugyldige-tekster');
    if (!tekster.length) return sendJson(res, cors, 200, { tekst: '' });

    const spor = { trin: 'referat' };
    try {
      sendJson(res, cors, 200, await lavResultat({
        tekst: tekster.join(MARKOER),
        titel: typeof krop.titel === 'string' ? renTitel(krop.titel) : '',
        type: laesType(krop.type),
        varighedSek: laesVarighed(krop.varighedSek),
        tidspunkt: laesTidspunkt(krop.optaget),
        signal: afbryd.signal,
      }, spor));
    } catch (e) {
      sendFejl(res, cors, e, spor.trin);
    }
  }

  function lavCors(req) {
    const cors = {};
    if (konfig && req.headers.origin === konfig.tilladtOprindelse) {
      cors['access-control-allow-origin'] = konfig.tilladtOprindelse;
      cors.vary = 'Origin';
    }
    return cors;
  }

  async function behandl(req, res, cors) {

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'authorization, content-type, x-titel, x-type, x-varighed, x-optaget, x-kun-tekst',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }

    const sti = new URL(req.url, 'http://x').pathname;
    if (sti !== '/transskriber' && sti !== '/referat') return sendJson(res, cors, 404, { fejl: 'ikke-fundet' });
    if (req.method !== 'POST') return sendJson(res, cors, 405, { fejl: 'forkert-metode' });
    if (!konfig) return afvis(res, cors, 500, 'konfiguration-mangler', 'server-ikke-klar');

    const adgang = await tjekAdgang(req.headers.authorization);
    if (!adgang.ok) {
      log({ haendelse: 'adgang-afvist', grund: adgang.grund, status: adgang.status });
      return sendJson(res, cors, adgang.status, { fejl: ADGANG_FEJL[adgang.status] || 'tjeneste' });
    }

    if (sti === '/referat') return referatAfDele(req, res, cors);

    const mime = String(req.headers['content-type'] || '');
    if (!FORMATER.has(mime.split(';')[0].trim().toLowerCase())) return afvis(res, cors, 415, 'forkert-format');

    const raaLaengde = req.headers['content-length'];
    const bytes = Number(raaLaengde);
    if (raaLaengde === undefined || !Number.isSafeInteger(bytes) || bytes <= 0) return afvis(res, cors, 411, 'mangler-laengde');
    if (bytes > konfig.maxBytes) return afvis(res, cors, 413, 'for-stor');

    const afbryd = lavAfbryder(res);
    const vagt = lavBytevagt(bytes);
    pipeline(req, vagt, () => {});

    log({ haendelse: 'gemini-kald' });
    const spor = { trin: 'transskription' };
    try {
      const { tekst } = await gemini.transskriber(vagt, { bytes, mime, signal: afbryd.signal });
      // En del af en afbrudt optagelse: referatet laves først af alle dele via /referat.
      if (!tekst || req.headers['x-kun-tekst'] === '1') return sendJson(res, cors, 200, { tekst });

      sendJson(res, cors, 200, await lavResultat({
        tekst,
        titel: laesTitel(req.headers['x-titel']),
        type: laesType(req.headers['x-type']),
        varighedSek: laesVarighed(req.headers['x-varighed']),
        tidspunkt: laesTidspunkt(req.headers['x-optaget']),
        signal: afbryd.signal,
      }, spor));
    } catch (e) {
      if (vagt.overskredet) return afvis(res, cors, 413, 'for-mange-bytes');
      sendFejl(res, cors, e, spor.trin);
    }
  }

  return async function handler(req, res) {
    let cors = {};
    try {
      cors = lavCors(req);
      await behandl(req, res, cors);
    } catch (e) {
      const linje = { haendelse: 'uventet-fejl' };
      if (fejltype(e)) linje.fejltype = fejltype(e);
      log(linje);
      if (!res.headersSent) {
        // Med CORS, så appen kan læse svaret og vise en fejl i stedet for "ingen forbindelse".
        res.writeHead(500, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ fejl: 'server-ikke-klar' }));
      }
    }
  };
}

module.exports = { lavHandler };
