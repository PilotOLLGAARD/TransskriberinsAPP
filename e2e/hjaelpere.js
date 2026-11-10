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

/**
 * Efter hver test: en fejlet test må ikke smitte de næste. Den lokale servers "næste fejl" nulstilles
 * (fx afbrydUpload, der ellers rammer alle uploads), og telefoner, en fejlet test ikke nåede at lukke, lukkes.
 */
async function ryd(miljoe) {
  await Promise.all(miljoe.browser.contexts().map((k) => k.close()));
  await saetNaesteFejl(miljoe, 'ingen');
}

/** Venter på service workeren, men aldrig i det uendelige. side.evaluate har ingen tidsgrænse i sig selv. */
async function swKlar(side, ms = 20000) {
  const klar = await side.evaluate((ms) => Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise((ok) => setTimeout(() => ok(false), ms)),
  ]), ms);
  if (!klar) throw new Error(`Service workeren blev ikke klar på ${ms / 1000} s`);
}

/** Knappens placering, når den er synlig. Under en ny tegning af skærmen kan boundingBox kortvarigt give null. */
async function boks(lokator, ms = 15000) {
  const slut = Date.now() + ms;
  for (;;) {
    await lokator.waitFor({ timeout: Math.max(1, slut - Date.now()) });
    const r = await lokator.boundingBox();
    if (r) return r;
    if (Date.now() > slut) throw new Error('Elementet fik ingen placering');
    await new Promise((ok) => setTimeout(ok, 50));
  }
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

/**
 * Laveste kontrast (WCAG) mellem tekst og baggrund for de synlige elementer, der passer på selector.
 * Baggrunden er alle forfædres farver lagt oven på hinanden. Giver { forhold, tekst } for det svageste element.
 */
async function kontrast(side, selector) {
  return side.evaluate((sel) => {
    const tal = (s) => {
      const m = /rgba?\(([^)]+)\)/.exec(s);
      if (!m) throw new Error(`Ukendt farve: ${s}`);
      const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [r, g, b, a];
    };
    const over = ([r, g, b, a], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
    const lys = (f) => {
      const [r, g, b] = f.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    let svagest = null;
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const kaede = [];
      for (let e = el; e; e = e.parentElement) kaede.unshift(e);
      let bg = [255, 255, 255];
      for (const e of kaede) bg = over(tal(getComputedStyle(e).backgroundColor), bg);
      const fg = over(tal(getComputedStyle(el).color), bg);
      const [a, b] = [lys(fg), lys(bg)].sort((x, y) => y - x);
      const forhold = (a + 0.05) / (b + 0.05);
      if (!svagest || forhold < svagest.forhold) svagest = { forhold, tekst: `${el.className || el.tagName}: ${el.textContent.trim().slice(0, 40)}` };
    }
    return svagest ?? { forhold: Infinity, tekst: 'ingen elementer' };
  }, selector);
}

module.exports = { startMiljoe, nyTelefon, tal, saetNaesteFejl, forsideLuft, ryd, swKlar, boks, kontrast };
