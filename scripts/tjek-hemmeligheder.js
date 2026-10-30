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
const FORBUDTE_FILER = /(^|\/)(\.env(\.(?!example$)[^/]+)?|local\.settings\.json)$/;
const REVISIONER_PR_KALD = 200;

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

function soegHistorik(soegeArgs, input) {
  const revisioner = linjer(git(['rev-list', '--all']).stdout);
  const fund = new Set();
  for (let i = 0; i < revisioner.length; i += REVISIONER_PR_KALD) {
    const del = revisioner.slice(i, i + REVISIONER_PR_KALD);
    for (const linje of linjer(git(['grep', '-l', ...soegeArgs, ...del], input).stdout)) fund.add(linje);
  }
  for (const linje of linjer(git(['grep', '-l', ...soegeArgs], input).stdout)) fund.add(linje);
  return [...fund];
}

function main() {
  const problemer = [];

  for (const navn of linjer(git(['ls-files']).stdout)) {
    if (FORBUDTE_FILER.test(navn)) problemer.push(`Må ikke ligge i git: ${navn}`);
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

module.exports = { findLaek };
