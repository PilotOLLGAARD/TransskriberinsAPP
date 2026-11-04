'use strict';
// Regnskab over, hvad testrunden har kostet hos Google. Gemmes i testlyd/forbrug.json (ikke i git).
// Grænsen er 30 kr. Testbænken stopper ved 25 kr. (1 USD regnes som 7 kr.)

const fs = require('node:fs');
const path = require('node:path');

const KR_PR_USD = 7;
const GRAENSE_KR = 25;
const GRAENSE_USD = GRAENSE_KR / KR_PR_USD;
const FIL = path.resolve(__dirname, '..', '..', 'testlyd', 'forbrug.json');

function laes(fil = FIL) {
  try {
    return JSON.parse(fs.readFileSync(fil, 'utf8'));
  } catch {
    return [];
  }
}

function tilfoejForbrug({ hvad, usd }, fil = FIL) {
  const poster = laes(fil);
  poster.push({ tid: new Date().toISOString(), hvad, usd: Math.round(usd * 1e6) / 1e6 });
  fs.mkdirSync(path.dirname(fil), { recursive: true });
  fs.writeFileSync(fil, JSON.stringify(poster, null, 1));
}

const forbrugIalt = (fil = FIL) => laes(fil).reduce((s, p) => s + p.usd, 0);

module.exports = { tilfoejForbrug, forbrugIalt, GRAENSE_USD, KR_PR_USD, GRAENSE_KR };
