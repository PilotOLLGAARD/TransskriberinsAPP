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

/**
 * Luft på forsiden: fri plads i .scene ud over indholdet. Måles med Arial (på Linux Liberation Sans, samme mål),
 * så Windows, Linux i GitHub og iPhones systemskrift giver nogenlunde samme resultat.
 */
async function forsideLuft(side) {
  await side.evaluate(() => { document.body.style.fontFamily = 'Arial, "Liberation Sans", sans-serif'; });
  await side.waitForTimeout(100);
  return side.evaluate(() => {
    const sc = document.querySelector('.scene');
    const cs = getComputedStyle(sc);
    const boern = [...sc.children].reduce((s, b) => s + b.getBoundingClientRect().height, 0);
    const gap = parseFloat(cs.rowGap || 0) * (sc.children.length - 1);
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    return { rul: document.documentElement.scrollHeight - innerHeight, hoejde: innerHeight, luft: Math.round(sc.clientHeight - boern - gap - pad) };
  });
}

module.exports = { startMiljoe, nyTelefon, tal, saetNaesteFejl, forsideLuft };
