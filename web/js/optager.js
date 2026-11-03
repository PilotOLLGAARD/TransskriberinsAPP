import { STATUS } from './tilstand.js';
import { STANDARD_TYPE } from './typer.js';

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
const STOP_VENTETID_MS = 3000;
const LAGER_VENTETID_MS = 5000;
// Andre faner og den installerede app ser optagelsen som i gang, så længe denne lås holdes.
export const LAAS_PRAEFIKS = 'optag-';

export class OptageFejl extends Error {
  /** @param {'mikrofonNaegtet'|'kanIkkeOptage'} type */
  constructor(type) {
    super(type);
    this.type = type;
  }
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
 * Lyden gemmes, mens der optages. Ved en afbrydelse afsluttes optagelsen, så der ikke
 * opstår et hul, som brugeren ikke opdager.
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
    o.kaede = o.kaede.then(async () => {
      if (o.fuld) return;
      try {
        await lager.gemStykke(o.id, nr, await data.arrayBuffer());
        o.gemte++;
      } catch (e) {
        o.fuld = true;
        afslut(o, e?.name === 'QuotaExceededError' ? 'plads' : 'afbrudt');
      }
    });
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
    const ingenLyd = o.naesteNr === 0 && stopBekraeftet;
    const ingenPlads = o.fuld && o.gemte === 0;
    // Uden stop-melding kan lyden stadig være på vej, så noten beholdes.
    if (o.naesteNr === 0 && !stopBekraeftet) endelig = 'afbrudt';
    try {
      if (ingenLyd || ingenPlads) {
        await lager.sletNote(o.id);
        if (ingenLyd && endelig !== 'plads') endelig = 'tom';
        else if (ingenPlads) endelig = 'pladsTom';
      } else {
        const afbrudt = endelig === 'afbrudt' || endelig === 'plads';
        await lager.opdaterNote(o.id, { status: STATUS.GEMT, varighedMs: o.varighedMs, ...(afbrudt ? { afbrudt: true } : {}) });
      }
    } catch {
      // Noten står som optager og rettes ved næste start. Lyden er gemt.
    }
    if (aktiv === o) aktiv = null;
    o.frigivLaas?.();
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

    /** Navn og type valgt før optagelsen gemmes på noten med det samme. */
    async start({ titel = '', type = STANDARD_TYPE } = {}) {
      if (aktiv) return aktiv.id;
      const mime = vaelgFormat(medier.erUnderstoettet);
      if (!mime) throw new OptageFejl('kanIkkeOptage');

      let stream;
      try {
        stream = await medier.getUserMedia({ audio: LYDKRAV });
      } catch (e) {
        throw new OptageFejl(e?.name === 'NotAllowedError' ? 'mikrofonNaegtet' : 'kanIkkeOptage');
      }

      let recorder;
      const id = crypto.randomUUID();
      let frigivLaas = null;
      try {
        recorder = medier.lavRecorder(stream, { mimeType: mime, audioBitsPerSecond: BITRATE });
        // Låsen tages, før noten findes, så en anden fane aldrig ser optagelsen uden lås.
        frigivLaas = (await medier.laas?.(LAAS_PRAEFIKS + id)) ?? null;
        await lager.opretNote({ id, mime: recorder.mimeType || mime, titel, type });
      } catch {
        frigivLaas?.();
        stopSpor(stream);
        throw new OptageFejl('kanIkkeOptage');
      }

      const o = { id, frigivLaas, stream, recorder, naesteNr: 0, gemte: 0, kaede: Promise.resolve(), sidsteStykke: ur.nu(), startet: ur.nu(), fuld: false };

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
        await lager.sletNote(id).catch(() => {});
        frigivLaas?.();
        throw new OptageFejl('kanIkkeOptage');
      }

      aktiv = o;
      o.vedSynlighed = () => {
        if (medier.dokument.visibilityState !== 'visible') return;
        if (ur.nu() - o.sidsteStykke > MAKS_HUL_MS) afslut(o, 'afbrudt');
        else tagSkaermlaas(o);
      };
      medier.dokument.addEventListener('visibilitychange', o.vedSynlighed);
      o.advarselTimer = ur.saetTimeout(() => vedAdvaret('snartSlut'), ADVARSEL_MS);
      o.maksTimer = ur.saetTimeout(() => afslut(o, 'maks'), MAKS_MS);
      o.vagtTimer = ur.saetTimeout(() => vagt(o), VAGT_MS);

      // Ventes der på skærmlåsen, kan en langsom telefon nå at afslutte optagelsen, før skærmen skifter.
      tagSkaermlaas(o);
      return id;
    },

    async stop() {
      const o = aktiv;
      if (!o) return null;
      await afslut(o, 'stop');
      return o.id;
    },

    erAktiv: () => Boolean(aktiv),
    aktivId: () => aktiv?.id ?? null,
  };
}
