'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findLaek, grepFejlede, erForbudtFil } = require('../tjek-hemmeligheder.js');

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

test('git-fejl tælles ikke som ingen fund', () => {
  assert.equal(grepFejlede({ status: 0 }), false);
  assert.equal(grepFejlede({ status: 1 }), false);
  assert.equal(grepFejlede({ status: 128 }), true);
  assert.equal(grepFejlede({ status: null, error: new Error('git findes ikke') }), true);
});

test('interne dokumenter og hemmelige filer må ikke ligge i git', () => {
  for (const navn of ['.env', '.env.local', 'server/.env', 'local.settings.json', 'docs/plan.md', 'docs/it-opsaetning.md', 'docs/test-resultater.md']) {
    assert.equal(erForbudtFil(navn), true, navn);
  }
  for (const navn of ['.env.example', 'docs/vejledning.md', 'docs/vejledning-medarbejdere.md', 'README.md', 'web/js/konfig.js']) {
    assert.equal(erForbudtFil(navn), false, navn);
  }
});
