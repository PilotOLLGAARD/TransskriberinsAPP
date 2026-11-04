import { API_URL, REFERAT_URL } from './konfig.js';
import { TYPER } from './typer.js';

// Lidt over serverens egen grænse på 900 s, så serverens svar når frem først.
const TIDSGRAENSE_MS = 16 * 60 * 1000;
// Referat og PDF af færdige tekster tager under et minut på serveren.
const REFERAT_TIDSGRAENSE_MS = 2 * 60 * 1000;

// Står uploaden helt stille så længe, er forbindelsen død (fx uden dækning). Så kan noten prøves igen
// med det samme i stedet for at vente på TIDSGRAENSE_MS. Kun når telefonen selv melder fremdrift.
const STILLE_MS = 90 * 1000;

export const FEJLTYPER = { 401: 'login', 403: 'adgang', 411: 'kanIkkeBehandles', 413: 'kanIkkeBehandles', 415: 'kanIkkeBehandles', 422: 'kanIkkeBehandles' };

/** Som AbortSignal.any, som først findes i Safari 17.4. Ældre telefoner får en håndlavet udgave. */
export function kombinerSignaler(signaler) {
  const liste = signaler.filter(Boolean);
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(liste);
  const ctrl = new AbortController();
  for (const s of liste) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

export class SendFejl extends Error {
  constructor(type) {
    super(type);
    this.type = type;
  }
}

function metaHeadere({ titel, type, varighedMs, oprettet, kunTekst } = {}) {
  const h = {};
  // Headere må kun indeholde ASCII, så titlen sendes URL-kodet.
  if (typeof titel === 'string' && titel.trim()) {
    // Et halvt tegn må aldrig stoppe afsendelsen. Det erstattes, så encodeURIComponent ikke kaster.
    const hel = titel.trim();
    h['x-titel'] = encodeURIComponent(typeof hel.toWellFormed === 'function' ? hel.toWellFormed() : hel);
  }
  // Kun kendte typer, så headeren aldrig kan indeholde andet end en nøgle.
  if (TYPER.includes(type)) h['x-type'] = type;
  if (Number.isFinite(varighedMs)) h['x-varighed'] = String(Math.round(varighedMs / 1000));
  if (Number.isFinite(oprettet)) h['x-optaget'] = String(oprettet);
  // En del af en afbrudt optagelse: kun teksten. Referatet laves af alle dele via /referat.
  if (kunTekst) h['x-kun-tekst'] = '1';
  return h;
}

/**
 * Som fetch, men med XMLHttpRequest, som kan melde, når hele lyden er sendt (vedSendt).
 * fetch kan ikke vise fremdrift for upload i alle browsere.
 */
export function hentMedFremdrift(url, { method, headers, body, signal, vedSendt, stilleMs = STILLE_MS }, Xhr = globalThis.XMLHttpRequest) {
  if (typeof Xhr !== 'function') return fetch(url, { method, headers, body, signal });
  return new Promise((ok, fejl) => {
    const x = new Xhr();
    // Præcis én melding. Melder telefonen ikke selv, at lyden er sendt, meldes det, når svaret kommer.
    let meldt = false;
    // Vagten startes først ved den første melding om fremdrift og stoppes, når hele lyden er sendt.
    let vagt = null;
    const stopVagt = () => clearTimeout(vagt);
    const meldSendt = () => {
      stopVagt();
      if (meldt) return;
      meldt = true;
      vedSendt?.();
    };
    const afbryd = () => x.abort();
    const faerdig = () => {
      stopVagt();
      signal?.removeEventListener('abort', afbryd);
    };
    x.open(method, url);
    for (const [navn, vaerdi] of Object.entries(headers)) x.setRequestHeader(navn, vaerdi);
    x.upload.addEventListener('load', meldSendt);
    x.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && e.loaded >= e.total) {
        meldSendt();
        return;
      }
      if (meldt) return;
      stopVagt();
      vagt = setTimeout(afbryd, stilleMs);
    });
    x.onload = () => {
      faerdig();
      meldSendt();
      ok({ ok: x.status >= 200 && x.status < 300, status: x.status, json: async () => JSON.parse(x.responseText) });
    };
    x.onerror = () => { faerdig(); fejl(new TypeError('netværk')); };
    x.onabort = () => { faerdig(); fejl(new DOMException('afbrudt', 'AbortError')); };
    if (signal?.aborted) {
      fejl(new DOMException('afbrudt', 'AbortError'));
      return;
    }
    signal?.addEventListener('abort', afbryd, { once: true });
    x.send(body);
  });
}

/**
 * Sender originallyden. Svaret er { tekst } og, når der var tale, også titel, referat, pdf og filnavn.
 * vedSendt kaldes, når hele lyden er sendt. signal afbryder (fx når brugeren sletter optagelsen).
 * Kaster SendFejl med typen, appen skal vise.
 */
export async function sendLyd(lyd, mime, bevis, meta = {}, hent = hentMedFremdrift, { vedSendt, signal } = {}) {
  const signaler = [AbortSignal.timeout(TIDSGRAENSE_MS), ...(signal ? [signal] : [])];
  let svar;
  try {
    svar = await hent(API_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${bevis}`, 'content-type': mime, ...metaHeadere(meta) },
      body: lyd,
      signal: kombinerSignaler(signaler),
      vedSendt,
    });
  } catch {
    throw new SendFejl('net');
  }
  return laesSvar(svar);
}

async function laesSvar(svar) {
  if (!svar.ok) {
    // Googles grænse for i dag er nået (fx 100 kald om dagen). Serveren siger det med fejlkoden kvote.
    const fejl = await svar.json().then((k) => k?.fejl, () => null);
    throw new SendFejl(fejl === 'kvote' ? 'kvote' : FEJLTYPER[svar.status] || 'tjeneste');
  }
  try {
    const krop = await svar.json();
    if (typeof krop.tekst === 'string') return krop;
  } catch { /* Et ulæseligt svar behandles som en fejl hos tjenesten. */ }
  throw new SendFejl('tjeneste');
}

/**
 * Ét referat af delteksterne fra en afbrudt optagelse. Intet lyd sendes.
 * Svaret er som fra sendLyd: tekst, titel, referat, pdf, filnavn, emne og html.
 */
export async function sendReferat({ tekster, titel, type, varighedMs, oprettet }, bevis, hent = (...a) => fetch(...a), { signal } = {}) {
  const krop = { tekster };
  if (typeof titel === 'string') krop.titel = titel;
  if (typeof type === 'string') krop.type = type;
  if (Number.isFinite(varighedMs)) krop.varighedSek = Math.round(varighedMs / 1000);
  if (Number.isFinite(oprettet)) krop.optaget = oprettet;
  let svar;
  try {
    svar = await hent(REFERAT_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${bevis}`, 'content-type': 'application/json' },
      body: JSON.stringify(krop),
      signal: kombinerSignaler([AbortSignal.timeout(REFERAT_TIDSGRAENSE_MS), signal]),
    });
  } catch {
    throw new SendFejl('net');
  }
  // Et afvist format er ikke lydens skyld. Optagelsen kan sendes igen.
  if (svar.status === 400) throw new SendFejl('tjeneste');
  return laesSvar(svar);
}
