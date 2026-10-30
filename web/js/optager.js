import { STATUS } from './tilstand.js';

// AAC først: det er iPhones eget format. Chrome kan lægge Opus i mp4, så webm går før uspecificeret mp4.
const FORMATER = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/mp4'];
// Telefonens lydbehandling er slået fra, så lydkvaliteten ikke ændres.
const LYDKRAV = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
const BITRATE = 128000;
const STYKKE_MS = 5000;
const MAKS_HUL_MS = 15000;
const ADVARSEL_MS = 55 * 60 * 1000;
const MAKS_MS = 59 * 60 * 1000;
const STOP_VENTETID_MS = 3000;

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
    dokument: document,
  };
}

const standardUr = {
  nu: () => Date.now(),
  saetTimeout: (fn, ms) => setTimeout(fn, ms),
  ryd: (t) => clearTimeout(t),
};

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
      o.laas = await medier.skaermlaas();
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

  function ventPaaStop(o) {
    return new Promise((ok) => {
      const timer = ur.saetTimeout(ok, STOP_VENTETID_MS);
      o.recorder.addEventListener('stop', () => { ur.ryd(timer); ok(); }, { once: true });
      if (o.recorder.state === 'inactive') { ur.ryd(timer); ok(); return; }
      try {
        o.recorder.stop();
      } catch {
        ur.ryd(timer);
        ok();
      }
    });
  }

  function afslut(o, grund) {
    o.afslutter ||= (async () => {
      o.grund = grund;
      ur.ryd(o.advarselTimer);
      ur.ryd(o.maksTimer);
      medier.dokument.removeEventListener('visibilitychange', o.vedSynlighed);
      await ventPaaStop(o);
      for (const spor of o.stream.getTracks()) spor.stop();
      await o.kaede;
      try {
        await o.laas?.release();
      } catch { /* Skærmlåsen er allerede frigivet. */ }

      let endelig = o.grund;
      try {
        if (o.gemte === 0) {
          await lager.sletNote(o.id);
          if (endelig !== 'plads') endelig = 'tom';
        } else {
          const afbrudt = o.grund === 'afbrudt' || o.grund === 'plads';
          await lager.opdaterNote(o.id, { status: STATUS.GEMT, ...(afbrudt ? { afbrudt: true } : {}) });
        }
      } catch {
        // Noten står som optager og rettes ved næste start. Lyden er gemt.
      }
      if (aktiv === o) aktiv = null;
      vedAfsluttet({ id: o.id, grund: endelig });
    })();
    return o.afslutter;
  }

  return {
    naarAfsluttet(fn) { vedAfsluttet = fn; },
    naarAdvaret(fn) { vedAdvaret = fn; },

    async start() {
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
      try {
        recorder = medier.lavRecorder(stream, { mimeType: mime, audioBitsPerSecond: BITRATE });
      } catch {
        for (const spor of stream.getTracks()) spor.stop();
        throw new OptageFejl('kanIkkeOptage');
      }

      const id = await lager.opretNote({ mime: recorder.mimeType || mime });
      const o = { id, stream, recorder, naesteNr: 0, gemte: 0, kaede: Promise.resolve(), sidsteStykke: ur.nu(), fuld: false };
      aktiv = o;

      recorder.addEventListener('dataavailable', (e) => gemData(o, e.data));
      recorder.addEventListener('error', () => afslut(o, 'afbrudt'));
      for (const spor of stream.getTracks()) {
        spor.addEventListener('mute', () => afslut(o, 'afbrudt'));
        spor.addEventListener('ended', () => afslut(o, 'afbrudt'));
      }
      o.vedSynlighed = () => {
        if (medier.dokument.visibilityState !== 'visible') return;
        if (ur.nu() - o.sidsteStykke > MAKS_HUL_MS) afslut(o, 'afbrudt');
        else tagSkaermlaas(o);
      };
      medier.dokument.addEventListener('visibilitychange', o.vedSynlighed);
      o.advarselTimer = ur.saetTimeout(() => vedAdvaret('snartSlut'), ADVARSEL_MS);
      o.maksTimer = ur.saetTimeout(() => afslut(o, 'maks'), MAKS_MS);

      recorder.start(STYKKE_MS);
      await tagSkaermlaas(o);
      return id;
    },

    async stop() {
      const o = aktiv;
      if (!o) return null;
      await afslut(o, 'stop');
      return o.id;
    },

    erAktiv: () => Boolean(aktiv),
  };
}
