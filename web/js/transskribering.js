import { API_URL } from './konfig.js';

// Lidt over serverens egen grænse på 900 s, så serverens svar når frem først.
const TIDSGRAENSE_MS = 16 * 60 * 1000;

const FEJLTYPER = { 401: 'login', 403: 'adgang', 411: 'kanIkkeBehandles', 413: 'kanIkkeBehandles', 415: 'kanIkkeBehandles', 422: 'kanIkkeBehandles' };

export class SendFejl extends Error {
  constructor(type) {
    super(type);
    this.type = type;
  }
}

/** Sender originallyden. Kaster SendFejl med typen, appen skal vise. */
export async function sendLyd(lyd, mime, bevis, hent = (...a) => fetch(...a)) {
  let svar;
  try {
    svar = await hent(API_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${bevis}`, 'content-type': mime },
      body: lyd,
      signal: AbortSignal.timeout(TIDSGRAENSE_MS),
    });
  } catch {
    throw new SendFejl('net');
  }
  if (!svar.ok) throw new SendFejl(FEJLTYPER[svar.status] || 'tjeneste');
  try {
    const { tekst } = await svar.json();
    if (typeof tekst === 'string') return { tekst };
  } catch { /* Et ulæseligt svar behandles som en fejl hos tjenesten. */ }
  throw new SendFejl('tjeneste');
}
