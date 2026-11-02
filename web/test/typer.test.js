import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { TYPER, STANDARD_TYPE, rensType } from '../js/typer.js';

const server = createRequire(import.meta.url)('../../server/src/typer.js');

test('appens typer er de samme som serverens, i samme rækkefølge og med samme navne', () => {
  assert.deepEqual(TYPER.map((t) => t.noegle), server.TYPER);
  for (const t of TYPER) assert.equal(t.navn, server.ETIKET[t.noegle], t.noegle);
  assert.equal(STANDARD_TYPE, 'automatisk');
});

test('hver type har en kort forklaring, undtagen Automatisk', () => {
  for (const t of TYPER.filter((x) => x.noegle !== 'automatisk')) assert.ok(t.forklaring.length > 5, t.noegle);
});

test('rensType godtager kun kendte nøgler', () => {
  assert.equal(rensType('moede'), 'moede');
  for (const raa of [undefined, null, '', 'Møde', 'x']) assert.equal(rensType(raa), 'automatisk');
});
