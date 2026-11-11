import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dybdeFor, lavTilbage } from '../js/tilbage.js';

/** Falsk historik: husker, hvad der blev lagt på og gået tilbage, og kan sende en tilbage-hændelse. */
function falskHistorik(dybde = 0) {
  const h = {
    state: dybde ? { dybde } : null,
    lagtPaa: [],
    gaaet: [],
    erstattet: [],
    lytter: null,
    pushState(state, titel) {
      assert.equal(titel, '');
      h.lagtPaa.push(state.dybde);
      h.state = state;
    },
    replaceState(state, titel) {
      assert.equal(titel, '');
      h.erstattet.push(state.dybde);
      h.state = state;
    },
    go(n) { h.gaaet.push(n); },
    /** Telefonen (eller go) er nået frem: historikken står på en ny dybde. */
    tilbageTil(nyDybde) {
      h.state = nyDybde ? { dybde: nyDybde } : null;
      h.lytter({ state: h.state });
    },
  };
  return h;
}

function opsaet(dybde = 0) {
  const historik = falskHistorik(dybde);
  const kald = [];
  const styring = lavTilbage({ historik, lyt: (fn) => { historik.lytter = fn; }, vedTilbage: (d) => kald.push(d) });
  return { historik, kald, styring };
}

test('forsiden er bunden, underskærme ligger ét skridt inde, og Læs fra Tidligere to', () => {
  assert.equal(dybdeFor('start', 'start'), 0);
  for (const visning of ['tidligere', 'information', 'navn', 'fremdrift', 'delt', 'optager']) assert.equal(dybdeFor(visning, 'start'), 1, visning);
  assert.equal(dybdeFor('tekst', 'start'), 1);
  assert.equal(dybdeFor('tekst', 'tidligere'), 2);
});

test('en underskærm lægger ét skridt på historikken, og kun én gang', () => {
  const { historik, styring } = opsaet();
  styring.synk('tidligere', 'start');
  styring.synk('tidligere', 'start');
  assert.deepEqual(historik.lagtPaa, [1]);
  styring.synk('tekst', 'tidligere');
  assert.deepEqual(historik.lagtPaa, [1, 2]);
  assert.deepEqual(historik.gaaet, []);
});

test('telefonens tilbage melder den nye dybde til appen', () => {
  const { historik, kald, styring } = opsaet();
  styring.synk('tekst', 'tidligere');
  historik.tilbageTil(1);
  assert.deepEqual(kald, [1]);
  historik.tilbageTil(0);
  assert.deepEqual(kald, [1, 0]);
});

test('Tilbage-knappen i appen rydder skridtet, uden at appen får besked om et tilbage-tryk', () => {
  const { historik, kald, styring } = opsaet();
  styring.synk('tidligere', 'start');
  styring.synk('start', 'start');
  assert.deepEqual(historik.gaaet, [-1]);
  historik.tilbageTil(0);
  assert.deepEqual(kald, []);
  // Næste underskærm lægger et nyt skridt på.
  styring.synk('information', 'start');
  assert.deepEqual(historik.lagtPaa, [1, 1]);
});

test('skifter appen skærm, mens historikken er på vej tilbage, kommer den i takt bagefter', () => {
  const { historik, kald, styring } = opsaet();
  styring.synk('tidligere', 'start');
  styring.synk('start', 'start');
  // Brugeren åbner Information, før telefonen har nået at gå tilbage.
  styring.synk('information', 'start');
  assert.deepEqual(historik.lagtPaa, [1], 'der lægges intet på, mens et skift er undervejs');
  historik.tilbageTil(0);
  assert.deepEqual(kald, []);
  assert.deepEqual(historik.lagtPaa, [1, 1]);
  assert.equal(historik.state.dybde, 1);
});

test('efter en genindlæsning går appen aldrig selv tilbage: skridtet under kan være en anden side', () => {
  // Historikken husker dybden fra før genindlæsningen, men skridtet under hører til en tidligere indlæsning
  // (eller til Microsofts loginside). Går appen tilbage dertil, hentes siden igen eller forlades.
  const { historik, kald, styring } = opsaet(1);
  styring.synk('start', 'start');
  assert.deepEqual(historik.gaaet, []);
  assert.deepEqual(historik.erstattet, [0]);
  // Herfra virker det som normalt.
  styring.synk('tidligere', 'start');
  assert.deepEqual(historik.lagtPaa, [1]);
  historik.tilbageTil(0);
  assert.deepEqual(kald, [0]);
});

test('starter appen direkte på en underskærm efter en genindlæsning, lægges skridtet oven på det nuværende', () => {
  const { historik, styring } = opsaet(2);
  styring.synk('navn', 'start');
  assert.deepEqual(historik.erstattet, [0]);
  assert.deepEqual(historik.lagtPaa, [1]);
  assert.deepEqual(historik.gaaet, []);
});

test('fra Læs to skridt inde direkte til forsiden går to skridt tilbage på én gang', () => {
  const { historik, kald, styring } = opsaet();
  styring.synk('tekst', 'tidligere');
  styring.synk('start', 'start');
  assert.deepEqual(historik.gaaet, [-2]);
  historik.tilbageTil(0);
  assert.deepEqual(kald, []);
});

test('en historik, der fejler, vælter ikke appen', () => {
  const historik = { get state() { throw new Error('nej'); }, pushState() { throw new Error('nej'); }, replaceState() { throw new Error('nej'); }, go() { throw new Error('nej'); } };
  const styring = lavTilbage({ historik, lyt: () => {}, vedTilbage: () => {} });
  styring.synk('tidligere', 'start');
  styring.synk('start', 'start');
});
