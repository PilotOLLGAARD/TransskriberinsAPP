import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lavOptager, vaelgFormat } from '../js/optager.js';

const MINUT = 60 * 1000;

function falskLager({ fejlFraStykke = Infinity, haengFraStykke = Infinity } = {}) {
  const l = {
    noter: new Map(),
    stykker: [],
    async opretNote({ mime }) {
      const id = `note-${l.noter.size + 1}`;
      l.noter.set(id, { id, mime, status: 'optager' });
      return id;
    },
    async gemStykke(id, nr, bytes) {
      if (nr >= fejlFraStykke) throw new DOMException('fuld', 'QuotaExceededError');
      if (nr >= haengFraStykke) await new Promise(() => {});
      l.stykker.push({ id, nr, bytes });
    },
    async opdaterNote(id, felter) {
      Object.assign(l.noter.get(id), felter);
    },
    async sletNote(id) {
      l.noter.delete(id);
    },
  };
  return l;
}

class FalskRecorder extends EventTarget {
  constructor(stream, valg) {
    super();
    this.stream = stream;
    this.valg = valg;
    this.state = 'inactive';
    this.mimeType = valg.mimeType;
    this.slutStykke = true;
  }
  start(interval) {
    if (FalskRecorder.startFejl) throw FalskRecorder.startFejl;
    this.interval = interval;
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    if (this.slutStykke) this.send('slut');
    this.dispatchEvent(new Event('stop'));
  }
  send(tekst) {
    const bytes = new TextEncoder().encode(tekst).buffer;
    const e = new Event('dataavailable');
    e.data = { size: bytes.byteLength, arrayBuffer: async () => bytes };
    this.dispatchEvent(e);
  }
}

class FalskSpor extends EventTarget {
  stop() { this.stoppet = true; }
}

function opsaet({ lager = falskLager(), understoettet = () => true, skaermlaas } = {}) {
  const spor = new FalskSpor();
  const tilstand = {
    tid: 0,
    timere: [],
    laase: 0,
    frigivet: 0,
  };
  const dokument = new EventTarget();
  dokument.visibilityState = 'visible';
  const medier = {
    getUserMedia: async (krav) => {
      tilstand.krav = krav;
      if (tilstand.mikrofonFejl) throw tilstand.mikrofonFejl;
      return { getTracks: () => [spor] };
    },
    lavRecorder: (stream, valg) => { tilstand.recorder = new FalskRecorder(stream, valg); return tilstand.recorder; },
    erUnderstoettet: understoettet,
    skaermlaas: skaermlaas || (async () => {
      tilstand.laase++;
      return { release: async () => { tilstand.frigivet++; } };
    }),
    dokument,
  };
  const ur = {
    nu: () => tilstand.tid,
    saetTimeout: (fn, ms) => {
      const t = { fn, tid: tilstand.tid + ms };
      tilstand.timere.push(t);
      return t;
    },
    ryd: (t) => { tilstand.timere = tilstand.timere.filter((x) => x !== t); },
  };
  const skrid = (ms) => {
    tilstand.tid += ms;
    for (const t of tilstand.timere.filter((x) => x.tid <= tilstand.tid)) {
      tilstand.timere = tilstand.timere.filter((x) => x !== t);
      t.fn();
    }
  };
  const optager = lavOptager({ lager, medier, ur });
  const afsluttet = [];
  const advarsler = [];
  optager.naarAfsluttet((a) => afsluttet.push(a));
  optager.naarAdvaret((a) => advarsler.push(a));
  // Optager videre med et stykke hvert 5. sekund, så vagthunden ikke griber ind.
  const skridMedLyd = (ms) => {
    for (let rest = ms; rest > 0; rest -= 5000) {
      skrid(Math.min(5000, rest));
      if (tilstand.recorder.state === 'recording') tilstand.recorder.send('x');
    }
  };
  const venTilAfsluttet = async () => {
    for (let i = 0; i < 50 && !afsluttet.length; i++) await new Promise((ok) => setTimeout(ok, 1));
    return afsluttet[0];
  };
  return { lager, optager, tilstand, spor, dokument, skrid, skridMedLyd, afsluttet, advarsler, venTilAfsluttet };
}

test('vælger mp4 når muligt', () => {
  assert.match(vaelgFormat(() => true), /^audio\/mp4/);
});

test('vælger webm på Android uden AAC', () => {
  assert.equal(vaelgFormat((m) => m.startsWith('audio/webm')), 'audio/webm;codecs=opus');
});

test('vælger AAC før webm, webm før mp4 uden AAC', () => {
  assert.equal(vaelgFormat((m) => m === 'audio/mp4;codecs=mp4a.40.2' || m.startsWith('audio/webm')), 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(vaelgFormat((m) => m === 'audio/mp4' || m.startsWith('audio/webm')), 'audio/webm;codecs=opus');
  assert.equal(vaelgFormat((m) => m === 'audio/mp4'), 'audio/mp4');
});

test('intet format giver null', () => {
  assert.equal(vaelgFormat(() => false), null);
});

test('åbner mikrofon uden behandling', async () => {
  const s = opsaet();
  await s.optager.start();
  assert.deepEqual(s.tilstand.krav.audio, { echoCancellation: false, noiseSuppression: false, autoGainControl: false });
});

test('optager med fast bitrate og stykker hvert 5. sekund', async () => {
  const s = opsaet();
  await s.optager.start();
  assert.equal(s.tilstand.recorder.valg.audioBitsPerSecond, 128000);
  assert.equal(s.tilstand.recorder.interval, 5000);
});

test('gemmer hvert stykke straks', async () => {
  const s = opsaet();
  const id = await s.optager.start();
  s.tilstand.recorder.send('a');
  s.tilstand.recorder.send('b');
  await new Promise((ok) => setTimeout(ok, 5));
  assert.deepEqual(s.lager.stykker.map((x) => [x.id, x.nr]), [[id, 0], [id, 1]]);
  assert.equal(new TextDecoder().decode(s.lager.stykker[1].bytes), 'b');
});

test('stop afslutter med grund stop og status gemt', async () => {
  const s = opsaet();
  const id = await s.optager.start();
  s.tilstand.recorder.send('a');
  assert.equal(await s.optager.stop(), id);
  assert.deepEqual(s.afsluttet, [{ id, grund: 'stop' }]);
  assert.equal(s.lager.noter.get(id).status, 'gemt');
  assert.equal(s.lager.stykker.length, 2);
  assert.ok(s.spor.stoppet);
  assert.equal(s.tilstand.frigivet, 1);
});

test('afslutter ved mute', async () => {
  const s = opsaet();
  const id = await s.optager.start();
  s.tilstand.recorder.send('a');
  s.spor.dispatchEvent(new Event('mute'));
  const a = await s.venTilAfsluttet();
  assert.deepEqual(a, { id, grund: 'afbrudt' });
  assert.equal(s.lager.noter.get(id).status, 'gemt');
  assert.equal(s.lager.noter.get(id).afbrudt, true);
  assert.equal(s.tilstand.recorder.state, 'inactive');
});

test('afslutter ved track ended', async () => {
  const s = opsaet();
  await s.optager.start();
  s.tilstand.recorder.send('a');
  s.spor.dispatchEvent(new Event('ended'));
  assert.equal((await s.venTilAfsluttet()).grund, 'afbrudt');
});

test('afslutter ved recorder-fejl', async () => {
  const s = opsaet();
  await s.optager.start();
  s.tilstand.recorder.send('a');
  s.tilstand.recorder.dispatchEvent(new Event('error'));
  assert.equal((await s.venTilAfsluttet()).grund, 'afbrudt');
});

test('afslutter ved hul i stykker, når appen bliver synlig igen', async () => {
  const s = opsaet();
  await s.optager.start();
  s.tilstand.recorder.send('a');
  await new Promise((ok) => setTimeout(ok, 5));
  s.skrid(16000);
  s.dokument.dispatchEvent(new Event('visibilitychange'));
  assert.equal((await s.venTilAfsluttet()).grund, 'afbrudt');
});

test('fortsætter når appen er synlig uden hul', async () => {
  const s = opsaet();
  await s.optager.start();
  s.tilstand.recorder.send('a');
  await new Promise((ok) => setTimeout(ok, 5));
  s.skrid(4000);
  s.dokument.dispatchEvent(new Event('visibilitychange'));
  await new Promise((ok) => setTimeout(ok, 5));
  assert.deepEqual(s.afsluttet, []);
  assert.equal(s.tilstand.recorder.state, 'recording');
});

test('tager skærmlåsen igen, når appen bliver synlig', async () => {
  const s = opsaet();
  await s.optager.start();
  assert.equal(s.tilstand.laase, 1);
  s.dokument.dispatchEvent(new Event('visibilitychange'));
  await new Promise((ok) => setTimeout(ok, 5));
  assert.equal(s.tilstand.laase, 2);
});

test('afslutter når lageret er fuldt', async () => {
  const s = opsaet({ lager: falskLager({ fejlFraStykke: 1 }) });
  const id = await s.optager.start();
  s.tilstand.recorder.send('a');
  s.tilstand.recorder.send('b');
  const a = await s.venTilAfsluttet();
  assert.deepEqual(a, { id, grund: 'plads' });
  assert.deepEqual(s.lager.stykker.map((x) => x.nr), [0]);
  assert.equal(s.lager.noter.get(id).status, 'gemt');
});

test('advarer ved 55 minutter', async () => {
  const s = opsaet();
  await s.optager.start();
  s.skridMedLyd(55 * MINUT - 5000);
  assert.deepEqual(s.advarsler, []);
  s.skridMedLyd(5000);
  assert.deepEqual(s.advarsler, ['snartSlut']);
});

test('stopper efter 59 minutter', async () => {
  const s = opsaet();
  const id = await s.optager.start();
  s.skridMedLyd(59 * MINUT);
  assert.deepEqual(await s.venTilAfsluttet(), { id, grund: 'maks' });
});

test('sen lyd efter stop-timeout slettes ikke', async () => {
  const s = opsaet();
  const id = await s.optager.start();
  s.tilstand.recorder.stop = () => { s.tilstand.recorder.state = 'inactive'; };
  const stoppet = s.optager.stop();
  await new Promise((ok) => setTimeout(ok, 5));
  s.skrid(3000);
  await stoppet;
  assert.equal(s.lager.noter.has(id), true);
  assert.deepEqual(s.afsluttet, [{ id, grund: 'afbrudt' }]);
  s.tilstand.recorder.send('sen');
  await new Promise((ok) => setTimeout(ok, 5));
  assert.deepEqual(s.lager.stykker.map((x) => x.id), [id]);
});

test('hængende lager stopper ikke Stop', async () => {
  const s = opsaet({ lager: falskLager({ haengFraStykke: 0 }) });
  const id = await s.optager.start();
  s.tilstand.recorder.send('a');
  const stoppet = s.optager.stop();
  await new Promise((ok) => setTimeout(ok, 5));
  s.skrid(5000);
  assert.equal(await stoppet, id);
  assert.equal(s.lager.noter.has(id), true);
  assert.equal(s.optager.erAktiv(), false);
});

test('afslutter, når optageren stopper af sig selv', async () => {
  const s = opsaet();
  const id = await s.optager.start();
  s.tilstand.recorder.send('a');
  s.tilstand.recorder.stop();
  assert.deepEqual(await s.venTilAfsluttet(), { id, grund: 'afbrudt' });
});

test('vagthund afslutter, når der ikke kommer stykker', async () => {
  const s = opsaet();
  const id = await s.optager.start();
  s.tilstand.recorder.send('a');
  await new Promise((ok) => setTimeout(ok, 5));
  s.skrid(5000);
  s.skrid(5000);
  s.skrid(5000);
  assert.deepEqual(s.afsluttet, []);
  s.skrid(5000);
  assert.deepEqual(await s.venTilAfsluttet(), { id, grund: 'afbrudt' });
});

test('fejl i recorder.start rydder op, så man kan prøve igen', async () => {
  const s = opsaet();
  FalskRecorder.startFejl = new Error('kan ikke starte');
  try {
    await assert.rejects(s.optager.start(), (e) => e.type === 'kanIkkeOptage');
  } finally {
    FalskRecorder.startFejl = null;
  }
  assert.equal(s.optager.erAktiv(), false);
  assert.ok(s.spor.stoppet);
  assert.equal(s.lager.noter.size, 0);
  await s.optager.start();
  assert.equal(s.optager.erAktiv(), true);
});

test('fejl i opretNote lukker mikrofonen', async () => {
  const s = opsaet();
  s.lager.opretNote = async () => { throw new Error('lager'); };
  await assert.rejects(s.optager.start(), (e) => e.type === 'kanIkkeOptage');
  assert.ok(s.spor.stoppet);
  assert.equal(s.optager.erAktiv(), false);
});

test('start venter ikke på skærmlås', async () => {
  const s = opsaet({ skaermlaas: () => new Promise(() => {}) });
  const id = await s.optager.start();
  assert.ok(id);
});

test('skærmlås, der kommer efter afslutning, frigives', async () => {
  let frigivet = 0;
  let giv;
  const s = opsaet({ skaermlaas: () => new Promise((ok) => { giv = ok; }) });
  await s.optager.start();
  s.tilstand.recorder.send('a');
  await s.optager.stop();
  giv({ release: async () => { frigivet++; } });
  await new Promise((ok) => setTimeout(ok, 5));
  assert.equal(frigivet, 1);
});

test('tom optagelse slettes', async () => {
  const s = opsaet();
  const id = await s.optager.start();
  s.tilstand.recorder.slutStykke = false;
  await s.optager.stop();
  assert.deepEqual(s.afsluttet, [{ id, grund: 'tom' }]);
  assert.equal(s.lager.noter.has(id), false);
});

test('stop uden stop-begivenhed hænger ikke', async () => {
  const s = opsaet();
  const id = await s.optager.start();
  s.tilstand.recorder.send('a');
  s.tilstand.recorder.stop = () => { s.tilstand.recorder.state = 'inactive'; };
  const stoppet = s.optager.stop();
  await new Promise((ok) => setTimeout(ok, 5));
  s.skrid(3000);
  assert.equal(await stoppet, id);
});

test('afsluttes kun én gang', async () => {
  const s = opsaet();
  await s.optager.start();
  s.tilstand.recorder.send('a');
  s.spor.dispatchEvent(new Event('mute'));
  s.spor.dispatchEvent(new Event('ended'));
  await s.optager.stop();
  await s.venTilAfsluttet();
  await new Promise((ok) => setTimeout(ok, 5));
  assert.equal(s.afsluttet.length, 1);
});

test('skærmlås-fejl stopper ikke optagelsen', async () => {
  const s = opsaet({ skaermlaas: async () => { throw new Error('ikke tilladt'); } });
  await s.optager.start();
  assert.equal(s.tilstand.recorder.state, 'recording');
});

test('nægtet mikrofon giver mikrofonNaegtet og ingen note', async () => {
  const s = opsaet();
  s.tilstand.mikrofonFejl = new DOMException('nej', 'NotAllowedError');
  await assert.rejects(s.optager.start(), (e) => e.type === 'mikrofonNaegtet');
  assert.equal(s.lager.noter.size, 0);
});

test('ingen mikrofon giver kanIkkeOptage', async () => {
  const s = opsaet();
  s.tilstand.mikrofonFejl = new DOMException('nej', 'NotFoundError');
  await assert.rejects(s.optager.start(), (e) => e.type === 'kanIkkeOptage');
});

test('intet format giver kanIkkeOptage', async () => {
  const s = opsaet({ understoettet: () => false });
  await assert.rejects(s.optager.start(), (e) => e.type === 'kanIkkeOptage');
});
