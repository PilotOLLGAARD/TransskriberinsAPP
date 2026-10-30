'use strict';

/**
 * Kald til Gemini via REST: upload til Files API, transskribér, slet filen.
 * Format efterprøvet mod ai.google.dev (transcribe, files, interactions), oktober 2026.
 */

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

function lavGemini({ noegle, model, sprog, tilstand, ordliste, timeoutMs, hent = (...a) => fetch(...a), advar = () => {} }) {
  async function upload(strom, bytes, mime, signal) {
    const start = await hent(`${BASE}/upload/v1beta/files`, {
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
      body: JSON.stringify({ file: { display_name: 'optagelse' } }),
    });
    if (!start.ok) throw httpFejl(start.status, 'upload-start');
    const adresse = start.headers.get('x-goog-upload-url');
    if (!adresse) throw new GeminiFejl('tjeneste', 'upload-start: mangler adresse');

    const svar = await hent(adresse, {
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

    const svar = await hent(`${BASE}/v1beta/interactions`, {
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
      const svar = await hent(`${BASE}/v1beta/${navn}`, {
        method: 'DELETE',
        headers: { 'x-goog-api-key': noegle },
        signal: AbortSignal.timeout(SLET_TIMEOUT_MS),
      });
      if (!svar.ok) advar(`fil-ikke-slettet status ${svar.status}`);
    } catch (e) {
      // Filen udløber selv efter 48 timer. Fejl her må ikke vælte svaret.
      advar(`fil-ikke-slettet ${e && e.name}`);
    }
  }

  return {
    async transskriber(strom, { bytes, mime, signal }) {
      const type = geminiMime(mime);
      const samlet = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      let fil;
      try {
        fil = await upload(strom, bytes, type, samlet);
        return { tekst: await transskriberFil(fil, type, samlet) };
      } catch (e) {
        if (e instanceof GeminiFejl) throw e;
        // Originalbeskeden kan indeholde detaljer fra kaldet, så den sendes ikke videre.
        throw new GeminiFejl('tjeneste', `netværk ${e && e.name}`);
      } finally {
        if (fil) await sletFil(fil.name);
      }
    },
  };
}

module.exports = { lavGemini, GeminiFejl, geminiMime };
