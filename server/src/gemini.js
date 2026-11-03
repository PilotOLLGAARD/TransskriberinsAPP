'use strict';

/**
 * Kald til Gemini via REST: upload til Files API, transskribér, slet filen.
 * Format efterprøvet mod ai.google.dev (transcribe, files, interactions), oktober 2026.
 */

const http = require('node:http');
const https = require('node:https');

const BASE = 'https://generativelanguage.googleapis.com';
const SLET_TIMEOUT_MS = 5000;

const MIME_NAVNE = { 'audio/mp4': 'audio/m4a', 'audio/x-m4a': 'audio/m4a' };

class GeminiFejl extends Error {
  /** @param {'tjeneste'|'noegle'|'format'} kode */
  constructor(kode, besked) {
    super(besked);
    this.name = 'GeminiFejl';
    this.kode = kode;
  }
}

function geminiMime(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  return MIME_NAVNE[m] || m;
}

function httpFejl(status, hvor) {
  if (status === 400) return new GeminiFejl('format', `${hvor}: ugyldig forespørgsel`);
  if (status === 401 || status === 403) return new GeminiFejl('noegle', `${hvor}: nøgle afvist`);
  return new GeminiFejl('tjeneste', `${hvor}: status ${status}`);
}

function udtraekTekst(svar) {
  if (typeof svar.output_text === 'string') return svar.output_text.trim();
  const dele = [];
  for (const step of svar.steps || []) {
    if (step.type && step.type !== 'model_output') continue;
    for (const c of step.content || []) {
      if (c && c.type === 'text' && typeof c.text === 'string') dele.push(c.text);
    }
  }
  for (const o of svar.outputs || []) {
    if (o && o.type === 'text' && typeof o.text === 'string') dele.push(o.text);
  }
  return dele.join('\n').trim();
}

/**
 * POST uden tidsgrænse på svaret. Nodes fetch giver selv op efter 300 s uden svar, og lange
 * optagelser kan tage længere. Tidsgrænsen styres af signal.
 */
function hentUdenGraense(url, { method, headers, body, signal }) {
  const modul = String(url).startsWith('https:') ? https : http;
  return new Promise((ok, fejl) => {
    const anmodning = modul.request(url, { method, headers, signal }, (svar) => {
      const dele = [];
      svar.on('data', (d) => dele.push(d));
      svar.on('error', fejl);
      svar.on('end', () => {
        const tekst = Buffer.concat(dele).toString('utf8');
        ok({
          ok: svar.statusCode >= 200 && svar.statusCode < 300,
          status: svar.statusCode,
          json: async () => JSON.parse(tekst),
        });
      });
    });
    anmodning.on('error', fejl);
    anmodning.end(body);
  });
}

/** Filens navn vælges her, så den kan slettes, selvom svaret på upload aldrig kommer frem. */
function nytFilnavn() {
  return `files/opt-${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * oprydning: { hvertMs, aeldreEndMs } sletter filer, som en afbrudt eller lukket server efterlod.
 * Uden den er oprydning slået fra.
 */
function lavGemini({ noegle, model, sprog, tilstand, ordliste, timeoutMs, hent, hentLangsom, advar = () => {}, oprydning, nu = Date.now }) {
  const hentKald = hent || ((...a) => fetch(...a));
  const hentTransskription = hentLangsom || hent || hentUdenGraense;
  // Filer, der er startet hos Google og ikke slettet endnu.
  const aktive = new Set();
  let sidsteOprydning = -Infinity;

  async function upload(strom, bytes, mime, signal, navn, vedStart) {
    const start = await hentKald(`${BASE}/upload/v1beta/files`, {
      method: 'POST',
      signal,
      headers: {
        'x-goog-api-key': noegle,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(bytes),
        'X-Goog-Upload-Header-Content-Type': mime,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { name: navn, display_name: 'optagelse' } }),
    });
    if (!start.ok) throw httpFejl(start.status, 'upload-start');
    // Fra nu af kan filen findes hos Google, også hvis resten af upload går galt.
    vedStart();
    const adresse = start.headers.get('x-goog-upload-url');
    if (!adresse) throw new GeminiFejl('tjeneste', 'upload-start: mangler adresse');

    const svar = await hentKald(adresse, {
      method: 'POST',
      signal,
      duplex: 'half',
      headers: {
        'Content-Length': String(bytes),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: strom,
    });
    if (!svar.ok) throw httpFejl(svar.status, 'upload');
    const { file } = await svar.json();
    if (!file || !file.uri || !file.name) throw new GeminiFejl('tjeneste', 'upload: uventet svar');
    return file;
  }

  async function transskriberFil(fil, mime, signal) {
    const transcription_config = {
      language_codes: [sprog],
      mode: tilstand === 'verbatim' ? { type: 'verbatim' } : 'smart',
    };
    if (ordliste.length) transcription_config.custom_vocabulary = ordliste;

    const svar = await hentTransskription(`${BASE}/v1beta/interactions`, {
      method: 'POST',
      signal,
      headers: { 'x-goog-api-key': noegle, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input: [{ type: 'audio', uri: fil.uri, mime_type: mime }],
        generation_config: { transcription_config },
        // Interactions gemmes ellers i 55 dage hos Google, også efter filen er slettet.
        store: false,
      }),
    });
    if (!svar.ok) throw httpFejl(svar.status, 'interactions');
    const krop = await svar.json();
    // Alt andet end completed er fejl, så en halv tekst aldrig tages for en hel.
    if (krop.status !== 'completed') throw new GeminiFejl('tjeneste', `interactions: status ${krop.status}`);
    return udtraekTekst(krop);
  }

  async function sletFil(navn) {
    try {
      const svar = await hentKald(`${BASE}/v1beta/${navn}`, {
        method: 'DELETE',
        headers: { 'x-goog-api-key': noegle },
        signal: AbortSignal.timeout(SLET_TIMEOUT_MS),
      });
      // 403 og 404: filen findes ikke (længere). Andre fejl prøves igen ved nedlukning og oprydning.
      if (svar.ok || svar.status === 403 || svar.status === 404) aktive.delete(navn);
      if (!svar.ok) advar(`fil-ikke-slettet status ${svar.status}`);
    } catch (e) {
      // Filen udløber selv efter 48 timer. Fejl her må ikke vælte svaret.
      advar(`fil-ikke-slettet ${e && e.name}`);
    }
  }

  /** Sletter filer over aeldreEndMs, som denne eller en anden server har efterladt. */
  async function rydGamle() {
    let side = '';
    do {
      const url = new URL(`${BASE}/v1beta/files`);
      url.searchParams.set('pageSize', '100');
      if (side) url.searchParams.set('pageToken', side);
      const svar = await hentKald(url, { headers: { 'x-goog-api-key': noegle }, signal: AbortSignal.timeout(SLET_TIMEOUT_MS) });
      if (!svar.ok) throw new Error(`status ${svar.status}`);
      const { files = [], nextPageToken } = await svar.json();
      for (const fil of files) {
        if (aktive.has(fil.name) || !(Date.parse(fil.createTime) < nu() - oprydning.aeldreEndMs)) continue;
        await sletFil(fil.name);
      }
      side = nextPageToken || '';
    } while (side);
  }
  rydGamle.igang = Promise.resolve();

  function planlaegOprydning() {
    if (!oprydning || nu() - sidsteOprydning < oprydning.hvertMs) return;
    sidsteOprydning = nu();
    // Kører, mens kaldet har CPU, og venter ikke på det.
    rydGamle.igang = rydGamle().catch((e) => advar(`oprydning ${e && e.name}`));
  }

  return {
    async transskriber(strom, { bytes, mime, signal }) {
      planlaegOprydning();
      const type = geminiMime(mime);
      const samlet = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const navn = nytFilnavn();
      const navne = new Set();
      try {
        const fil = await upload(strom, bytes, type, samlet, navn, () => { navne.add(navn); aktive.add(navn); });
        // Google bør bruge vores navn. Gør den ikke, slettes begge.
        if (fil.name !== navn) { navne.add(fil.name); aktive.add(fil.name); }
        return { tekst: await transskriberFil(fil, type, samlet) };
      } catch (e) {
        if (e instanceof GeminiFejl) throw e;
        // Originalbeskeden kan indeholde detaljer fra kaldet, så den sendes ikke videre.
        throw new GeminiFejl('tjeneste', `netværk ${e && e.name}`);
      } finally {
        for (const n of navne) await sletFil(n);
      }
    },

    /** Ved nedlukning: slet filer, der stadig er i gang. */
    async sletAktive() {
      await Promise.all([...aktive].map(sletFil));
    },

    rydGamle,
  };
}

module.exports = { lavGemini, GeminiFejl, geminiMime, hentUdenGraense, httpFejl, udtraekTekst, BASE };
