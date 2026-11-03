import { STATUS } from './tilstand.js';
import { STANDARD_TYPE } from './typer.js';

// Lyd gemmes som rå bytes, ikke som Blob: iOS Safari kan miste adgangen til Blobs i IndexedDB.
const DB_NAVN = 'transskribering';
const NOTER = 'noter';
const STYKKER = 'stykker';

let dbLoefte = null;

export function aabn() {
  dbLoefte ||= new Promise((ok, fejl) => {
    const r = indexedDB.open(DB_NAVN, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(NOTER, { keyPath: 'id' });
      r.result.createObjectStore(STYKKER, { keyPath: ['noteId', 'nr'] });
    };
    r.onsuccess = () => {
      const db = r.result;
      // iOS kan lukke forbindelsen, mens appen ligger i baggrunden.
      db.onclose = () => { dbLoefte = null; };
      db.onversionchange = () => { db.close(); dbLoefte = null; };
      ok(db);
    };
    r.onerror = () => {
      dbLoefte = null;
      fejl(r.error);
    };
  });
  return dbLoefte;
}

function enTransaktion(db, lagre, tilstand, arbejde) {
  return new Promise((ok, fejl) => {
    const t = db.transaction(lagre, tilstand);
    let resultat;
    t.oncomplete = () => ok(resultat);
    t.onerror = () => fejl(t.error);
    t.onabort = () => fejl(t.error ?? new DOMException('afbrudt', 'AbortError'));
    arbejde(t, (r) => { resultat = r; });
  });
}

/** Prøver én gang til på en ny forbindelse, medmindre lageret er fuldt. */
async function transaktion(lagre, tilstand, arbejde) {
  try {
    return await enTransaktion(await aabn(), lagre, tilstand, arbejde);
  } catch (e) {
    if (e?.name === 'QuotaExceededError') throw e;
    dbLoefte = null;
    return enTransaktion(await aabn(), lagre, tilstand, arbejde);
  }
}

function alleStykkerInterval(id) {
  return IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
}

export async function opretNote({ id = crypto.randomUUID(), mime, titel = '', type = STANDARD_TYPE }) {
  const note = { id, mime, titel, type, status: STATUS.OPTAGER, oprettet: Date.now() };
  await transaktion(NOTER, 'readwrite', (t) => t.objectStore(NOTER).add(note));
  return id;
}

/** Gemmer et stykke lyd og stempler noten som aktiv, så andre faner kan se, at optagelsen kører. */
export async function gemStykke(id, nr, bytes) {
  await transaktion([NOTER, STYKKER], 'readwrite', (t) => {
    t.objectStore(STYKKER).put({ noteId: id, nr, bytes });
    const noter = t.objectStore(NOTER);
    const r = noter.get(id);
    r.onsuccess = () => {
      if (r.result) noter.put({ ...r.result, sidstAktiv: Date.now() });
    };
  });
}

export async function hentLyd(id) {
  return transaktion([NOTER, STYKKER], 'readonly', (t, svar) => {
    const noteR = t.objectStore(NOTER).get(id);
    const stykkerR = t.objectStore(STYKKER).getAll(alleStykkerInterval(id));
    stykkerR.onsuccess = () => {
      svar(new Blob(stykkerR.result.map((s) => s.bytes), { type: noteR.result?.mime || '' }));
    };
  });
}

export async function hentNote(id) {
  return transaktion(NOTER, 'readonly', (t, svar) => {
    const r = t.objectStore(NOTER).get(id);
    r.onsuccess = () => svar(r.result ?? null);
  });
}

export async function opdaterNote(id, felter) {
  await transaktion(NOTER, 'readwrite', (t) => {
    const s = t.objectStore(NOTER);
    const r = s.get(id);
    r.onsuccess = () => {
      if (r.result) s.put({ ...r.result, ...felter });
    };
  });
}

export async function alleNoter() {
  return transaktion(NOTER, 'readonly', (t, svar) => {
    const r = t.objectStore(NOTER).getAll();
    r.onsuccess = () => svar(r.result.sort((a, b) => b.oprettet - a.oprettet));
  });
}

/** Sletter lyden, men beholder noten med referat og PDF. */
export async function sletLyd(id) {
  await transaktion(STYKKER, 'readwrite', (t) => t.objectStore(STYKKER).delete(alleStykkerInterval(id)));
}

export async function sletNote(id) {
  await transaktion([NOTER, STYKKER], 'readwrite', (t) => {
    t.objectStore(NOTER).delete(id);
    t.objectStore(STYKKER).delete(alleStykkerInterval(id));
  });
}
