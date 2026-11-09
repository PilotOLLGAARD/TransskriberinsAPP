// En lydfil, brugeren allerede har (fx fra Memoer på iPhone): kontrol i appen og gemning på telefonen, før noget sendes.
// Filen gemmes byte for byte. Den omkodes, nedsamples og deles aldrig, så lyden er den samme hos Google.

import { LAAS_PRAEFIKS } from './optager.js';
import { STATUS } from './tilstand.js';

/** Største fil, serveren tager imod. */
export const MAKS_BYTES = 500 * 1024 * 1024;
/** Længste lydfil: 2½ time. Samme grænse som på serveren (MAX_UPLOAD_SEK i server/src/handler.js). */
export const MAKS_VARIGHED_MS = 9000 * 1000;
/** Filen læses og gemmes i stykker af denne størrelse, så hele filen aldrig skal ligge i hukommelsen på én gang. */
export const STYKKE_BYTES = 8 * 1024 * 1024;
const VARIGHED_TIDSGRAENSE_MS = 5000;

export const ACCEPT = 'audio/*,.m4a,.mp3,.wav,.webm,.ogg,.oga,.aac,.flac';

// Det format, der sendes, når filens egen type mangler eller ikke passer til indholdet.
const MIME = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac', aac: 'audio/aac' };
// Filens egen type bruges kun, når serveren kender den, og den passer til indholdet.
const KENDTE_TYPER = { 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/flac': 'flac', 'audio/aac': 'aac' };

export class LydfilFejl extends Error {
  /** @param {'ikkeLydfil'|'forStorFil'|'filKanIkkeLaeses'|'pladsTom'} type */
  constructor(type) {
    super(type);
    this.type = type;
  }
}

function erTekst(b, fra, s) {
  if (b.length < fra + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[fra + i] !== s.charCodeAt(i)) return false;
  return true;
}

/** Formatet ud fra filens første bytes, eller null, når det ikke er lyd, appen kan bruge. */
export function genkendFormat(b) {
  if (erTekst(b, 4, 'ftyp')) return 'm4a';
  if (erTekst(b, 0, 'ID3')) return 'mp3';
  if (erTekst(b, 0, 'RIFF') && erTekst(b, 8, 'WAVE')) return 'wav';
  if (erTekst(b, 0, 'OggS')) return 'ogg';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (erTekst(b, 0, 'fLaC')) return 'flac';
  if (b.length >= 3 && b[0] === 0xff) {
    // ADTS (AAC): 12 bits synkronisering og lag 00.
    if ((b[1] & 0xf6) === 0xf0) return 'aac';
    // MPEG-lyd (mp3): 11 bits synkronisering, gyldig version, lag, bitrate og samplerate.
    const version = (b[1] >> 3) & 3;
    const lag = (b[1] >> 1) & 3;
    const bitrate = b[2] >> 4;
    const samplerate = (b[2] >> 2) & 3;
    if ((b[1] & 0xe0) === 0xe0 && version !== 1 && lag !== 0 && bitrate !== 15 && samplerate !== 3) return 'mp3';
  }
  return null;
}

function mimeFor(fil, format) {
  const egen = String(fil.type || '').split(';')[0].trim().toLowerCase();
  return KENDTE_TYPER[egen] === format ? egen : MIME[format];
}

/** Varigheden i ms, læst af telefonen med et audio-element. null, når den ikke kan læses. */
export function laesVarighedIBrowser(fil) {
  return new Promise((ok) => {
    const url = URL.createObjectURL(fil);
    const lyd = document.createElement('audio');
    lyd.preload = 'metadata';
    const slut = (ms) => {
      lyd.onloadedmetadata = null;
      lyd.onerror = null;
      lyd.removeAttribute('src');
      lyd.load();
      URL.revokeObjectURL(url);
      ok(ms);
    };
    lyd.onloadedmetadata = () => slut(Number.isFinite(lyd.duration) && lyd.duration > 0 ? Math.round(lyd.duration * 1000) : null);
    lyd.onerror = () => slut(null);
    lyd.src = url;
  });
}

async function varighedMedGraense(laesVarighed, fil, ms) {
  let timer;
  try {
    const v = await Promise.race([
      Promise.resolve().then(() => laesVarighed(fil)),
      new Promise((ok) => { timer = setTimeout(() => ok(null), ms); }),
    ]);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kontrollerer filen, før den gemmes: lyd i et kendt format, højst MAKS_BYTES og, når varigheden kendes, højst MAKS_VARIGHED_MS.
 * Giver { ok: true, format, mime, varighedMs, bytes, filnavn } eller { ok: false, fejl }.
 * Ukendt varighed er tilladt (varighedMs er null).
 */
export async function kontrollerFil(fil, { laesVarighed = laesVarighedIBrowser, tidsgraenseMs = VARIGHED_TIDSGRAENSE_MS } = {}) {
  if (fil.size > MAKS_BYTES) return { ok: false, fejl: 'forStorFil' };
  let start;
  try {
    start = new Uint8Array(await fil.slice(0, 64).arrayBuffer());
  } catch {
    return { ok: false, fejl: 'filKanIkkeLaeses' };
  }
  const format = genkendFormat(start);
  if (!format) return { ok: false, fejl: 'ikkeLydfil' };
  const varighedMs = await varighedMedGraense(laesVarighed, fil, tidsgraenseMs);
  if (varighedMs !== null && varighedMs > MAKS_VARIGHED_MS) return { ok: false, fejl: 'forLang' };
  return { ok: true, format, mime: mimeFor(fil, format), varighedMs, bytes: fil.size, filnavn: fil.name || '' };
}

/** Filnavnet uden endelse, som forslag til navnet. */
export function navnUdenEndelse(navn) {
  const s = String(navn || '');
  const punkt = s.lastIndexOf('.');
  return punkt >= 0 ? s.slice(0, punkt) : s;
}

/** Bytes som MB med dansk komma, som telefonens Filer viser det: én decimal under 10 MB. */
export function formaterMB(bytes) {
  const mb = bytes / 1e6;
  return mb.toLocaleString('da-DK', { maximumFractionDigits: mb < 10 ? 1 : 0 });
}

// Samme navne som i sw.js, der lægger filen fra del-menuen her.
const DELT_CACHE = 'delt-lydfil';
const DELT_NOEGLE = 'delt-fil';

/**
 * En lydfil fra del-menuen på Android, som service workeren har lagt midlertidigt.
 * Giver { fil, fjern } eller null. fjern() kaldes først, når filen er gemt eller afvist.
 */
export async function hentDeltFil({ caches = globalThis.caches, adresse = globalThis.location?.href } = {}) {
  if (!caches) return null;
  const cache = await caches.open(DELT_CACHE);
  const noegle = new URL(DELT_NOEGLE, adresse).href;
  const svar = await cache.match(noegle);
  if (!svar) return null;
  const blob = await svar.blob();
  let navn = '';
  try {
    navn = decodeURIComponent(svar.headers.get('x-filnavn') || '');
  } catch { /* Et ødelagt navn giver standardnavnet. */ }
  // Del-menuen sender filen som multipart uden filens egen dato, så en delt fil får nu som optagedato.
  return {
    fil: new File([blob], navn || 'Delt lydfil', { type: blob.type }),
    fjern: () => cache.delete(noegle),
  };
}

/**
 * Gemmer filen som en note med lyden i stykker, byte for byte, før noget sendes. Noten er ikke navngivet.
 * Mens den gemmes, står den som optager med låsen holdt, så ingen anden fane sender en halv fil.
 * Går det galt, slettes det halvt gemte. Filen ligger stadig, hvor brugeren valgte den.
 * Kaster LydfilFejl ('pladsTom' eller 'filKanIkkeLaeses').
 */
export async function gemFil({ lager, fil, kontrol, titel = '', id = crypto.randomUUID(), laas, nu = Date.now }) {
  const frigiv = (await laas?.(LAAS_PRAEFIKS + id).catch(() => null)) ?? null;
  let oprettet = false;
  try {
    // Datoen i PDF og mail er, hvornår lyden blev optaget, ikke hvornår den blev uploadet.
    await lager.opretNote({ id, mime: kontrol.mime, titel, kilde: 'fil', filnavn: kontrol.filnavn, oprettet: optagetTid(fil, nu()) });
    oprettet = true;
    let gemt = 0;
    for (let nr = 0, fra = 0; fra < fil.size; nr++, fra += STYKKE_BYTES) {
      // Et Blob-udsnit, ikke bytes: browseren kopierer det til lageret på disk uden at læse det ind i
      // hukommelsen. Kan filen ikke læses, fejler skrivningen og giver filKanIkkeLaeses nedenfor.
      const stykke = fil.slice(fra, Math.min(fra + STYKKE_BYTES, fil.size));
      await lager.gemStykke(id, nr, stykke, 0);
      gemt += stykke.size;
    }
    if (gemt !== fil.size || gemt !== kontrol.bytes) throw new LydfilFejl('filKanIkkeLaeses');
    const felter = { status: STATUS.GEMT, bytes: gemt };
    if (Number.isFinite(kontrol.varighedMs)) felter.varighedMs = kontrol.varighedMs;
    await lager.opdaterNote(id, felter);
    return id;
  } catch (e) {
    if (oprettet) await lager.sletNote(id).catch(() => {});
    if (e instanceof LydfilFejl) throw e;
    throw new LydfilFejl(e?.name === 'QuotaExceededError' ? 'pladsTom' : 'filKanIkkeLaeses');
  } finally {
    frigiv?.();
  }
}

/** Optagedatoen: filens ændringsdato, når den er gyldig og ikke i fremtiden, ellers nu. */
function optagetTid(fil, nu) {
  const t = fil.lastModified;
  return Number.isSafeInteger(t) && t > 0 && t <= nu ? t : nu;
}

// Udfald, hvor kopien fra del-menuen ikke skal bruges igen: gemt, Annullér, eller en fejl, der ikke
// forsvinder ved at prøve igen. Ved fuldt lager og læsefejl bevares den, så brugeren kan prøve igen.
const FJERN_KOPI_EFTER = new Set(['gemt', 'annulleret', 'ikkeLydfil', 'forStorFil', 'forLang']);

/** Om den midlertidige kopi fra del-menuen skal fjernes efter dette udfald. */
export function fjernDeltKopi(udfald) {
  return FJERN_KOPI_EFTER.has(udfald);
}
