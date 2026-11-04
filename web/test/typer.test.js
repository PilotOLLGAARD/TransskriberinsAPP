import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { TYPER, typeNavn } from '../js/typer.js';

const server = createRequire(import.meta.url)('../../server/src/typer.js');

test('appens typer er de samme som serverens', () => {
  assert.deepEqual(TYPER, server.TYPER);
});

test('typeNavn giver navnet, og intet for automatisk og ukendt', () => {
  for (const t of TYPER.filter((x) => x !== 'automatisk')) assert.equal(typeNavn(t), server.ETIKET[t], t);
  for (const raa of ['automatisk', undefined, null, '', 'Møde', 'x']) assert.equal(typeNavn(raa), null, String(raa));
});
