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

// Lydkurven

const lydBytes = (side) => side.evaluate(async () => {
  const l = await import('/js/lager.js');
  const [note] = await l.alleNoter();
  return (await l.hentLyd(note.id)).size;
});

/** Antal hvide billedpunkter på lydkurvens lærred. */
const hvidePunkter = (side) => side.locator('canvas.kurve').evaluate((c) => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200 && d[i + 3] > 80) n++;
  return n;
});

async function stopOgSend(side, foer) {
  await knap(side, 'Stop').click();
  await side.getByLabel(FELT).waitFor({ timeout: 15000 });
  assert.ok(await lydBytes(side) > 0, 'ingen lyd blev gemt');
  await knap(side, 'Send').click();
  await vis(side, SENDT);
  assert.equal((await tal(miljoe)).mailKald, foer.mailKald + 1);
}

test('lydkurven tegner, og optagelsen gemmes og sendes som før', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const foer = await tal(miljoe);
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await side.waitForTimeout(1500);
  assert.equal(await side.locator('canvas.kurve').getAttribute('aria-hidden'), 'true');
  assert.ok(await hvidePunkter(side) > 50, 'kurven er tom');
  const r = await side.locator('canvas.kurve').boundingBox();
  assert.ok(r.width > 300 && r.height >= 96, `lærredet er ${r.width} x ${r.height}`);
  await stopOgSend(side, foer);
  await kontekst.close();
});

test('kan lydmåleren ikke starte, virker optagelsen alligevel', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.addInitScript(() => {
    const Nej = class { constructor() { throw new Error('ingen lydmåler'); } };
    window.AudioContext = Nej;
    window.webkitAudioContext = Nej;
  });
  await logInd(side);
  const foer = await tal(miljoe);
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await side.locator('.kurve.rolig').waitFor();
  assert.equal(await side.locator('canvas.kurve').count(), 0);
  await side.waitForTimeout(1000);
  await stopOgSend(side, foer);
  await kontekst.close();
});

test('afbrydes lydmåleren midt i optagelsen, gemmes optagelsen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  // Som på en iPhone, hvor et opkald eller en låst skærm afbryder lydmåleren.
  await side.addInitScript(() => {
    const original = AnalyserNode.prototype.getByteTimeDomainData;
    const start = Date.now();
    AnalyserNode.prototype.getByteTimeDomainData = function proev(buffer) {
      if (window.maalerStartet && Date.now() - window.maalerStartet > 500) throw new DOMException('afbrudt', 'InvalidStateError');
      window.maalerStartet ||= Date.now();
      return original.call(this, buffer);
    };
    void start;
  });
  await logInd(side);
  const foer = await tal(miljoe);
  const fejl = [];
  side.on('pageerror', (e) => fejl.push(e.message));
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await side.waitForTimeout(1500);
  assert.ok(await side.evaluate(() => Date.now() - window.maalerStartet > 500), 'lydmåleren blev aldrig afbrudt');
  await stopOgSend(side, foer);
  assert.deepEqual(fejl, []);
  await kontekst.close();
});

// Skærmskift og ro

const animation = (side, selector, pseudo = null) => side.locator(selector).first().evaluate((el, p) => getComputedStyle(el, p).animationName, pseudo);

test('en ny skærm toner ind, men ikke appens første skærm', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  // Første tegning efter start: ingen bevægelse, så appen åbner med det samme.
  assert.equal(await side.locator('#app.ind').count(), 0);
  await knap(side, 'Tidligere optagelser').click();
  await side.locator('#app.ind').waitFor();
  assert.equal(await animation(side, '#app'), 'ton');
  assert.equal(await animation(side, 'h1'), 'loeft');
  await knap(side, 'Tilbage').click();
  // Bundlinjen er fast og løftes ikke med, ellers ville Optag hoppe.
  assert.equal(await animation(side, '.bund'), 'none');
  await kontekst.close();
});

test('med reduceret bevægelse toner en ny skærm kun, den flytter sig ikke', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { reducedMotion: 'reduce' });
  await logInd(side);
  await knap(side, 'Tidligere optagelser').click();
  await side.locator('#app.ind').waitFor();
  assert.equal(await animation(side, 'h1'), 'none');
  assert.equal(await animation(side, '#app'), 'ton');
  await kontekst.close();
});

test('bundlinjen står stille under et skærmskift', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const foer = await boks(knap(side, 'Optag'));
  await knap(side, 'Information').click();
  await knap(side, 'Tilbage').click();
  await side.waitForTimeout(50);
  const midt = await boks(knap(side, 'Optag'));
  await side.waitForTimeout(400);
  const efter = await boks(knap(side, 'Optag'));
  for (const r of [midt, efter]) assert.deepEqual([Math.round(r.x), Math.round(r.y)], [Math.round(foer.x), Math.round(foer.y)]);
  await kontekst.close();
});

test('kort toner ikke ind igen, og spinnere og prikken fortsætter i takt, når skærmen tegnes på ny', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'tjeneste');
  await optag(side);
  await knap(side, 'Prøv igen').waitFor({ timeout: 15000 });
  await tilForsiden(side);
  await side.waitForTimeout(400);
  assert.equal(await animation(side, '.kort'), 'none');
  assert.ok(!(await stil(side, '.kort', 'transitionProperty')).includes('opacity'), 'kortet toner ind ved hver tegning');
  // En besked animerer kun, når den er ny.
  await side.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('nej', 'NotAllowedError'); }; });
  await knap(side, 'Optag').click();
  await side.locator('.besked.fejl.ny').waitFor();
  await knap(side, 'Upload lydfil').evaluate((k) => k.blur());
  // Trin-skærmen: spinneren får sin takt fra uret, så den ikke starter forfra ved hver ny tegning.
  await side.evaluate(() => { delete navigator.mediaDevices.getUserMedia; });
  await saetNaesteFejl(miljoe, 'langsom');
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  assert.match(await side.locator('.prik').evaluate((el) => el.style.getPropertyValue('--takt')), /^-\d+ms$/);
  assert.equal(await animation(side, '.prik', '::after'), 'puls');
  await side.waitForTimeout(800);
  await knap(side, 'Stop').click();
  await navngiv(side);
  await side.locator('.trin-punkt.igang .spinner').waitFor();
  assert.match(await side.locator('.trin-punkt.igang .spinner').evaluate((el) => el.style.getPropertyValue('--takt')), /^-\d+ms$/);
  await vis(side, SENDT);
  await kontekst.close();
});

test('Fortryd-bjælken glider ud i stedet for at forsvinde brat', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await optag(side);
  await vis(side, SENDT);
  await tilForsiden(side);
  await knap(side, 'Tidligere optagelser').click();
  await knap(side, 'Slet').click();
  await knap(side, 'Fortryd').click();
  await side.locator('.toast.ud').waitFor({ timeout: 2000 });
  await side.locator('.toast').waitFor({ state: 'detached', timeout: 1000 });
  // Optagelsen er tilbage.
  await knap(side, 'Send referat igen').waitFor();
  await kontekst.close();
});

test('Fortryd-bjælken dækker ikke bundlinjen på forsiden', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'tjeneste');
  await optag(side);
  await knap(side, 'Prøv igen').waitFor({ timeout: 15000 });
  await tilForsiden(side);
  await knap(side, 'Slet').click();
  await knap(side, 'Fortryd').waitFor();
  await side.waitForTimeout(300);
  const bjaelke = await side.locator('.toast').boundingBox();
  const optagKnap = await knap(side, 'Optag').boundingBox();
  assert.ok(bjaelke.y + bjaelke.height <= optagKnap.y, `bjælken (${Math.round(bjaelke.y + bjaelke.height)}) dækker Optag (${Math.round(optagKnap.y)})`);
  await knap(side, 'Fortryd').click();
  await knap(side, 'Prøv igen').waitFor();
  await kontekst.close();
});

// Tom liste, trin-skærm og tekster

test('den tomme liste under Tidligere fører til forsiden uden at starte en optagelse', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await knap(side, 'Tidligere optagelser').click();
  await side.getByRole('heading', { name: 'Ingen optagelser endnu' }).waitFor();
  await vis(side, 'Når du har sendt en optagelse, ligger referatet her i 7 dage.');
  // Forklaringen om de 7 dage står ét sted, ikke to.
  assert.equal(await side.getByText('Her finder du dine optagelser').count(), 0);
  await knap(side, 'Optag den første').click();
  await knap(side, 'Optag').waitFor();
  await side.waitForTimeout(300);
  assert.equal(await knap(side, 'Stop').count(), 0, 'optagelsen startede af sig selv');
  // Med en optagelse på listen er den tomme tilstand væk, og forklaringen står øverst.
  await optag(side);
  await vis(side, SENDT);
  await tilForsiden(side);
  await knap(side, 'Tidligere optagelser').click();
  await vis(side, 'Her finder du dine optagelser');
  assert.equal(await knap(side, 'Optag den første').count(), 0);
  await kontekst.close();
});

test('knapperne på trin-skærmen står nederst, inden for tommelfingeren', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { viewport: { width: 390, height: 844 } });
  await logInd(side);
  const nederst = async (navn) => {
    const r = await boks(knap(side, navn));
    return 844 - (r.y + r.height);
  };
  await optag(side);
  await vis(side, SENDT);
  assert.ok(await nederst('Ny optagelse') <= 60, `Ny optagelse står ${await nederst('Ny optagelse')} px over bunden`);
  await tilForsiden(side);
  await saetNaesteFejl(miljoe, 'tjeneste');
  await optag(side);
  await knap(side, 'Prøv igen').waitFor({ timeout: 15000 });
  assert.ok(await nederst('Til forsiden') <= 60, `Til forsiden står ${await nederst('Til forsiden')} px over bunden`);
  assert.ok(await side.evaluate(() => document.documentElement.scrollHeight <= innerHeight), 'trin-skærmen ruller');
  await kontekst.close();
});

test('fluebenet tegnes, første gang et trin er færdigt, og ikke igen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await optag(side);
  await vis(side, SENDT);
  // Lige efter afsendelsen er de sidste trin nye.
  assert.ok(await side.locator('.trin-punkt.faerdig.ny').count() >= 1);
  // Kommer man tilbage til en færdig note, tegnes intet igen.
  await tilForsiden(side);
  await knap(side, 'Information').click();
  await knap(side, 'Tilbage').click();
  assert.equal(await side.locator('.trin-punkt.ny').count(), 0);
  await kontekst.close();
});

test('fejl og råd står i korte sætninger', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'tjeneste');
  await knap(side, 'Optag').click();
  await vis(side, 'Lad skærmen være tændt, og læg telefonen med skærmen opad.');
  await side.waitForTimeout(800);
  await knap(side, 'Stop').click();
  await navngiv(side);
  await vis(side, 'Det lykkedes ikke at lave referatet. Optagelsen er gemt. Prøv igen.');
  await kontekst.close();
});

// Telefonens tilbage (Android-knappen og swipe)

const dybde = (side) => side.evaluate(() => history.state?.dybde ?? 0);
/** Som telefonens tilbage-knap: ét skridt tilbage i historikken, uden at siden hentes igen. */
const telefonTilbage = (side) => side.evaluate(() => history.back());

test('telefonens tilbage fra Tidligere og Information fører til forsiden', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  for (const [navn, tekst] of [['Tidligere optagelser', 'Ingen optagelser endnu'], ['Information', 'Hvad appen kan bruges til']]) {
    await knap(side, navn).click();
    await vis(side, tekst);
    assert.equal(await dybde(side), 1);
    await telefonTilbage(side);
    await knap(side, 'Optag').waitFor();
    assert.equal(await dybde(side), 0);
  }
  await kontekst.close();
});

test('telefonens tilbage fra Læs fører til Tidligere og derfra til forsiden', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await optag(side, { titel: 'Tilbagemøde' });
  await vis(side, SENDT);
  await tilForsiden(side);
  await knap(side, 'Tidligere optagelser').click();
  await knap(side, 'Læs').click();
  await knap(side, 'Send referat igen').waitFor();
  await vis(side, 'Testreferat');
  assert.equal(await dybde(side), 2);
  await telefonTilbage(side);
  await vis(side, 'Tidligere optagelser');
  await knap(side, 'Læs').waitFor();
  assert.equal(await dybde(side), 1);
  await telefonTilbage(side);
  await knap(side, 'Optag').waitFor();
  assert.equal(await dybde(side), 0);
  await kontekst.close();
});

test('under en optagelse sker der intet ved telefonens tilbage', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const foer = await tal(miljoe);
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await side.waitForTimeout(600);
  await telefonTilbage(side);
  await side.waitForTimeout(600);
  // Stadig på optageskærmen, og uret går.
  await knap(side, 'Stop').waitFor();
  const ur = await side.locator('#ur').textContent();
  await side.waitForTimeout(1100);
  assert.notEqual(await side.locator('#ur').textContent(), ur);
  await stopOgSend(side, foer);
  await kontekst.close();
});

test('telefonens tilbage på navneskærmen efter upload: filen ligger under Afventer', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const { randomFillSync } = require('node:crypto');
  const buffer = Buffer.alloc(100 * 1024);
  randomFillSync(buffer);
  Buffer.from([0, 0, 0, 0x20]).copy(buffer, 0);
  Buffer.from('ftypM4A ').copy(buffer, 4);
  const [vaelger] = await Promise.all([side.waitForEvent('filechooser'), knap(side, 'Upload lydfil').click()]);
  await vaelger.setFiles({ name: 'Ny optagelse 14.m4a', mimeType: 'audio/mp4', buffer });
  await side.getByLabel(FELT).waitFor({ timeout: 15000 });
  await telefonTilbage(side);
  await knap(side, 'Optag').waitFor();
  await vis(side, 'Lydfilen er gemt.');
  await knap(side, 'Navngiv og send').waitFor();
  assert.equal(await side.evaluate(async () => (await (await import('/js/lager.js')).alleNoter()).length), 1);
  await kontekst.close();
});

test('Tilbage-knappen i appen og telefonens tilbage kan blandes', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await knap(side, 'Tidligere optagelser').click();
  await knap(side, 'Tilbage').click();
  await knap(side, 'Optag').waitFor();
  await knap(side, 'Information').click();
  await vis(side, 'Hvad appen kan bruges til');
  await side.waitForTimeout(200);
  assert.equal(await dybde(side), 1);
  await telefonTilbage(side);
  await knap(side, 'Optag').waitFor();
  assert.equal(await dybde(side), 0);
  // Appen er stadig den samme side: intet er hentet igen.
  assert.equal(new URL(side.url()).pathname, '/');
  await kontekst.close();
});

test('genindlæsning på en underskærm starter på forsiden, og tilbage går ikke i ring', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await knap(side, 'Tidligere optagelser').click();
  await vis(side, 'Ingen optagelser endnu');
  await side.reload();
  await knap(side, 'Optag').waitFor({ timeout: 15000 });
  await side.waitForTimeout(500);
  assert.equal(await dybde(side), 0);
  await knap(side, 'Optag').waitFor();
  await knap(side, 'Information').click();
  await vis(side, 'Hvad appen kan bruges til');
  await telefonTilbage(side);
  await knap(side, 'Optag').waitFor();
  await kontekst.close();
});

test('åbnes appen igen fra en underskærm, går den aldrig selv tilbage i historikken', async () => {
  // Skridtet under kan høre til en tidligere indlæsning eller en anden side (fx Microsofts login).
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await knap(side, 'Tidligere optagelser').click();
  await vis(side, 'Ingen optagelser endnu');
  await side.goto(miljoe.adresse);
  await knap(side, 'Optag').waitFor({ timeout: 15000 });
  let navigeret = 0;
  side.on('framenavigated', () => { navigeret++; });
  await side.waitForTimeout(700);
  assert.equal(navigeret, 0, 'appen navigerede af sig selv');
  assert.equal(await dybde(side), 0);
  await kontekst.close();
});

// Værste realistiske data

const LANGT_NAVN = 'Byggemøde_uge46_Ørestad_Syd_etape3_installationer_og_ventilation_opfølgning_på_mangelliste_fra_totalentreprenøren_rev2';

test('et meget langt navn fylder højst tre linjer på trin-skærmen, så trinnene kan ses på den mindste skærm', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { viewport: { width: 320, height: 568 } });
  await logInd(side);
  await optag(side, { titel: LANGT_NAVN });
  await vis(side, SENDT);
  const h1 = side.locator('h1.titel');
  const r = await h1.boundingBox();
  const linje = await h1.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  assert.ok(r.height <= linje * 3 + 2, `overskriften er ${Math.round(r.height)} px høj (${(r.height / linje).toFixed(1)} linjer)`);
  // Hele navnet kan stadig læses af skærmlæsere og ved at holde fingeren på det.
  assert.equal(await h1.getAttribute('title'), LANGT_NAVN);
  assert.equal(await h1.textContent(), LANGT_NAVN);
  const trin = await side.locator('.trin-kort').boundingBox();
  assert.ok(trin.y < 568 / 2, `trinnene starter ${Math.round(trin.y)} px nede`);
  assert.ok(await side.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // Under Læs står hele navnet, i en mindre skrift.
  await tilForsiden(side);
  await knap(side, 'Tidligere optagelser').click();
  await knap(side, 'Læs').click();
  await side.locator('.tekst').waitFor();
  assert.equal(await side.locator('h1.titel').textContent(), LANGT_NAVN);
  assert.equal(await stil(side, 'h1.titel', 'fontSize'), '24px');
  assert.equal(await side.locator('h1.titel').getAttribute('title'), null);
  await kontekst.close();
});

test('et kort navn står i stor skrift, og lange ord deles ved stavelser i stedet for midt i ordet', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await optag(side, { titel: 'Byggemøde' });
  await vis(side, SENDT);
  assert.equal(await stil(side, 'h1.titel', 'fontSize'), '34px');
  assert.equal(await stil(side, 'h1.titel', 'hyphens'), 'auto');
  await tilForsiden(side);
  await knap(side, 'Tidligere optagelser').click();
  assert.equal(await stil(side, '.historik-top .dato', 'hyphens'), 'auto');
  // Appens egne overskrifter og mailadresser deles aldrig med bindestreg.
  assert.equal(await stil(side, 'h1.titel', 'hyphens'), 'manual');
  await knap(side, 'Tilbage').click();
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await side.waitForTimeout(800);
  await knap(side, 'Stop').click();
  await side.getByLabel(FELT).waitFor();
  assert.equal(await stil(side, '.navn-titel', 'hyphens'), 'manual');
  await knap(side, 'Send').click();
  await vis(side, SENDT);
  assert.equal(await stil(side, '.trin-titel', 'hyphens'), 'manual');
  await kontekst.close();
});
