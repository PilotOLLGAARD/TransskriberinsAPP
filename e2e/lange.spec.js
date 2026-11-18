'use strict';
// Lange optagelser og flere lydfiler: listen over filer, bidder, fremdrift i dele og advarslen om plads.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startMiljoe, nyTelefon, ryd } = require('./hjaelpere.js');

let miljoe;
before(async () => { miljoe = await startMiljoe(); });
after(async () => { await miljoe.stop(); });
afterEach(async () => { await ryd(miljoe); });

const knap = (side, navn) => side.getByRole('button', { name: navn, exact: true });
const SENDT = 'Referatet er sendt til test@ollgaard.dk';

async function vis(side, tekst, timeout = 15000) {
  await side.getByText(tekst, { exact: false }).first().waitFor({ timeout });
}

async function logInd(side) {
  await side.goto(miljoe.adresse);
  await side.evaluate(() => localStorage.setItem('testNaesteType', 'medarbejder'));
  await knap(side, 'Log ind').click();
  await knap(side, 'Optag').waitFor({ timeout: 15000 });
}

/** En rigtig WAV-fil med en tone, så telefonen kan læse varigheden, og appen kan klippe den. */
function wav(sek = 2, rate = 8000, tone = 8) {
  const n = sek * rate;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / tone) * 8000), 44 + i * 2);
  return b;
}

async function vaelgFiler(side, filer, knapNavn = 'Upload lydfil') {
  const [vaelger] = await Promise.all([side.waitForEvent('filechooser'), knap(side, knapNavn).click()]);
  assert.equal(vaelger.isMultiple(), true, 'filvælgeren tager flere filer');
  await vaelger.setFiles(filer.map(([name, sek]) => ({ name, mimeType: 'audio/wav', buffer: wav(sek) })));
}

/** Sender noten fra navneskærmen og giver kroppen af kaldet til /referat. */
async function sendOgFangReferat(side) {
  const referat = side.waitForRequest((r) => r.url().endsWith('/referat') && r.method() === 'POST');
  await knap(side, 'Send').click();
  const krop = JSON.parse((await referat).postData());
  await vis(side, SENDT, 30000);
  return krop;
}

const filnavne = (side) => side.locator('.fil-liste .fil-navn').allTextContents();

test('to lydfiler bliver én note med ét referat og et filnavn pr. del', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await vaelgFiler(side, [['Møde_del1.wav', 2], ['Møde_del2.wav', 3]]);
  await side.getByRole('heading', { name: 'Lydfiler' }).waitFor();
  assert.deepEqual(await filnavne(side), ['Møde_del1.wav', 'Møde_del2.wav']);
  await vis(side, 'I alt 5 sek');
  await knap(side, 'Næste').click();
  await side.getByLabel('Hvad handler optagelsen om?').waitFor();
  const krop = await sendOgFangReferat(side);
  assert.deepEqual(krop.dele.map((d) => d.filnavn), ['Møde_del1.wav', 'Møde_del2.wav']);
  const noter = await side.evaluate(async () => (await import('/js/lager.js')).alleNoter());
  assert.equal(noter.length, 1);
  assert.equal(noter[0].kilde, 'filer');
  await kontekst.close();
});

test('rækkefølgen kan ændres, og ✕ fjerner en fil', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await vaelgFiler(side, [['A.wav', 1], ['B.wav', 1], ['C.wav', 1]]);
  await knap(side, 'Flyt C.wav op').click();
  assert.deepEqual(await filnavne(side), ['A.wav', 'C.wav', 'B.wav']);
  await knap(side, 'Flyt A.wav ned').click();
  assert.deepEqual(await filnavne(side), ['C.wav', 'A.wav', 'B.wav']);
  await knap(side, 'Fjern B.wav').click();
  assert.deepEqual(await filnavne(side), ['C.wav', 'A.wav']);
  await vaelgFiler(side, [['D.wav', 1]], 'Tilføj fil');
  await side.locator('.fil-liste .fil-navn', { hasText: 'D.wav' }).waitFor();
  assert.deepEqual(await filnavne(side), ['C.wav', 'A.wav', 'D.wav']);
  await knap(side, 'Næste').click();
  const krop = await sendOgFangReferat(side);
  assert.deepEqual(krop.dele.map((d) => d.filnavn), ['C.wav', 'A.wav', 'D.wav']);
  await kontekst.close();
});

test('Tilbage fra listen gemmer intet', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await vaelgFiler(side, [['A.wav', 1], ['B.wav', 1]]);
  await knap(side, 'Tilbage').click();
  await knap(side, 'Optag').waitFor();
  assert.equal((await side.evaluate(async () => (await import('/js/lager.js')).alleNoter())).length, 0);
  await kontekst.close();
});

test('en lang fil sendes i bidder med tider, og fremdriften vises i dele', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.addInitScript(() => { globalThis.__BIDDER__ = { bidMs: 20000, overlapMs: 5000, delFraMs: 25000, smaaBidMs: 10000 }; });
  await logInd(side);
  const anmodninger = [];
  side.on('request', (r) => { if (r.url().endsWith('/transskriber') && r.method() === 'POST') anmodninger.push(r.headers()); });
  const [vaelger] = await Promise.all([side.waitForEvent('filechooser'), knap(side, 'Upload lydfil').click()]);
  await vaelger.setFiles({ name: 'Langt møde.wav', mimeType: 'audio/wav', buffer: wav(70) });
  await side.getByLabel('Hvad handler optagelsen om?').waitFor();
  // Lokalt er bidderne færdige på et øjeblik. Lidt ventetid, så skærmen når at vise fremdriften.
  await side.route('**/transskriber', async (route) => { await new Promise((ok) => setTimeout(ok, 400)); await route.continue(); });
  const dele = side.getByText(/af 4 dele/).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
  const krop = await sendOgFangReferat(side);
  assert.equal(anmodninger.length, 4);
  for (const h of anmodninger) {
    assert.equal(h['x-kun-tekst'], '1');
    assert.equal(h['x-afsnit'], '1');
  }
  assert.deepEqual(krop.dele[0].bidder.map((b) => b.startSek), [0, 15, 35, 55]);
  assert.ok(await dele, 'skærmen viste fremdriften i dele');
  await kontekst.close();
});

test('lidt plads på telefonen giver en venlig besked, men optagelsen starter', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.addInitScript(() => {
    navigator.storage.estimate = async () => ({ quota: 100e6, usage: 50e6 });
  });
  await logInd(side);
  await knap(side, 'Optag').click();
  await vis(side, 'Telefonen har kun plads til ca. 52 minutters optagelse.');
  await knap(side, 'Stop').waitFor();
  await kontekst.close();
});

test('Lydfiler-skærmen: tekst mindst 18 px og knapper mindst 44 px, i lys og mørk', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { kontekst, side } = await nyTelefon(miljoe, { colorScheme });
    await logInd(side);
    await vaelgFiler(side, [['Et meget langt filnavn fra byggepladsen på Amager Strandvej.wav', 1], ['B.wav', 1]]);
    await side.getByRole('heading', { name: 'Lydfiler' }).waitFor();
    const maal = await side.evaluate(() => {
      const tekster = [...document.querySelectorAll('.fil-liste *')].filter((e) => e.childElementCount === 0 && e.textContent.trim());
      const knapper = [...document.querySelectorAll('.fil-liste button, #app button')];
      return {
        tekst: Math.min(...tekster.map((e) => parseFloat(getComputedStyle(e).fontSize))),
        knap: Math.min(...knapper.map((b) => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height))),
        bredde: document.documentElement.scrollWidth <= window.innerWidth,
      };
    });
    assert.ok(maal.tekst >= 18, `${colorScheme}: mindste tekst ${maal.tekst} px`);
    assert.ok(maal.knap >= 44, `${colorScheme}: mindste knap ${maal.knap} px`);
    assert.ok(maal.bredde, `${colorScheme}: siden ruller sidelæns`);
    await kontekst.close();
  }
});
