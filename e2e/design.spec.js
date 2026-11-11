'use strict';
// Design og brugeroplevelse: mørk tilstand, bundlinje, optageskærm, lydkurve, skærmskift og telefonens tilbage.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startMiljoe, nyTelefon, tal, saetNaesteFejl, ryd, kontrast, boks } = require('./hjaelpere.js');

let miljoe;
before(async () => { miljoe = await startMiljoe(); });
after(async () => { await miljoe.stop(); });
afterEach(async () => { await ryd(miljoe); });

const knap = (side, navn) => side.getByRole('button', { name: navn, exact: true });
const SENDT = 'Referatet er sendt til test@ollgaard.dk';
const FELT = 'Hvad handler optagelsen om?';
const NAT = '#0f1a26';
const LYS = '#f3f5f8';

async function vis(side, tekst, timeout = 15000) {
  await side.getByText(tekst, { exact: false }).first().waitFor({ timeout });
}

async function logInd(side) {
  await side.goto(miljoe.adresse);
  await side.evaluate(() => localStorage.setItem('testNaesteType', 'medarbejder'));
  await knap(side, 'Log ind').click();
  await knap(side, 'Optag').waitFor({ timeout: 15000 });
}

async function navngiv(side, titel = '') {
  const felt = side.getByLabel(FELT);
  await felt.waitFor({ timeout: 15000 });
  await felt.fill(titel);
  await knap(side, 'Send').click();
}

async function optag(side, { ms = 800, titel = '' } = {}) {
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await side.waitForTimeout(ms);
  await knap(side, 'Stop').click();
  await navngiv(side, titel);
}

async function tilForsiden(side) {
  await side.getByRole('button', { name: /^(Ny optagelse|Til forsiden)$/ }).first().click();
  await knap(side, 'Optag').waitFor();
}

const stil = (side, selector, egenskab) => side.locator(selector).first().evaluate((el, e) => getComputedStyle(el)[e], egenskab);
const tema = (side) => side.evaluate(() => [document.getElementById('tema-lys')?.content, document.getElementById('tema-moerk')?.content]);
const logo = (side) => side.locator('img.ordmaerke').first().evaluate((el) => el.currentSrc.split('/').pop());

async function kraevKontrast(side, selector, mindst, hvor) {
  const k = await kontrast(side, selector);
  assert.ok(k.forhold >= mindst, `${hvor}: ${selector} har kun ${k.forhold.toFixed(2)}:1 (${k.tekst})`);
}

// Mørk tilstand

test('mørk tilstand følger telefonen', async () => {
  const moerk = await nyTelefon(miljoe, { colorScheme: 'dark' });
  await logInd(moerk.side);
  assert.equal(await stil(moerk.side, 'body', 'backgroundColor'), 'rgb(15, 26, 38)');
  assert.equal(await stil(moerk.side, 'h1', 'color'), 'rgb(241, 244, 248)');
  assert.equal(await logo(moerk.side), 'ordmaerke-lys.svg');
  await moerk.kontekst.close();

  const lys = await nyTelefon(miljoe, { colorScheme: 'light' });
  await logInd(lys.side);
  assert.equal(await stil(lys.side, 'body', 'backgroundColor'), 'rgb(243, 245, 248)');
  assert.equal(await stil(lys.side, 'h1', 'color'), 'rgb(40, 40, 40)');
  assert.equal(await logo(lys.side), 'ordmaerke.svg');
  await lys.kontekst.close();
});

for (const skema of ['light', 'dark']) {
  test(`teksten kan læses i ${skema === 'dark' ? 'mørk' : 'lys'} tilstand`, async () => {
    const { kontekst, side } = await nyTelefon(miljoe, { colorScheme: skema });
    await logInd(side);
    // En sendt note og en fejlet, så alle farver er i brug.
    await optag(side, { titel: 'Sendt møde' });
    await vis(side, SENDT);
    await kraevKontrast(side, '.trin-titel, .trin-tekst, .undertitel, .mail-linje', 4.5, 'trin, færdig');
    await kraevKontrast(side, 'button', 4.5, 'trin, færdig');
    await tilForsiden(side);
    await saetNaesteFejl(miljoe, 'tjeneste');
    await optag(side, { titel: 'Fejlet møde' });
    await knap(side, 'Prøv igen').waitFor({ timeout: 15000 });
    await kraevKontrast(side, '.trin-titel, .trin-tekst', 4.5, 'trin, fejl');
    await tilForsiden(side);

    await side.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('nej', 'NotAllowedError'); }; });
    await knap(side, 'Optag').click();
    await side.locator('.besked.fejl').waitFor();
    await kraevKontrast(side, '.intro, .felt-titel, .top-knap, .sektion-titel, .kort .dato, .kort .tid, .kort .forklaring, .besked', 4.5, 'forside');
    await kraevKontrast(side, 'button', 4.5, 'forside');
    // Hvid på knapblå (#0E5AA3) er 6,98:1. Farven er ØLLGAARDs og ændres ikke.
    await kraevKontrast(side, 'button.optag', 6.9, 'forside');

    await knap(side, 'Tidligere optagelser').click();
    await vis(side, 'Sendt møde');
    await kraevKontrast(side, '.undertitel, .historik .dato, .historik .meta, .slettes, .historik .forklaring, .status-maerke', 4.5, 'Tidligere');
    await kraevKontrast(side, 'button', 4.5, 'Tidligere');
    await knap(side, 'Tilbage').click();
    await knap(side, 'Information').click();
    await vis(side, 'Hvad appen kan bruges til');
    await kraevKontrast(side, '.info-afsnit p, .info-afsnit li, .info-afsnit a, .info-fold summary, .tlf, .guide-note', 4.5, 'Information');
    await kontekst.close();
  });
}

test('telefonen skifter til mørk, mens appen er åben, og statuslinjen følger med', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { colorScheme: 'light' });
  await logInd(side);
  assert.deepEqual(await tema(side), [LYS, NAT]);
  await side.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await stil(side, 'body', 'backgroundColor'), 'rgb(15, 26, 38)');
  // Under optagelsen er skærmen mørk i begge tilstande.
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  assert.deepEqual(await tema(side), [NAT, NAT]);
  await side.waitForTimeout(800);
  await knap(side, 'Stop').click();
  await side.getByLabel(FELT).waitFor();
  assert.deepEqual(await tema(side), [LYS, NAT]);
  await kontekst.close();
});

// Forsidens bundlinje

test('Afventer-kort kan rulles fri af bundlinjen, også med lange navne på den mindste skærm', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { viewport: { width: 320, height: 568 } });
  await logInd(side);
  for (const titel of ['Kort navn', 'Langtnavnudenmellemrum'.repeat(6).slice(0, 120), 'Byggemøde']) {
    await saetNaesteFejl(miljoe, 'tjeneste');
    await optag(side, { titel });
    await knap(side, 'Prøv igen').waitFor({ timeout: 15000 });
    await tilForsiden(side);
  }
  assert.equal(await side.locator('.kort').count(), 3);
  await side.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await side.waitForTimeout(200);
  const slet = await knap(side, 'Slet').last().boundingBox();
  const optagKnap = await knap(side, 'Optag').boundingBox();
  assert.ok(slet.y + slet.height <= optagKnap.y, `Slet (${Math.round(slet.y + slet.height)}) ligger under Optag (${Math.round(optagKnap.y)})`);
  assert.ok(await side.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'siden ruller vandret');
  // Bundlinjen står stille, mens der rulles.
  assert.ok(optagKnap.y + optagKnap.height <= 568 && optagKnap.y > 568 / 2);
  await kontekst.close();
});

test('mens appen logger ind, står det lige over bundlinjen, og Optag og Upload er spærret', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await side.evaluate(() => { localStorage.removeItem('testKonto'); localStorage.setItem('testFornyVent', '1500'); });
  await side.reload();
  await vis(side, 'Logger ind …');
  const status = await side.locator('.bund-status').boundingBox();
  const optagKnap = await knap(side, 'Optag').boundingBox();
  assert.ok(status.y + status.height <= optagKnap.y, 'beskeden ligger ikke over Optag');
  assert.ok(optagKnap.y - (status.y + status.height) < 40, 'beskeden ligger langt fra bundlinjen');
  assert.equal(await knap(side, 'Optag').isDisabled(), true);
  assert.equal(await knap(side, 'Upload lydfil').isDisabled(), true);
  assert.equal(await knap(side, 'Tidligere optagelser').isDisabled(), false);
  await kontekst.close();
});

test('forsiden uden ventende optagelser forklarer, hvad man gør', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await vis(side, 'Tryk Optag, og tal. Tryk Stop, når du er færdig. Så laver appen referatet.');
  assert.equal(await side.getByText('Har du allerede en lydfil?').count(), 0);
  await saetNaesteFejl(miljoe, 'tjeneste');
  await optag(side);
  await knap(side, 'Prøv igen').waitFor({ timeout: 15000 });
  await tilForsiden(side);
  await vis(side, 'Afventer');
  assert.equal(await side.locator('.kom-i-gang').count(), 0);
  await kontekst.close();
});

// Optageskærmen

for (const viewport of [{ width: 390, height: 844 }, { width: 375, height: 647 }, { width: 320, height: 568 }]) {
  test(`Stop ligger, hvor Optag lå (${viewport.width} x ${viewport.height})`, async () => {
    const { kontekst, side } = await nyTelefon(miljoe, { viewport });
    await logInd(side);
    const foer = await boks(knap(side, 'Optag'));
    await knap(side, 'Optag').click();
    const efter = await boks(knap(side, 'Stop'));
    for (const maal of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(foer[maal] - efter[maal]) <= 2, `${maal}: Optag ${foer[maal]}, Stop ${efter[maal]}`);
    }
    // Uret og rådet står over knappen og kan ses uden at rulle.
    const ur = await side.locator('#ur').boundingBox();
    const raad = await side.getByText('Lad skærmen være tændt').boundingBox();
    assert.ok(ur.y > 0 && raad.y + raad.height <= efter.y, 'tekst og Stop overlapper');
    assert.ok(await side.evaluate(() => document.documentElement.scrollHeight <= innerHeight), 'optageskærmen ruller');
    await side.waitForTimeout(800);
    await knap(side, 'Stop').click();
    await side.getByLabel(FELT).waitFor();
    await kontekst.close();
  });
}
