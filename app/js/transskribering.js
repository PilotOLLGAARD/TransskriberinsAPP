import { API_URL, REFERAT_URL } from './konfig.js';
import { TYPER } from './typer.js';

// Lidt over serverens egen grænse på 900 s, så serverens svar når frem først.
const TIDSGRAENSE_MS = 16 * 60 * 1000;
// Referat, Word og PDF af færdige tekster. Serveren giver et langt møde op til 150 s.
export const REFERAT_TIDSGRAENSE_MS = 4 * 60 * 1000;

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

function metaHeadere({ titel, type, varighedMs, oprettet, kunTekst, afsnit, smaabidder, reserve } = {}) {
  // Appen forstår { tekst, referatMangler }: fejler referatet, laves kun det igen. Ældre apps får den gamle fejl.
  const h = { 'x-referat-mangler': '1' };
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
  // En bid af en lang optagelse: serveren giver også afsnittene med tider, så /referat kan samle dem.
  if (kunTekst && afsnit) h['x-afsnit'] = '1';
  // Appen kan dele bidden i småbidder, hvis Googles filter blokerer den. Så venter serveren med Transcribe.
  if (kunTekst && smaabidder) h['x-smaabidder'] = '1';
  // En bid, der kom tom tilbage to gange: serveren prøver den anden model (Transcribe).
  if (kunTekst && reserve) h['x-reserve'] = '1';
  return h;
}

/**
 * Som fetch, men med XMLHttpRequest, som kan melde, når hele lyden er sendt (vedSendt),
 * og hvor meget der er sendt undervejs (vedFremdrift(sendt, ialt) i bytes).
 * fetch kan ikke vise fremdrift for upload i alle browsere.
 */
export function hentMedFremdrift(url, { method, headers, body, signal, vedSendt, vedFremdrift, stilleMs = STILLE_MS }, Xhr = globalThis.XMLHttpRequest) {
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
      if (e.lengthComputable && e.total > 0) {
        // Kun til visning. En fejl her må aldrig stoppe afsendelsen.
        try { vedFremdrift?.(e.loaded, e.total); } catch { /* ignoreres */ }
      }
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
 * vedSendt kaldes, når hele lyden er sendt, og vedFremdrift(sendt, ialt) undervejs. signal afbryder (fx når brugeren sletter optagelsen).
 * Kaster SendFejl med typen, appen skal vise.
 */
export async function sendLyd(lyd, mime, bevis, meta = {}, hent = hentMedFremdrift, { vedSendt, vedFremdrift, signal } = {}) {
  const signaler = [AbortSignal.timeout(TIDSGRAENSE_MS), ...(signal ? [signal] : [])];
  let svar;
  try {
    svar = await hent(API_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${bevis}`, 'content-type': mime, ...metaHeadere(meta) },
      body: lyd,
      signal: kombinerSignaler(signaler),
      vedSendt,
      vedFremdrift,
    });
  } catch {
    throw new SendFejl('net');
  }
  return laesSvar(svar);
}

async function laesSvar(svar) {
  if (!svar.ok) {
    // Googles grænse for i dag er nået (fx 100 kald om dagen). Serveren siger det med fejlkoden kvote.
    // En lydfil over 2½ time afvises med for-lang.
    const fejl = await svar.json().then((k) => k?.fejl, () => null);
    // Googles filter afviste lyden: en lang optagelse prøver bidden i mindre stykker.
    const kendte = { kvote: 'kvote', 'for-lang': 'forLang', blokeret: 'blokeret' };
    throw new SendFejl(kendte[fejl] || FEJLTYPER[svar.status] || 'tjeneste');
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
export async function sendReferat({ tekster, dele, titel, type, varighedMs, oprettet }, bevis, hent = (...a) => fetch(...a), { signal } = {}) {
  // dele: bidder med tider fra en lang optagelse eller flere filer. tekster: dele af en afbrudt optagelse (før).
  const krop = dele ? { dele } : { tekster };
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
