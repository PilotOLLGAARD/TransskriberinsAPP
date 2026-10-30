'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findLaek } = require('../tjek-hemmeligheder.js');

const FALSK_NOEGLE = 'AIza' + 'x'.repeat(35);

test('finder Gemini-nøgle', () => {
  const fund = findLaek([
    { navn: 'web/js/konfig.js', indhold: `const n = '${FALSK_NOEGLE}';` },
    { navn: 'README.md', indhold: 'ingen nøgle her' },
  ]);
  assert.deepEqual(fund, ['web/js/konfig.js']);
});

test('finder en bestemt værdi', () => {
  const fund = findLaek([{ navn: 'a.txt', indhold: 'hemmelig-vaerdi-123' }], ['hemmelig-vaerdi-123']);
  assert.deepEqual(fund, ['a.txt']);
});

test('finder ingenting i .env.example', () => {
  const indhold = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../.env.example'), 'utf8');
  assert.deepEqual(findLaek([{ navn: '.env.example', indhold }]), []);
});
