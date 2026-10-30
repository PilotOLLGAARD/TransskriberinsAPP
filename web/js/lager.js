import { STATUS } from './tilstand.js';

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
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fejl(r.error);
  });
  return dbLoefte;
}

function transaktion(db, lagre, tilstand, arbejde) {
  return new Promise((ok, fejl) => {
    const t = db.transaction(lagre, tilstand);
    let resultat;
    t.oncomplete = () => ok(resultat);
    t.onerror = () => fejl(t.error);
    t.onabort = () => fejl(t.error);
    arbejde(t, (r) => { resultat = r; });
  });
}

function alleStykkerInterval(id) {
  return IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
}

export async function opretNote({ mime }) {
  const id = crypto.randomUUID();
  const note = { id, mime, status: STATUS.OPTAGER, oprettet: Date.now() };
  await transaktion(await aabn(), NOTER, 'readwrite', (t) => t.objectStore(NOTER).add(note));
  return id;
}

export async function gemStykke(id, nr, bytes) {
  await transaktion(await aabn(), STYKKER, 'readwrite', (t) => t.objectStore(STYKKER).put({ noteId: id, nr, bytes }));
}

export async function hentLyd(id) {
  const db = await aabn();
  return transaktion(db, [NOTER, STYKKER], 'readonly', (t, svar) => {
    const noteR = t.objectStore(NOTER).get(id);
    const stykkerR = t.objectStore(STYKKER).getAll(alleStykkerInterval(id));
    stykkerR.onsuccess = () => {
      svar(new Blob(stykkerR.result.map((s) => s.bytes), { type: noteR.result?.mime || '' }));
    };
  });
}

export async function hentNote(id) {
  return transaktion(await aabn(), NOTER, 'readonly', (t, svar) => {
    const r = t.objectStore(NOTER).get(id);
    r.onsuccess = () => svar(r.result ?? null);
  });
}

export async function opdaterNote(id, felter) {
  await transaktion(await aabn(), NOTER, 'readwrite', (t) => {
    const s = t.objectStore(NOTER);
    const r = s.get(id);
    r.onsuccess = () => {
      if (r.result) s.put({ ...r.result, ...felter });
    };
  });
}

export async function alleNoter() {
  return transaktion(await aabn(), NOTER, 'readonly', (t, svar) => {
    const r = t.objectStore(NOTER).getAll();
    r.onsuccess = () => svar(r.result.sort((a, b) => b.oprettet - a.oprettet));
  });
}

export async function sletNote(id) {
  await transaktion(await aabn(), [NOTER, STYKKER], 'readwrite', (t) => {
    t.objectStore(NOTER).delete(id);
    t.objectStore(STYKKER).delete(alleStykkerInterval(id));
  });
}
