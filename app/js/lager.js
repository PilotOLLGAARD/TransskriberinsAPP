import { STATUS } from './tilstand.js';

// Optagelser fra mikrofonen gemmes som rå bytes (ArrayBuffer). En uploadet lydfil gemmes som Blob-udsnit
// af filen, så browseren lægger dem på disk, og en fil på flere hundrede MB aldrig skal ligge i hukommelsen.
// hentLyd og hentDele samler kun referencer til stykkerne. Bytes læses først, når lyden sendes.
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

/** oprettet er optagedatoen. En uploadet lydfil giver sin egen. Ellers er det nu. */
export async function opretNote({ id = crypto.randomUUID(), mime, titel = '', kilde, filnavn, oprettet }) {
  // Ingen type: AI'en vælger den, og svaret gemmer den på noten.
  const note = { id, mime, titel, status: STATUS.OPTAGER, oprettet: Number.isSafeInteger(oprettet) ? oprettet : Date.now() };
  // En lydfil, brugeren har valgt, i stedet for en optagelse.
  if (kilde === 'fil') Object.assign(note, { kilde, filnavn: String(filnavn ?? '') });
  await transaktion(NOTER, 'readwrite', (t) => t.objectStore(NOTER).add(note));
  return id;
}

/**
 * Gemmer et stykke lyd og stempler noten som aktiv, så andre faner kan se, at optagelsen kører.
 * del er nummeret på delen, når en afbrudt optagelse fortsættes. Dele sættes aldrig sammen.
 * bytes er en ArrayBuffer (mikrofon) eller en Blob (uploadet fil).
 */
export async function gemStykke(id, nr, bytes, del = 0) {
  await transaktion([NOTER, STYKKER], 'readwrite', (t) => {
    t.objectStore(STYKKER).put({ noteId: id, nr, bytes, del });
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

/** Én Blob pr. del i rækkefølge. Stykker fra før delene fandtes er del 0. */
export async function hentDele(id) {
  return transaktion([NOTER, STYKKER], 'readonly', (t, svar) => {
    const noteR = t.objectStore(NOTER).get(id);
    const stykkerR = t.objectStore(STYKKER).getAll(alleStykkerInterval(id));
    stykkerR.onsuccess = () => {
      const dele = new Map();
      for (const s of stykkerR.result) {
        const del = s.del ?? 0;
        if (!dele.has(del)) dele.set(del, []);
        dele.get(del).push(s.bytes);
      }
      const type = noteR.result?.mime || '';
      svar([...dele.keys()].sort((a, b) => a - b).map((d) => new Blob(dele.get(d), { type })));
    };
  });
}

const stoerrelseAf = (b) => (b instanceof Blob ? b.size : b.byteLength);

/**
 * En kilde til klipningen (app/js/opdeling/): { stoerrelse, laes(fra, til), udsnit(fra, til) } for én del af noten.
 * Stykkernes størrelser læses ét ad gangen, og laes/udsnit henter kun de stykker, der skal bruges, så en lang
 * optagelse aldrig ligger i hukommelsen på én gang.
 */
export async function lavKilde(id, del = 0) {
  // [{ nr, fra, til }] for delens stykker i rækkefølge.
  const stykker = await transaktion(STYKKER, 'readonly', (t, svar) => {
    const ud = [];
    let pos = 0;
    const r = t.objectStore(STYKKER).openCursor(alleStykkerInterval(id));
    r.onsuccess = () => {
      const c = r.result;
      if (!c) {
        svar(ud);
        return;
      }
      if ((c.value.del ?? 0) === del) {
        const str = stoerrelseAf(c.value.bytes);
        ud.push({ nr: c.value.nr, fra: pos, til: pos + str });
        pos += str;
      }
      c.continue();
    };
  });
  const stoerrelse = stykker.length ? stykker.at(-1).til : 0;

  /** Delene af [fra, til) som Blob-udsnit eller ArrayBuffer-udsnit. */
  async function dele(fra, til) {
    fra = Math.max(0, fra);
    til = Math.min(stoerrelse, til);
    const valgte = stykker.filter((s) => s.til > fra && s.fra < til);
    if (!valgte.length) return [];
    const poster = await transaktion(STYKKER, 'readonly', (t, svar) => {
      const r = t.objectStore(STYKKER).getAll(IDBKeyRange.bound([id, valgte[0].nr], [id, valgte.at(-1).nr]));
      r.onsuccess = () => svar(r.result);
    });
    const efterNr = new Map(poster.map((p) => [p.nr, p.bytes]));
    return valgte.map((s) => {
      const bytes = efterNr.get(s.nr);
      const a = Math.max(fra, s.fra) - s.fra;
      const b = Math.min(til, s.til) - s.fra;
      return bytes instanceof Blob ? bytes.slice(a, b) : new Uint8Array(bytes, a, b - a);
    });
  }

  return {
    stoerrelse,
    laes: async (fra, til) => new Uint8Array(await new Blob(await dele(fra, til)).arrayBuffer()),
    udsnit: async (fra, til) => new Blob(await dele(fra, til)),
  };
}

/** Det højeste stykkenummer på noten, eller -1 uden stykker. */
export async function hoejesteNr(id) {
  return transaktion(STYKKER, 'readonly', (t, svar) => {
    const r = t.objectStore(STYKKER).getAllKeys(alleStykkerInterval(id));
    r.onsuccess = () => svar(r.result.reduce((h, [, nr]) => Math.max(h, nr), -1));
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
