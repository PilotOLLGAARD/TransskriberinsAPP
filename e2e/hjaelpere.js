'use strict';

const path = require('node:path');

process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve(__dirname, '..', '.vaerktoej', 'browsere');
const { chromium } = require('playwright');
const { startLokal } = require('../scripts/lokal.js');

const TELEFON = { viewport: { width: 390, height: 844 }, hasTouch: true };

/** Starter lokal server og en browser med falsk mikrofon. */
async function startMiljoe() {
  const lokal = await startLokal({ port: 0 });
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  return { lokal, browser, adresse: lokal.adresse, async stop() { await browser.close(); await lokal.stop(); } };
}

async function nyTelefon(miljoe, { mikrofon = true, ...valg } = {}) {
  const kontekst = await miljoe.browser.newContext({
    ...TELEFON,
    ...valg,
    permissions: mikrofon ? ['microphone'] : [],
  });
  const side = await kontekst.newPage();
  return { kontekst, side };
}

async function tal(miljoe) {
  return (await fetch(`${miljoe.adresse}/test/tal`)).json();
}

async function saetNaesteFejl(miljoe, naeste) {
  await fetch(`${miljoe.adresse}/test/fejl?naeste=${naeste}`);
}

module.exports = { startMiljoe, nyTelefon, tal, saetNaesteFejl };
