import { STATUS } from './tilstand.js';

// AAC først: det er iPhones eget format. Chrome kan lægge Opus i mp4, så webm går før uspecificeret mp4.
const FORMATER = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/mp4'];
// Telefonens lydbehandling er slået fra, så lydkvaliteten ikke ændres.
const LYDKRAV = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
const BITRATE = 128000;
const STYKKE_MS = 5000;
const MAKS_HUL_MS = 15000;
const VAGT_MS = 5000;
const ADVARSEL_MS = 55 * 60 * 1000;
const MAKS_MS = 59 * 60 * 1000;
// Højst så mange dele på én note. Alle dele tilsammen højst MAKS_MS.
const MAKS_DELE = 20;
const STOP_VENTETID_MS = 3000;
const LAGER_VENTETID_MS = 5000;
// Pauser før genforsøg, når et stykke ikke kunne gemmes. Et stop venter højst LAGER_VENTETID_MS på dem;
// et genforsøg, der når længere, gemmes stadig, og låsen holdes til da (se frigivLaasNaarGemt).
const GENFORSOEG_PAUSER_MS = [300, 1000];
const LAAS_MAKS_MS = 30000;
// Andre faner og den installerede app ser optagelsen som i gang, så længe denne lås holdes.
export const LAAS_PRAEFIKS = 'optag-';

export class OptageFejl extends Error {
  /** @param {'mikrofonNaegtet'|'kanIkkeOptage'|'ingenFlereDele'|'plads'|'pladsTom'} type */
  constructor(type) {
    super(type);
    this.type = type;
  }
}

/** Viser en notifikation via service workeren, hvis brugeren har givet lov. Giver true, hvis den blev vist. */
export async function visAdvarsel(tekst, { notifikation = globalThis.Notification, serviceWorker = globalThis.navigator?.serviceWorker } = {}) {
  if (notifikation?.permission !== 'granted') return false;
  try {
    const reg = await serviceWorker?.ready;
    if (!reg) return false;
    await reg.showNotification('Transskribering', { body: tekst, tag: 'optagelse-stoppet' });
    return true;
  } catch {
    return false;
  }
}

/** Beder om lov til notifikationer, når det ikke er afgjort. Skal kaldes ved et tryk. */
export async function bedOmTilladelse({ notifikation = globalThis.Notification } = {}) {
  if (notifikation?.permission !== 'default') return;
  try {
    await notifikation.requestPermission();
  } catch { /* Ingen notifikation, men optagelsen virker som før. */ }
}

export function vaelgFormat(erUnderstoettet) {
  return FORMATER.find((f) => erUnderstoettet(f)) ?? null;
}

export function browserMedier() {
  return {
    getUserMedia: (krav) => {
      if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('mangler', 'NotSupportedError');
      return navigator.mediaDevices.getUserMedia(krav);
    },
    lavRecorder: (stream, valg) => new MediaRecorder(stream, valg),
    erUnderstoettet: (mime) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime),
    skaermlaas: () => navigator.wakeLock.request('screen'),
    /** Giver en funktion, der frigiver låsen, når den er taget. Uden Web Locks gives null. */
    laas: (navn) => new Promise((tildelt) => {
      if (!navigator.locks?.request) { tildelt(null); return; }
      navigator.locks.request(navn, () => new Promise((frigiv) => tildelt(frigiv))).catch(() => tildelt(null));
    }),
    dokument: document,
  };
}

const standardUr = {
  nu: () => Date.now(),
  saetTimeout: (fn, ms) => setTimeout(fn, ms),
  ryd: (t) => clearTimeout(t),
};

function stopSpor(stream) {
  for (const spor of stream.getTracks()) spor.stop();
}

/**
 * Lyden gemmes, mens der optages. Ved en afbrydelse afsluttes delen, så der ikke opstår et hul,
 * som brugeren ikke opdager. En afbrudt optagelse kan fortsættes som en ny del på samme note.
 */
export function lavOptager({ lager, medier, ur = standardUr }) {
  let aktiv = null;
  let vedAfsluttet = () => {};
  let vedAdvaret = () => {};

  async function tagSkaermlaas(o) {
    if (o.laas && o.laas.released === false) return;
    try {
      const laas = await medier.skaermlaas();
      if (o.afsluttet) await laas.release();
      else o.laas = laas;
    } catch {
      // Ikke alle telefoner tillader det. Optagelsen kører videre.
    }
  }

  function gemData(o, data) {
    if (!data || !data.size || o.fuld) return;
    const nr = o.naesteNr++;
    o.sidsteStykke = ur.nu();
    o.ventende++;
    o.kaede = o.kaede.then(async () => {
      if (o.fuld) return;
      try {
        const bytes = await data.arrayBuffer();
        await gemMedGenforsoeg(o.id, nr, bytes, o.del);
        o.gemte++;
      } catch (e) {
        o.fuld = true;
        o.lagerFejl = e?.name === 'QuotaExceededError' ? 'plads' : 'fejl';
        afslut(o, o.lagerFejl === 'plads' ? 'plads' : 'afbrudt');
      }
    }).finally(() => { o.ventende--; });
  }

  /**
   * Låsen frigives først, når de sidste stykker er gemt eller opgivet. Ellers kunne Fortsæt læse det
   * højeste stykkenummer, før et sent stykke er skrevet, og senere overskrive det. En skrivning,
   * der aldrig bliver færdig, holder dog højst låsen i LAAS_MAKS_MS.
   */
  function frigivLaasNaarGemt(o) {
    if (!o.frigivLaas) return;
    if (o.ventende === 0) {
      o.frigivLaas();
      return;
    }
    let frigivet = false;
    const frigiv = () => {
      if (frigivet) return;
      frigivet = true;
      ur.ryd(timer);
      o.frigivLaas();
    };
    const timer = ur.saetTimeout(frigiv, LAAS_MAKS_MS);
    o.kaede.then(frigiv);
  }

  /**
   * Fuldt lager er endeligt. Andre fejl kan være forbigående (fx når iPhone et øjeblik mister forbindelsen
   * til lageret), så samme stykke prøves igen. Det er sikkert: stykket gemmes under samme nøgle.
   * Optagelsen kører videre imens, og de næste stykker venter i kæden, så rækkefølgen bevares.
   */
  async function gemMedGenforsoeg(id, nr, bytes, del) {
    for (let forsoeg = 0; ; forsoeg++) {
      try {
        await lager.gemStykke(id, nr, bytes, del);
        return;
      } catch (e) {
        if (e?.name === 'QuotaExceededError' || forsoeg >= GENFORSOEG_PAUSER_MS.length) throw e;
        await new Promise((ok) => ur.saetTimeout(ok, GENFORSOEG_PAUSER_MS[forsoeg]));
      }
    }
  }

  /** Giver true, hvis optageren selv meldte stop. Sene stykker gemmes også bagefter. */
  function ventPaaStop(o) {
    return new Promise((ok) => {
      if (o.recorder.state === 'inactive') { ok(true); return; }
      const timer = ur.saetTimeout(() => ok(false), STOP_VENTETID_MS);
      o.recorder.addEventListener('stop', () => { ur.ryd(timer); ok(true); }, { once: true });
      try {
        o.recorder.stop();
      } catch {
        ur.ryd(timer);
        ok(false);
      }
    });
  }

  function ventPaaLager(o) {
    return new Promise((ok) => {
      const timer = ur.saetTimeout(ok, LAGER_VENTETID_MS);
      o.kaede.then(() => { ur.ryd(timer); ok(); });
    });
  }

  async function fuldfoer(o) {
    ur.ryd(o.advarselTimer);
    ur.ryd(o.maksTimer);
    ur.ryd(o.vagtTimer);
    medier.dokument.removeEventListener('visibilitychange', o.vedSynlighed);

    const stopBekraeftet = await ventPaaStop(o);
    stopSpor(o.stream);
    await ventPaaLager(o);
    o.afsluttet = true;
    try {
      await o.laas?.release();
    } catch { /* Skærmlåsen er allerede frigivet. */ }

    let endelig = o.grund;
    const delUdenLyd = o.naesteNr === o.foersteNr;
    const ingenLyd = delUdenLyd && stopBekraeftet;
    const ingenPlads = o.fuld && o.gemte === 0;
    // Uden stop-melding kan lyden stadig være på vej, så noten beholdes.
    if (delUdenLyd && !stopBekraeftet) endelig = 'afbrudt';
    try {
      if (o.ny && (ingenLyd || ingenPlads)) {
        await lager.sletNote(o.id);
        if (ingenLyd && endelig !== 'plads') endelig = 'tom';
        else if (ingenPlads) endelig = o.lagerFejl === 'plads' ? 'pladsTom' : 'lagerTom';
      } else if (!o.ny && (ingenLyd || ingenPlads)) {
        // Noten har lyd fra de tidligere dele og slettes aldrig. Den tomme del tælles ikke med.
        if (ingenLyd && endelig === 'stop') endelig = 'tom';
        await lager.opdaterNote(o.id, { status: STATUS.GEMT, dele: o.del, varighedMs: o.tidligereMs, afbrudt: true });
      } else {
        const afbrudt = endelig === 'afbrudt' || endelig === 'plads';
        const felter = { status: STATUS.GEMT, varighedMs: o.tidligereMs + o.varighedMs };
        if (afbrudt) felter.afbrudt = true;
        else if (!o.ny) felter.afbrudt = false;
        await lager.opdaterNote(o.id, felter);
      }
    } catch {
      // Noten står som optager og rettes ved næste start. Lyden er gemt.
    }
    if (aktiv === o) aktiv = null;
    frigivLaasNaarGemt(o);
    vedAfsluttet({ id: o.id, grund: endelig });
  }

  function afslut(o, grund) {
    if (o.afslutter) return o.afslutter;
    o.grund = grund;
    o.varighedMs = ur.nu() - o.startet;
    o.afslutter = Promise.resolve().then(() => fuldfoer(o));
    return o.afslutter;
  }

  function vagt(o) {
    if (ur.nu() - o.sidsteStykke > MAKS_HUL_MS) {
      afslut(o, 'afbrudt');
      return;
    }
    o.vagtTimer = ur.saetTimeout(() => vagt(o), VAGT_MS);
  }

  return {
    naarAfsluttet(fn) { vedAfsluttet = fn; },
    naarAdvaret(fn) { vedAdvaret = fn; },

    /** Navnet valgt før optagelsen gemmes på noten med det samme. */
    async start({ titel = '' } = {}) {
      if (aktiv) return aktiv.id;
      const id = crypto.randomUUID();
      return begynd({
        id, ny: true,
        klargoer: async (mime) => {
          await lager.opretNote({ id, mime, titel });
          return { del: 0, foersteNr: 0, tidligereMs: 0 };
        },
        fortryd: () => lager.sletNote(id),
      });
    },

    /**
     * Optager en ny del på en gemt, afbrudt note. Noten læses igen, når låsen er taget,
     * så to faner, der trykker samtidig, aldrig bruger samme del eller stykkenumre.
     */
    async fortsaet(id) {
      if (aktiv) return aktiv.id;
      const kanFortsaettes = async () => {
        const note = await lager.hentNote(id).catch(() => null);
        if (!note || note.status !== STATUS.GEMT) throw new OptageFejl('kanIkkeOptage');
        const del = note.dele ?? 1;
        const tidligereMs = note.varighedMs ?? 0;
        if (del >= MAKS_DELE || tidligereMs >= MAKS_MS) throw new OptageFejl('ingenFlereDele');
        return { del, tidligereMs };
      };
      await kanFortsaettes();
      let del;
      return begynd({
        id, ny: false,
        klargoer: async () => {
          const frisk = await kanFortsaettes();
          del = frisk.del;
          await lager.opdaterNote(id, { status: STATUS.OPTAGER, dele: del + 1 });
          return { ...frisk, foersteNr: (await lager.hoejesteNr(id)) + 1 };
        },
        fortryd: () => lager.opdaterNote(id, { status: STATUS.GEMT, dele: del }),
      });
    },

    async stop() {
      const o = aktiv;
      if (!o) return null;
      await afslut(o, 'stop');
      return o.id;
    },

    erAktiv: () => Boolean(aktiv),
    aktivId: () => aktiv?.id ?? null,
    /** Grunden, hvis optagelsen er ved at blive afsluttet ('stop', 'afbrudt', 'maks' …), ellers null. */
    afsluttesMed: () => (aktiv?.afslutter ? aktiv.grund : null),
  };

  /**
   * Starter en del. klargoer opretter eller genåbner noten, efter låsen er taget, og giver
   * { del, foersteNr, tidligereMs }. fortryd sletter eller genåbner den igen, hvis optageren ikke kan starte.
   */
  async function begynd({ id, ny, klargoer, fortryd }) {
      const mime = vaelgFormat(medier.erUnderstoettet);
      if (!mime) throw new OptageFejl('kanIkkeOptage');

      let stream;
      try {
        stream = await medier.getUserMedia({ audio: LYDKRAV });
      } catch (e) {
        throw new OptageFejl(e?.name === 'NotAllowedError' ? 'mikrofonNaegtet' : 'kanIkkeOptage');
      }

      let recorder;
      let frigivLaas = null;
      let del;
      let foersteNr;
      let tidligereMs;
      try {
        recorder = medier.lavRecorder(stream, { mimeType: mime, audioBitsPerSecond: BITRATE });
        // Låsen tages, før noten findes, så en anden fane aldrig ser optagelsen uden lås.
        frigivLaas = (await medier.laas?.(LAAS_PRAEFIKS + id)) ?? null;
        ({ del, foersteNr, tidligereMs } = await klargoer(recorder.mimeType || mime));
      } catch (e) {
        frigivLaas?.();
        stopSpor(stream);
        if (e instanceof OptageFejl) throw e;
        // Fuldt lager: En ny optagelse har intet gemt. En fortsat har stadig lyden fra de tidligere dele.
        if (e?.name === 'QuotaExceededError') throw new OptageFejl(ny ? 'pladsTom' : 'plads');
        throw new OptageFejl('kanIkkeOptage');
      }

      const o = {
        id, ny, del, foersteNr, tidligereMs, frigivLaas, stream, recorder, naesteNr: foersteNr, gemte: 0, ventende: 0,
        kaede: Promise.resolve(), sidsteStykke: ur.nu(), startet: ur.nu(), fuld: false,
      };

      recorder.addEventListener('dataavailable', (e) => gemData(o, e.data));
      recorder.addEventListener('error', () => afslut(o, 'afbrudt'));
      recorder.addEventListener('stop', () => afslut(o, 'afbrudt'));
      for (const spor of stream.getTracks()) {
        spor.addEventListener('mute', () => afslut(o, 'afbrudt'));
        spor.addEventListener('ended', () => afslut(o, 'afbrudt'));
      }

      try {
        recorder.start(STYKKE_MS);
      } catch {
        o.afslutter = Promise.resolve();
        stopSpor(stream);
        await Promise.resolve().then(fortryd).catch(() => {});
        frigivLaas?.();
        throw new OptageFejl('kanIkkeOptage');
      }

      aktiv = o;
      // Låses telefonen eller skiftes app, kan mikrofonen give stilhed uden fejl. Delen afsluttes straks.
      o.vedSynlighed = () => {
        if (medier.dokument.visibilityState === 'visible') {
          tagSkaermlaas(o);
          return;
        }
        // Notifikationen vises af appen, som også ser afbrydelser, der kommer før dette signal.
        afslut(o, 'afbrudt');
      };
      medier.dokument.addEventListener('visibilitychange', o.vedSynlighed);
      o.advarselTimer = ur.saetTimeout(() => vedAdvaret('snartSlut'), Math.max(0, ADVARSEL_MS - tidligereMs));
      o.maksTimer = ur.saetTimeout(() => afslut(o, 'maks'), Math.max(0, MAKS_MS - tidligereMs));
      o.vagtTimer = ur.saetTimeout(() => vagt(o), VAGT_MS);

      // Ventes der på skærmlåsen, kan en langsom telefon nå at afslutte optagelsen, før skærmen skifter.
      tagSkaermlaas(o);
      return id;
  }
}
