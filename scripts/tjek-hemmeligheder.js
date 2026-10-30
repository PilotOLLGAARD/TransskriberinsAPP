'use strict';

/**
 * Finder nøgler i git: i de sporede filer og i hele historikken.
 * Skriver kun filnavne ud, aldrig værdier.
 *
 * Sættes GEMINI_API_KEY i miljøet, søges der også efter netop den værdi:
 *   node --env-file=.env scripts/tjek-hemmeligheder.js
 */

const { spawnSync } = require('node:child_process');

const NOEGLE_MOENSTER = /AIza[0-9A-Za-z_-]{30,}/;
const NOEGLE_MOENSTER_GIT = 'AIza[0-9A-Za-z_-]{30,}';
// Repoet er offentligt, så interne dokumenter må heller ikke komme med.
const FORBUDTE_FILER = /(^|\/)(\.env(\.(?!example$)[^/]+)?|local\.settings\.json)$|^docs\/(plan|it-opsaetning|test-resultater)\.md$/;
const REVISIONER_PR_KALD = 200;

function erForbudtFil(navn) {
  return FORBUDTE_FILER.test(navn);
}

function findLaek(filer, vaerdier = []) {
  return filer
    .filter(({ indhold }) => NOEGLE_MOENSTER.test(indhold) || vaerdier.some((v) => v && indhold.includes(v)))
    .map(({ navn }) => navn);
}

function git(args, input) {
  return spawnSync('git', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}

function linjer(tekst) {
  return tekst.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** git grep svarer 0 ved fund og 1 ved ingen fund. Alt andet betyder, at søgningen ikke blev gennemført. */
function grepFejlede(svar) {
  return Boolean(svar.error) || (svar.status !== 0 && svar.status !== 1);
}

function grep(args, input) {
  const svar = git(['grep', '-l', ...args], input);
  if (grepFejlede(svar)) throw new Error('git grep kunne ikke gennemføres');
  return linjer(svar.stdout);
}

function soegHistorik(soegeArgs, input) {
  const revisioner = git(['rev-list', '--all']);
  if (revisioner.error || revisioner.status !== 0) throw new Error('git rev-list kunne ikke gennemføres');
  const alle = linjer(revisioner.stdout);
  const fund = new Set();
  for (let i = 0; i < alle.length; i += REVISIONER_PR_KALD) {
    const del = alle.slice(i, i + REVISIONER_PR_KALD);
    for (const linje of grep([...soegeArgs, ...del], input)) fund.add(linje);
  }
  for (const linje of grep(soegeArgs, input)) fund.add(linje);
  return [...fund];
}

function main() {
  const problemer = [];

  for (const navn of linjer(git(['ls-files']).stdout)) {
    if (erForbudtFil(navn)) problemer.push(`Må ikke ligge i git: ${navn}`);
  }
  if (git(['check-ignore', '-q', '.env']).status !== 0) problemer.push('.env er ikke ignoreret af git');

  for (const fil of soegHistorik(['-E', NOEGLE_MOENSTER_GIT])) problemer.push(`Ligner en nøgle: ${fil}`);

  const noegle = process.env.GEMINI_API_KEY;
  if (noegle) {
    for (const fil of soegHistorik(['-F', '-f', '-'], noegle)) problemer.push(`Indeholder GEMINI_API_KEY: ${fil}`);
  }

  if (problemer.length) {
    for (const p of problemer) console.error(p);
    process.exitCode = 1;
    return;
  }
  console.log(`Ingen hemmeligheder fundet i git${noegle ? ' (også søgt efter din nøgle)' : ''}.`);
}

if (require.main === module) main();

module.exports = { findLaek, grepFejlede, erForbudtFil };
