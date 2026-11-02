import { API_URL } from './konfig.js';
import { TYPER } from './typer.js';

// Lidt over serverens egen grænse på 900 s, så serverens svar når frem først.
const TIDSGRAENSE_MS = 16 * 60 * 1000;

const FEJLTYPER = { 401: 'login', 403: 'adgang', 411: 'kanIkkeBehandles', 413: 'kanIkkeBehandles', 415: 'kanIkkeBehandles', 422: 'kanIkkeBehandles' };

export class SendFejl extends Error {
  constructor(type) {
    super(type);
    this.type = type;
  }
}

function metaHeadere({ titel, type, varighedMs, oprettet } = {}) {
  const h = {};
  // Headere må kun indeholde ASCII, så titlen sendes URL-kodet.
  if (typeof titel === 'string' && titel.trim()) {
    // Et halvt tegn må aldrig stoppe afsendelsen. Det erstattes, så encodeURIComponent ikke kaster.
    const hel = titel.trim();
    h['x-titel'] = encodeURIComponent(typeof hel.toWellFormed === 'function' ? hel.toWellFormed() : hel);
  }
  // Kun kendte typer, så headeren aldrig kan indeholde andet end en nøgle.
  if (TYPER.some((t) => t.noegle === type)) h['x-type'] = type;
  if (Number.isFinite(varighedMs)) h['x-varighed'] = String(Math.round(varighedMs / 1000));
  if (Number.isFinite(oprettet)) h['x-optaget'] = String(oprettet);
  return h;
}

/**
 * Sender originallyden. Svaret er { tekst } og, når der var tale, også titel, referat, pdf og filnavn.
 * Kaster SendFejl med typen, appen skal vise.
 */
export async function sendLyd(lyd, mime, bevis, meta = {}, hent = (...a) => fetch(...a)) {
  let svar;
  try {
    svar = await hent(API_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${bevis}`, 'content-type': mime, ...metaHeadere(meta) },
      body: lyd,
      signal: AbortSignal.timeout(TIDSGRAENSE_MS),
    });
  } catch {
    throw new SendFejl('net');
  }
  if (!svar.ok) throw new SendFejl(FEJLTYPER[svar.status] || 'tjeneste');
  try {
    const krop = await svar.json();
    if (typeof krop.tekst === 'string') return krop;
  } catch { /* Et ulæseligt svar behandles som en fejl hos tjenesten. */ }
  throw new SendFejl('tjeneste');
}
