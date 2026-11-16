import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAALE_MS, forskydning, lavHistorik, lavLydkurve, niveau } from '../js/lydkurve.js';

/** Lyd som browserens lydmåler giver den: bytes, hvor 128 er stilhed. */
function proever(fn, antal = 1024) {
  return Uint8Array.from({ length: antal }, (_, i) => Math.max(0, Math.min(255, Math.round(128 + 128 * fn(i)))));
}
const sinus = (amplitude) => proever((i) => amplitude * Math.sin(i / 5));

test('stilhed giver niveau 0, og fuld styrke giver 1', () => {
  assert.equal(niveau(proever(() => 0)), 0);
  assert.equal(niveau(Uint8Array.from({ length: 1024 }, (_, i) => (i % 2 ? 255 : 0))), 1);
});

test('almindelig tale ligger midt på skalaen', () => {
  // Amplitude 0,1 er ca. -23 dB. Skalaen går fra -60 dB (0) til -6 dB (1).
  const n = niveau(sinus(0.1));
  assert.ok(Math.abs(n - 0.685) <= 0.03, `niveau ${n}`);
});

test('højere lyd giver aldrig lavere niveau', () => {
  const n = [0.005, 0.02, 0.05, 0.1, 0.3, 0.6, 0.9].map((a) => niveau(sinus(a)));
  for (let i = 1; i < n.length; i++) assert.ok(n[i] >= n[i - 1], `${n[i]} efter ${n[i - 1]}`);
  assert.ok(n[0] > 0 && n.at(-1) <= 1);
});

test('en tom måling giver 0 i stedet for at fejle', () => {
  assert.equal(niveau(new Uint8Array(0)), 0);
});

test('historikken husker kun de nyeste målinger, nyeste sidst', () => {
  const h = lavHistorik(3);
  for (const v of [0.1, 0.2, 0.3, 0.4]) h.tilfoej(v);
  assert.deepEqual(h.vaerdier(), [0.2, 0.3, 0.4]);
  h.ryd();
  assert.deepEqual(h.vaerdier(), []);
});

test('søjlerne glider jævnt mellem to målinger, men står stille med reduceret bevægelse', () => {
  assert.equal(MAALE_MS, 100);
  assert.equal(forskydning(50, false), 0.5);
  assert.equal(forskydning(250, false), 1);
  assert.equal(forskydning(-5, false), 0);
  assert.equal(forskydning(50, true), 0);
});

/** Falsk lydkontekst, strøm og lærred. Tæller, hvad kurven gør ved dem. */
function falskMiljoe({ lyd = () => sinus(0.2), kontekstFejl = false, vaagner = true } = {}) {
  const m = {
    lukket: 0, afbrudt: 0, sporStoppet: 0, tilsluttet: [], tegnet: 0, soejler: 0, streger: 0, tid: 0, koe: [], fortsat: 0,
    vaagner, kontekst: null, tryk: null, trykFjernet: 0,
    strøm: { getTracks: () => [{ stop: () => { m.sporStoppet++; } }] },
    laerred: {
      isConnected: true, clientWidth: 300, clientHeight: 150, width: 0, height: 0,
      getContext: () => ({
        setTransform() {}, clearRect() {}, beginPath() {}, fill() { m.tegnet++; m.soejler++; }, fillRect() { m.tegnet++; m.streger++; },
        roundRect() {}, rect() {}, set fillStyle(v) {}, set globalAlpha(v) {},
      }),
    },
  };
  m.valg = {
    lavKontekst: () => {
      if (kontekstFejl) throw new Error('ingen lyd');
      m.kontekst = {
        // Som på en telefon: lydmåleren starter på pause og vågner, når den bliver bedt om det.
        state: 'suspended',
        resume: async () => { m.fortsat++; if (m.vaagner) m.kontekst.state = 'running'; },
        close: async () => { m.lukket++; },
        createMediaStreamSource: (s) => ({ connect: (maal) => { m.tilsluttet.push([s, maal]); }, disconnect: () => { m.afbrudt++; } }),
        createAnalyser: () => ({ fftSize: 0, getByteTimeDomainData: (buffer) => { buffer.set(lyd().subarray(0, buffer.length)); } }),
        destination: { navn: 'højttaler' },
      };
      return m.kontekst;
    },
    vedTryk: (fn) => { m.tryk = fn; return () => { m.tryk = null; m.trykFjernet++; }; },
    raf: (fn) => { m.koe.push(fn); return m.koe.length; },
    afbrydRaf: () => { m.koe.length = 0; },
    nu: () => m.tid,
    reducer: () => false,
  };
  /** Kører ét billede, ms senere. */
  m.billede = (ms = 16) => { m.tid += ms; const fn = m.koe.shift(); if (fn) fn(); };
  return m;
}

test('kurven lytter med på strømmen uden at sende lyden til højttaleren', () => {
  const m = falskMiljoe();
  const kurve = lavLydkurve(m.valg);
  assert.equal(kurve.erAktiv(), false);
  assert.equal(kurve.start(m.strøm), true);
  assert.equal(kurve.erAktiv(), true);
  assert.equal(m.fortsat, 1, 'konteksten skal vækkes');
  assert.equal(m.tilsluttet.length, 1);
  assert.equal(m.tilsluttet[0][0], m.strøm);
  assert.notEqual(m.tilsluttet[0][1].navn, 'højttaler');
});

test('kurven tegner søjler, når der er lyd', () => {
  const m = falskMiljoe();
  const kurve = lavLydkurve(m.valg);
  kurve.start(m.strøm);
  kurve.vis(m.laerred);
  for (let i = 0; i < 30; i++) m.billede(16);
  assert.ok(m.soejler > 3, `kun ${m.soejler} søjler`);
});

test('stop lukker lydmåleren, men stopper aldrig mikrofonens spor', () => {
  const m = falskMiljoe();
  const kurve = lavLydkurve(m.valg);
  kurve.start(m.strøm);
  kurve.vis(m.laerred);
  m.billede();
  kurve.stop();
  assert.equal(kurve.erAktiv(), false);
  assert.equal(m.lukket, 1);
  assert.equal(m.afbrudt, 1);
  assert.equal(m.sporStoppet, 0, 'optagelsen ejer sporene');
  assert.equal(m.koe.length, 0, 'tegningen fortsætter efter stop');
  // Stop to gange og uden start er harmløst.
  kurve.stop();
  lavLydkurve(m.valg).stop();
});

test('kan lydmåleren ikke starte, sker der intet andet, end at kurven mangler', () => {
  const m = falskMiljoe({ kontekstFejl: true });
  const kurve = lavLydkurve(m.valg);
  assert.equal(kurve.start(m.strøm), false);
  assert.equal(kurve.erAktiv(), false);
  kurve.vis(m.laerred);
  kurve.vis(null);
  kurve.stop();
  assert.equal(m.koe.length, 0);
  assert.equal(m.sporStoppet, 0);
});

test('afbrydes lydmåleren midt i optagelsen, fryser kurven uden at kaste', () => {
  // På iPhone kan lydmåleren blive afbrudt af et opkald eller en låst skærm. Optagelsen kører videre.
  let fejl = false;
  const m = falskMiljoe({ lyd: () => { if (fejl) throw new DOMException('afbrudt', 'InvalidStateError'); return sinus(0.2); } });
  const kurve = lavLydkurve(m.valg);
  kurve.start(m.strøm);
  kurve.vis(m.laerred);
  for (let i = 0; i < 10; i++) m.billede(50);
  fejl = true;
  for (let i = 0; i < 10; i++) m.billede(50);
  assert.equal(kurve.erAktiv(), true);
  kurve.stop();
  assert.equal(m.sporStoppet, 0);
});

test('står lydmåleren på pause, tegnes en rolig streg og ikke flade søjler, der ligner stilhed', () => {
  // På iPhone kan lydmåleren starte på pause eller blive sat på pause af et opkald. Optagelsen kører alligevel,
  // så kurven må ikke påstå, at mikrofonen intet hører.
  const m = falskMiljoe({ vaagner: false });
  const kurve = lavLydkurve(m.valg);
  assert.equal(kurve.start(m.strøm), true);
  kurve.vis(m.laerred);
  for (let i = 0; i < 20; i++) m.billede(50);
  assert.equal(m.soejler, 0, 'der tegnes søjler, selv om lydmåleren står på pause');
  assert.ok(m.streger >= 1, 'den rolige streg mangler');
  // Den prøver selv at vække lydmåleren igen, men ikke i hvert billede.
  assert.ok(m.fortsat >= 2 && m.fortsat <= 4, `${m.fortsat} forsøg på et sekund`);
  // Når lydmåleren kører igen, kommer søjlerne.
  m.kontekst.state = 'running';
  for (let i = 0; i < 10; i++) m.billede(50);
  assert.ok(m.soejler > 3, `kun ${m.soejler} søjler efter pausen`);
});

test('et tryk på skærmen vækker lydmåleren, og lytteren fjernes ved stop', () => {
  const m = falskMiljoe({ vaagner: false });
  const kurve = lavLydkurve(m.valg);
  kurve.start(m.strøm);
  kurve.vis(m.laerred);
  m.billede();
  assert.equal(typeof m.tryk, 'function');
  m.vaagner = true;
  m.tryk();
  assert.equal(m.kontekst.state, 'running');
  for (let i = 0; i < 10; i++) m.billede(50);
  assert.ok(m.soejler > 3);
  kurve.stop();
  assert.equal(m.trykFjernet, 1);
  assert.equal(m.tryk, null);
});

test('kurven tegner ikke, når lærredet er taget ud af siden, og fortsætter på et nyt', () => {
  const m = falskMiljoe();
  const kurve = lavLydkurve(m.valg);
  kurve.start(m.strøm);
  kurve.vis(m.laerred);
  m.billede();
  m.laerred.isConnected = false;
  m.billede();
  m.billede();
  assert.equal(m.koe.length, 0, 'tegningen kører uden lærred');
  const foer = m.tegnet;
  const nyt = { ...m.laerred, isConnected: true };
  kurve.vis(nyt);
  for (let i = 0; i < 10; i++) m.billede(50);
  assert.ok(m.tegnet > foer, 'der tegnes ikke på det nye lærred');
});
