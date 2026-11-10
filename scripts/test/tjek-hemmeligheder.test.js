'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findLaek, grepFejlede, erForbudtFil } = require('../tjek-hemmeligheder.js');

const FALSK_NOEGLE = 'AIza' + 'x'.repeat(35);

test('finder Gemini-nøgle', () => {
  const fund = findLaek([
    { navn: 'app/js/konfig.js', indhold: `const n = '${FALSK_NOEGLE}';` },
    { navn: 'README.md', indhold: 'ingen nøgle her' },
  ]);
  assert.deepEqual(fund, ['app/js/konfig.js']);
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
  for (const navn of ['.env', '.env.local', 'server/.env', 'local.settings.json', 'docs/plan.md', 'docs/it-opsaetning.md', 'docs/test-resultater.md', 'docs/plan-referat.md', 'docs/plan-fase3.md', 'docs/overdragelse.md', 'docs/udrulning.md']) {
    assert.equal(erForbudtFil(navn), true, navn);
  }
  for (const navn of ['.env.example', 'docs/vejledning.md', 'docs/vejledning-medarbejdere.md', 'README.md', 'app/js/konfig.js']) {
    assert.equal(erForbudtFil(navn), false, navn);
  }
});

test('de gamle planer i docs/planer/ og det lokale arkiv/ må ikke ligge i git', () => {
  for (const navn of ['docs/planer/plan.md', 'docs/planer/plan-fase3.md', 'docs/planer/noter.txt', 'docs/Planer/plan.md', 'arkiv/scripts/proev-gemini.js', 'arkiv/x', 'Arkiv/x']) {
    assert.equal(erForbudtFil(navn), true, navn);
  }
  for (const navn of ['scripts/arkiv.js', 'app/arkiv/x', 'docs/vejledning.md']) {
    assert.equal(erForbudtFil(navn), false, navn);
  }
});

test('interne dokumenter findes også med store bogstaver og andre navne', () => {
  for (const navn of ['docs/Plan.md', 'docs/PLAN-fase4.md', 'docs/plan_ny.md', 'docs/plan-fase 4.md', 'docs/Overdragelse.md', 'docs/IT-opsaetning.md']) {
    assert.equal(erForbudtFil(navn), true, navn);
  }
  assert.equal(erForbudtFil('docs/planlaegning-vejledning.md'), true);
  assert.equal(erForbudtFil('docs/vejledning.md'), false);
});

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SCRIPT = path.resolve(__dirname, '../tjek-hemmeligheder.js');

function koerI(mappe, ...args) {
  return spawnSync('git', args, { cwd: mappe, encoding: 'utf8' });
}

test('et internt dokument, der kun findes i historikken (fx et tag), findes', () => {
  const mappe = fs.mkdtempSync(path.join(os.tmpdir(), 'tjek-'));
  try {
    koerI(mappe, 'init', '-q');
    koerI(mappe, 'config', 'user.email', 'test@example.invalid');
    koerI(mappe, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(mappe, '.gitignore'), '.env\n');
    fs.mkdirSync(path.join(mappe, 'docs'));
    fs.writeFileSync(path.join(mappe, 'docs', 'plan.md'), 'intern');
    koerI(mappe, 'add', '-A');
    koerI(mappe, 'commit', '-q', '-m', 'med plan');
    koerI(mappe, 'tag', 'gammel');
    koerI(mappe, 'rm', '-q', 'docs/plan.md');
    koerI(mappe, 'commit', '-q', '-m', 'uden plan');
    const svar = spawnSync(process.execPath, [SCRIPT], { cwd: mappe, encoding: 'utf8' });
    assert.equal(svar.status, 1, svar.stdout + svar.stderr);
    assert.match(svar.stderr, /docs\/plan\.md/);
  } finally {
    fs.rmSync(mappe, { recursive: true, force: true });
  }
});

test('.gitignore holder alle interne dokumenter ude, også nye planer', () => {
  const rod = path.resolve(__dirname, '../..');
  for (const navn of ['docs/plan.md', 'docs/plan-del4.md', 'docs/overdragelse.md', 'docs/it-opsaetning.md', 'docs/test-resultater.md', 'docs/udrulning.md']) {
    assert.equal(koerI(rod, 'check-ignore', '-q', '--no-index', navn).status, 0, `${navn} er ikke ignoreret`);
  }
});

test('et internt dokument med æ, ø eller å i navnet findes også', () => {
  const mappe = fs.mkdtempSync(path.join(os.tmpdir(), 'tjek-'));
  try {
    koerI(mappe, 'init', '-q');
    koerI(mappe, 'config', 'user.email', 'test@example.invalid');
    koerI(mappe, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(mappe, '.gitignore'), '.env\n');
    fs.mkdirSync(path.join(mappe, 'docs'));
    fs.writeFileSync(path.join(mappe, 'docs', 'plan-møde.md'), 'intern');
    koerI(mappe, 'add', '-A');
    koerI(mappe, 'commit', '-q', '-m', 'med plan');
    const svar = spawnSync(process.execPath, [SCRIPT], { cwd: mappe, encoding: 'utf8' });
    assert.equal(svar.status, 1, svar.stdout + svar.stderr);
    assert.match(svar.stderr, /docs\/plan-møde\.md/);
  } finally {
    fs.rmSync(mappe, { recursive: true, force: true });
  }
});
