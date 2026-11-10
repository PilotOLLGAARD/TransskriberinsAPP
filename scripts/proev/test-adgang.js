'use strict';

/**
 * Prøver, at en server afviser kald uden gyldigt bevis, før der kommer noget lyd igennem.
 * Brug: node scripts/proev/test-adgang.js https://serverens-adresse
 */

const url = process.argv[2];
if (!url) {
  console.error('Brug: node scripts/proev/test-adgang.js <serverens adresse>');
  process.exit(2);
}

function b64(o) {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

const FALSK_BEVIS = `${b64({ alg: 'RS256', kid: 'falsk' })}.${b64({ roles: ['Transskribering.Bruger'] })}.ZmFsc2s`;
const FORSOEG = [
  ['Uden bevis', {}],
  ['Med vrøvl', { authorization: 'Bearer vroevl' }],
  ['Med falsk signatur', { authorization: `Bearer ${FALSK_BEVIS}` }],
];

async function main() {
  let fejl = 0;
  for (const [navn, headers] of FORSOEG) {
    const svar = await fetch(`${url.replace(/\/$/, '')}/transskriber`, {
      method: 'POST',
      headers: { 'content-type': 'audio/mp4', ...headers },
      body: Buffer.from('ikke rigtig lyd'),
    });
    const ok = svar.status === 401;
    if (!ok) fejl++;
    console.log(`${ok ? 'OK  ' : 'FEJL'} ${navn}: ${svar.status}`);
  }
  process.exitCode = fejl ? 1 : 0;
}

main();
