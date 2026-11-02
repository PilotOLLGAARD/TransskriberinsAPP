'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TYPER, ETIKET, AFSNIT, laesType } = require('../src/typer.js');

test('de fem typer i fast rækkefølge med danske navne', () => {
  assert.deepEqual(TYPER, ['automatisk', 'byggenotat', 'moede', 'paamindelse', 'andet']);
  assert.deepEqual(TYPER.map((t) => ETIKET[t]), ['Automatisk', 'Byggenotat', 'Møde', 'Påmindelse', 'Andet']);
});

test('laesType godtager kun kendte nøgler', () => {
  assert.equal(laesType('moede'), 'moede');
  assert.equal(laesType(' byggenotat '), 'byggenotat');
  for (const raa of [undefined, null, '', 'MØDE', 'Moede', 'x'.repeat(500), 'automatisk', 42]) {
    assert.equal(laesType(raa), 'automatisk', String(raa));
  }
});

test('afsnit pr. type', () => {
  assert.deepEqual(AFSNIT.moede.map((a) => a.felt), ['hovedpunkter', 'beslutninger', 'opgaver', 'aabneSpoergsmaal']);
  assert.deepEqual(AFSNIT.byggenotat.map((a) => a.felt), ['hovedpunkter', 'fejlOgMangler', 'maalOgMaengder', 'opgaver']);
  assert.deepEqual(AFSNIT.paamindelse.map((a) => a.felt), ['huskeliste']);
  assert.deepEqual(AFSNIT.andet.map((a) => a.felt), ['hovedpunkter']);
  assert.equal(AFSNIT.automatisk, undefined);
});

test('afsnittene har overskrift og vejledning', () => {
  const byggenotat = Object.fromEntries(AFSNIT.byggenotat.map((a) => [a.felt, a.overskrift]));
  assert.equal(byggenotat.maalOgMaengder, 'Mål og mængder');
  assert.equal(byggenotat.opgaver, 'Opgaver og aftaler');
  assert.equal(AFSNIT.paamindelse[0].overskrift, 'Huskeliste');
  for (const liste of Object.values(AFSNIT)) {
    for (const a of liste) assert.ok(a.vejledning.length > 10, a.felt);
  }
});
