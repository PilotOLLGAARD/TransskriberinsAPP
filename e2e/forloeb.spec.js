'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMiljoe, nyTelefon, tal, saetNaesteFejl } = require('./hjaelpere.js');

let miljoe;
before(async () => { miljoe = await startMiljoe(); });
after(async () => { await miljoe.stop(); });

const knap = (side, navn) => side.getByRole('button', { name: navn, exact: true });
const SENDT = 'Referatet er sendt til test@ollgaard.dk';
const FELT = 'Hvad handler optagelsen om?';

async function vis(side, tekst) {
  await side.getByText(tekst, { exact: false }).first().waitFor({ timeout: 15000 });
}

async function logInd(side, type = 'medarbejder') {
  await side.goto(miljoe.adresse);
  await side.evaluate((t) => localStorage.setItem('testNaesteType', t), type);
  await knap(side, 'Log ind').click();
  await knap(side, 'Optag').waitFor({ timeout: 15000 });
}

async function navngiv(side, titel = '') {
  const felt = side.getByLabel(FELT);
  await felt.waitFor({ timeout: 15000 });
  await felt.fill(titel);
  await knap(side, 'Send').click();
}

async function stopOptagelse(side, ms = 800) {
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await side.waitForTimeout(ms);
  await knap(side, 'Stop').click();
}

async function optag(side, { ms = 800, titel = '' } = {}) {
  await stopOptagelse(side, ms);
  await navngiv(side, titel);
}

async function fejlMail(side) {
  await saetNaesteFejl(miljoe, 'mail');
  await optag(side);
  await vis(side, 'Mailen blev ikke sendt.');
}

/** Fra skærmen efter Send til forsiden, som når brugeren trykker Ny optagelse eller Til forsiden. */
async function tilForsiden(side) {
  await side.getByRole('button', { name: /^(Ny optagelse|Til forsiden)$/ }).first().click();
  await knap(side, 'Optag').waitFor();
}

const antalNoter = (side) => side.evaluate(async () => (await (await import('/js/lager.js')).alleNoter()).length);
// Sendte noter bliver i 7 dage, men uden lyd.
const sendteUdenLyd = (side) => side.evaluate(async () => {
  const l = await import('/js/lager.js');
  const noter = await l.alleNoter();
  const sendte = noter.filter((n) => n.status === 'sendt');
  for (const n of sendte) if ((await l.hentLyd(n.id)).size) return -1;
  return noter.length === sendte.length ? sendte.length : -2;
});

async function lydBytes(side) {
  return side.evaluate(async () => {
    const l = await import('/js/lager.js');
    const [note] = await l.alleNoter();
    return (await l.hentLyd(note.id)).size;
  });
}

test('hele forløbet med navn', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  const foer = await tal(miljoe);
  await logInd(side);
  await optag(side, { titel: 'Møde omkring SAS Lounge' });
  await vis(side, SENDT);
  const efter = await tal(miljoe);
  assert.equal(efter.geminiKald - foer.geminiKald, 1);
  assert.equal(efter.referatKald - foer.referatKald, 1);
  assert.equal(efter.sidsteReferat.titel, 'Møde omkring SAS Lounge');
  assert.ok(Number.isFinite(efter.sidsteReferat.varighedSek));
  assert.match(efter.modtaget.mime, /^audio\/(mp4|webm)/);
  assert.equal(efter.mailKald - foer.mailKald, 1);
  const besked = efter.sidsteMail.message;
  assert.deepEqual(besked.toRecipients, [{ emailAddress: { address: 'test@ollgaard.dk' } }]);
  assert.match(besked.subject, /^Andet: Møde omkring SAS Lounge – \d{1,2}\. \S+ \d{4}$/);
  assert.match(besked.body.content, /Testreferat af/);
  assert.match(besked.attachments[0].name, /^\d{4}-\d{2}-\d{2} Møde omkring SAS Lounge\.pdf$/);
  assert.equal(Buffer.from(besked.attachments[0].contentBytes, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.equal(await sendteUdenLyd(side), 1);
  await kontekst.close();
});

test('navneskærmen har fokus i feltet, én Send-knap og Enter sender', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await stopOptagelse(side);
  await side.getByLabel(FELT).waitFor();
  assert.equal(await side.evaluate(() => document.activeElement?.id), 'titel');
  assert.deepEqual(await side.getByRole('button').allTextContents(), ['Send']);
  await side.getByLabel(FELT).fill('Kort');
  await side.getByLabel(FELT).press('Enter');
  await vis(side, SENDT);
  await kontekst.close();
});

test('navnet bevares, når en anden note bliver færdig i baggrunden', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'langsom');
  await optag(side, { titel: 'Første note' });
  await tilForsiden(side);
  await stopOptagelse(side);
  await side.getByLabel(FELT).fill('Anden no');
  await vis(side, SENDT);
  assert.equal(await side.getByLabel(FELT).inputValue(), 'Anden no');
  await kontekst.close();
});

test('tomt navn giver AI-titel', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await optag(side, { titel: '' });
  await vis(side, SENDT);
  assert.match((await tal(miljoe)).sidsteMail.message.subject, /^Andet: Testtitel fra AI – /);
  await kontekst.close();
});

test('optagelse viser tydeligt, at den kører', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await knap(side, 'Optag').click();
  await vis(side, 'Optager');
  await vis(side, '00:0');
  await side.waitForTimeout(800); // Et øjeblikkeligt stop giver ingen lyd og er sin egen test.
  await knap(side, 'Stop').click();
  await navngiv(side);
  await vis(side, SENDT);
  await kontekst.close();
});

test('navnet overlever netværksfejl', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await side.evaluate(async () => { await navigator.serviceWorker.ready; });
  const foer = await tal(miljoe);

  await stopOptagelse(side);
  await kontekst.setOffline(true);
  await navngiv(side, 'Gåtur Nørrehus');
  await vis(side, 'Ingen forbindelse. Optagelsen er gemt.');
  await vis(side, 'Gåtur Nørrehus');
  const bytes = await lydBytes(side);
  assert.ok(bytes > 0);

  await side.reload();
  await vis(side, 'Ingen forbindelse. Optagelsen er gemt.');
  await vis(side, 'Gåtur Nørrehus');
  assert.equal(await lydBytes(side), bytes);

  await kontekst.setOffline(false);
  await knap(side, 'Prøv igen').click();
  await vis(side, SENDT);
  const efter = await tal(miljoe);
  assert.equal(efter.geminiKald - foer.geminiKald, 1);
  assert.equal(efter.modtaget.bytes, bytes);
  assert.equal(efter.sidsteReferat.titel, 'Gåtur Nørrehus');
  assert.match(efter.sidsteMail.message.subject, /^Andet: Gåtur Nørrehus – /);
  await kontekst.close();
});

for (const type of ['fremmed', 'gaest']) {
  test(`fremmed koster ikke penge: ${type}`, async () => {
    const { kontekst, side } = await nyTelefon(miljoe);
    const foer = await tal(miljoe);
    await logInd(side, type);
    await optag(side);
    await vis(side, 'Din konto har ikke adgang til appen.');
    const efter = await tal(miljoe);
    assert.equal(efter.geminiKald, foer.geminiKald);
    assert.equal(efter.referatKald, foer.referatKald);
    assert.ok((await lydBytes(side)) > 0);
    await kontekst.close();
  });
}

test('login-forløb overlever genindlæsning', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side, 'udloebet');
  await optag(side, { titel: 'Login-test' });
  await vis(side, 'Du skal logge ind igen. Optagelsen er gemt.');
  const bytes = await lydBytes(side);
  await side.evaluate(() => localStorage.setItem('testNaesteType', 'medarbejder'));
  await knap(side, 'Log ind og prøv igen').click();
  await vis(side, SENDT);
  const efter = await tal(miljoe);
  assert.equal(efter.modtaget.bytes, bytes);
  assert.equal(efter.sidsteReferat.titel, 'Login-test');
  await kontekst.close();
});

test('app dræbt under optagelse kan navngives og sendes', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await side.waitForTimeout(6000); // Mindst ét gemt stykke.
  await side.close();
  const ny = await kontekst.newPage();
  await ny.goto(miljoe.adresse);
  await vis(ny, 'Optagelsen blev afbrudt');
  assert.ok((await lydBytes(ny)) > 0);
  // Appen åbner direkte på navneskærmen for den afbrudte optagelse.
  await navngiv(ny, 'Afbrudt note');
  await vis(ny, SENDT);
  await kontekst.close();
});

test('dræbt på navneskærmen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await stopOptagelse(side);
  await side.getByLabel(FELT).waitFor();
  await side.close();
  const ny = await kontekst.newPage();
  await ny.goto(miljoe.adresse);
  await knap(ny, 'Navngiv og send').click();
  await navngiv(ny, 'Efter genstart');
  await vis(ny, SENDT);
  assert.equal((await tal(miljoe)).sidsteReferat.titel, 'Efter genstart');
  await kontekst.close();
});

test('afbrudt optagelse åbner navneskærmen med besked', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (krav) => {
      const stream = await original(krav);
      window.testStream = stream;
      return stream;
    };
  });
  await logInd(side);
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await side.waitForTimeout(800);
  // Som når telefonen tager mikrofonen fra appen.
  await side.evaluate(() => window.testStream.getAudioTracks()[0].dispatchEvent(new Event('mute')));
  await side.getByLabel(FELT).waitFor();
  await vis(side, 'Optagelsen blev afbrudt');
  await navngiv(side, 'Afbrudt');
  await vis(side, SENDT);
  await kontekst.close();
});

test('app dræbt før første stykke efterlader ingen tom note', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await side.close();
  const ny = await kontekst.newPage();
  await ny.goto(miljoe.adresse);
  await knap(ny, 'Optag').waitFor();
  assert.equal(await antalNoter(ny), 0);
  await kontekst.close();
});

test('koldstart, hvor login er væk: kan stadig optage, og login gør arbejdet færdigt', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  // Hverken login i appen eller session hos Microsoft: det kan ikke fornyes uden tryk.
  await side.evaluate(() => { localStorage.removeItem('testKonto'); localStorage.removeItem('testSession'); });
  await side.reload();
  await optag(side);
  await vis(side, 'Du skal logge ind igen. Optagelsen er gemt.');
  assert.ok((await lydBytes(side)) > 0);
  await knap(side, 'Log ind og prøv igen').click();
  await vis(side, SENDT);
  await kontekst.close();
});

test('måske sendt: advarsel, ingen automatisk afsendelse, og noten kan fjernes', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await fejlMail(side);
  const foer = await tal(miljoe);
  await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    const [note] = await l.alleNoter();
    await l.opdaterNote(note.id, { status: 'sender-mail' });
  });
  await side.reload();
  await vis(side, 'Mailen er måske allerede sendt.');
  await knap(side, 'Læs og send').click();
  await vis(side, 'Mailen er måske allerede sendt.');
  assert.equal((await tal(miljoe)).mailKald, foer.mailKald);
  await knap(side, 'Jeg har fået mailen').click();
  await knap(side, 'Optag').waitFor();
  assert.equal(await sendteUdenLyd(side), 1);
  await kontekst.close();
});

test('måske sendt og udløbet login sender ikke automatisk efter login', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await fejlMail(side);
  const foer = await tal(miljoe);
  await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    const [note] = await l.alleNoter();
    await l.opdaterNote(note.id, { maaskeSendt: true, fejlType: 'login' });
  });
  await side.reload();
  await knap(side, 'Læs og send').click();
  await vis(side, 'Mailen er måske allerede sendt.');
  await knap(side, 'Log ind og prøv igen').click();
  await vis(side, 'Mailen er måske allerede sendt.');
  assert.equal((await tal(miljoe)).mailKald, foer.mailKald);
  assert.equal(await antalNoter(side), 1);
  await kontekst.close();
});

test('login uden net giver en besked og forlader ikke appen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side, 'udloebet');
  await side.evaluate(async () => { await navigator.serviceWorker.ready; });
  await optag(side);
  await vis(side, 'Du skal logge ind igen. Optagelsen er gemt.');
  await side.evaluate(() => localStorage.setItem('testNaesteType', 'medarbejder'));
  await kontekst.setOffline(true);
  await knap(side, 'Log ind og prøv igen').click();
  await vis(side, 'Du skal have net for at logge ind.');
  assert.equal(await side.evaluate(() => localStorage.getItem('testType')), 'udloebet');
  await kontekst.setOffline(false);
  await kontekst.close();
});

test('mikrofon nægtet', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('nej', 'NotAllowedError'); };
  });
  await logInd(side);
  await knap(side, 'Optag').click();
  await vis(side, 'Appen må ikke bruge mikrofonen.');
  assert.equal(await antalNoter(side), 0);
  await knap(side, 'Optag').waitFor();
  await kontekst.close();
});

test('øjeblikkeligt stop giver en forståelig besked eller navneskærm, aldrig en fejlet note', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').click();
  const tom = side.getByText('Der blev ikke optaget noget lyd');
  const felt = side.getByLabel(FELT);
  await tom.or(felt).first().waitFor({ timeout: 15000 });
  if (await felt.isVisible()) {
    await navngiv(side);
    await vis(side, SENDT);
  }
  await kontekst.close();
});

test('tjeneste-fejl vises, intet tabt, og det kan prøves igen med samme navn', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'tjeneste');
  await optag(side, { titel: 'Tjenestefejl' });
  await vis(side, 'Transskriptionen mislykkedes. Optagelsen er gemt.');
  assert.ok((await lydBytes(side)) > 0);
  await knap(side, 'Prøv igen').click();
  await vis(side, SENDT);
  assert.equal((await tal(miljoe)).sidsteReferat.titel, 'Tjenestefejl');
  await kontekst.close();
});

test('referat-fejl vises, intet tabt, og det kan prøves igen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'referat');
  await optag(side, { titel: 'Referatfejl' });
  await vis(side, 'Transskriptionen mislykkedes. Optagelsen er gemt.');
  assert.ok((await lydBytes(side)) > 0);
  await knap(side, 'Prøv igen').click();
  await vis(side, SENDT);
  await kontekst.close();
});

test('kan ikke behandles vises og kan slettes uden dialog', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'format');
  await optag(side);
  await vis(side, 'Optagelsen kunne ikke behandles.');
  await tilForsiden(side);
  side.once('dialog', () => assert.fail('der må ikke komme en dialog'));
  await knap(side, 'Slet').click();
  await vis(side, 'Optagelsen er slettet og bliver aldrig sendt.');
  await side.waitForTimeout(7500);
  assert.equal(await antalNoter(side), 0);
  await kontekst.close();
});

test('tavs optagelse viser besked og beholder lyden', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'tom');
  await optag(side);
  await vis(side, 'Der blev ikke fundet tale i optagelsen.');
  assert.ok((await lydBytes(side)) > 0);
  await kontekst.close();
});

test('mailfejl efter referat sender igen uden nyt referat', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await fejlMail(side);
  assert.equal(await antalNoter(side), 1);
  assert.ok((await lydBytes(side)) > 0);
  const foer = await tal(miljoe);
  // Prøv igen på skærmen efter Send sender mailen igen uden nyt referat.
  await knap(side, 'Prøv igen').click();
  await vis(side, SENDT);
  const efter = await tal(miljoe);
  assert.equal(efter.geminiKald, foer.geminiKald);
  assert.equal(efter.referatKald, foer.referatKald);
  assert.equal(await sendteUdenLyd(side), 1);
  await kontekst.close();
});

test('referatet kan læses efter genstart', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await fejlMail(side);
  await side.reload();
  await knap(side, 'Læs').click();
  await vis(side, 'Testreferat af');
  await knap(side, 'Send til mig').waitFor();
  await kontekst.close();
});

test('kan betjenes på 360 px', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { viewport: { width: 360, height: 640 } });
  await logInd(side);

  async function tjek(navn) {
    const m = await side.evaluate(() => ({
      bred: document.documentElement.scrollWidth,
      knapper: [...document.querySelectorAll('button')].map((b) => [b.textContent, b.getBoundingClientRect().height, b.getAttribute('role'), b.getBoundingClientRect().right, b.className]),
      lille: [...document.querySelectorAll('button, p, h1, h2, input')].map((e) => parseFloat(getComputedStyle(e).fontSize)),
    }));
    assert.ok(m.bred <= 360, `${navn}: vandret rulning, ${m.bred}`);
    assert.ok(m.knapper.length > 0, navn);
    for (const [tekst, hoejde, rolle, hoejre, klasse] of m.knapper) {
      const mindst = klasse.includes('top-knap') ? 44 : 72;
      assert.ok(Math.round(hoejde) >= mindst, `${navn}: "${tekst}" er ${hoejde} px`);
      assert.ok(hoejre <= 360, `${navn}: "${tekst}" går ud over kanten`);
    }
    for (const stoerrelse of m.lille) assert.ok(stoerrelse >= 18, `${navn}: tekst på ${stoerrelse} px`);
  }

  await tjek('start');
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await tjek('optager');
  await side.waitForTimeout(800);
  await knap(side, 'Stop').click();
  await side.getByLabel(FELT).waitFor();
  await tjek('navn');
  await saetNaesteFejl(miljoe, 'tjeneste');
  await navngiv(side, 'Smal skærm');
  await vis(side, 'Transskriptionen mislykkedes');
  await tjek('fejl');
  await knap(side, 'Prøv igen').click();
  await vis(side, SENDT);
  await tjek('sendt');
  await kontekst.close();
});

// Navn før optagelsen. Typen vælger AI'en.

const STARTNAVN = 'Navn (valgfrit)';

test('ingen typevalg nogen steder: forsiden og navneskærmen har kun navnet', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await vis(side, 'Indtal noter, møder og påmindelser. Du får et referat med PDF på din mail.');
  assert.equal(await side.getByRole('radio').count(), 0);
  assert.equal(await side.getByText('Type', { exact: true }).count(), 0);
  await stopOptagelse(side);
  await side.getByLabel(FELT).waitFor();
  assert.equal(await side.getByRole('radio').count(), 0);
  await vis(side, 'Appen finder også selv ud af, om det er et møde, et byggenotat, en påmindelse eller andet.');
  await kontekst.close();
});

test('navn før optagelse følger med til navneskærmen og mailen, og AI\'en vælger typen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await side.getByLabel(STARTNAVN).fill('Tagrenovering');
  await stopOptagelse(side);
  await side.getByLabel(FELT).waitFor();
  assert.equal(await side.getByLabel(FELT).inputValue(), 'Tagrenovering');
  await knap(side, 'Send').click();
  await vis(side, SENDT);
  const t = await tal(miljoe);
  // Ingen type sendt: serveren vælger selv (den falske AI vælger Andet).
  assert.equal(t.sidsteReferat.type, 'automatisk');
  assert.equal(t.sidsteReferat.titel, 'Tagrenovering');
  assert.match(t.sidsteMail.message.subject, /^Andet: Tagrenovering – \d{1,2}\. \S+ \d{4}$/);
  await tilForsiden(side);
  assert.equal(await side.getByLabel(STARTNAVN).inputValue(), '');
  await knap(side, 'Tidligere optagelser').click();
  await vis(side, 'Andet ·');
  await kontekst.close();
});

test('en gammel optagelse med valgt type sendes med typen, og en uden type vises uden typenavn', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    const gammel = await l.opretNote({ mime: 'audio/webm' });
    await l.gemStykke(gammel, 0, new Uint8Array(4000));
    await l.opdaterNote(gammel, { status: 'fejl', fejlType: 'net', type: 'moede', titel: 'Gammelt møde', navngivet: true, varighedMs: 5000 });
    const auto = await l.opretNote({ mime: 'audio/webm' });
    await l.gemStykke(auto, 0, new Uint8Array(4000));
    await l.opdaterNote(auto, { status: 'fejl', fejlType: 'net', type: 'automatisk', titel: 'Uden type før', navngivet: true, varighedMs: 5000 });
  });
  await side.reload();
  await knap(side, 'Tidligere optagelser').click();
  await vis(side, 'Gammelt møde');
  assert.equal(await side.getByText('Automatisk', { exact: false }).count(), 0, 'automatisk vises ikke som type');
  const meta = await side.locator('.meta').allTextContents();
  assert.ok(meta.some((m) => m.startsWith('Møde · ')), 'den gamle valgte type vises');
  assert.ok(meta.some((m) => m.startsWith('I dag')), 'uden type: intet typenavn foran');
  await side.locator('.kort', { hasText: 'Gammelt møde' }).getByRole('button', { name: 'Prøv igen' }).click();
  for (let i = 0; i < 100 && (await tal(miljoe)).sidsteReferat?.titel !== 'Gammelt møde'; i++) await side.waitForTimeout(100);
  assert.equal((await tal(miljoe)).sidsteReferat.type, 'moede');
  await kontekst.close();
});

test('navnet på startskærmen bevares, når en note bliver færdig i baggrunden', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'langsom');
  await optag(side, { titel: 'Første' });
  await tilForsiden(side);
  await side.getByLabel(STARTNAVN).fill('Næste no');
  await vis(side, SENDT);
  assert.equal(await side.getByLabel(STARTNAVN).inputValue(), 'Næste no');
  assert.equal(await side.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.id), 'startnavn');
  await kontekst.close();
});

test('optageskærmen beder om at lade skærmen være tændt', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await knap(side, 'Optag').click();
  await vis(side, 'Lad skærmen være tændt — læg telefonen med skærmen opad');
  await side.waitForTimeout(800);
  await knap(side, 'Stop').click();
  await navngiv(side);
  await vis(side, SENDT);
  await kontekst.close();
});

test('langt navn uden mellemrum giver ingen vandret rulning på 360 px', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { viewport: { width: 360, height: 640 } });
  await logInd(side);
  await side.getByLabel(STARTNAVN).fill(`Byggepladsgennemgang${'x'.repeat(100)}`);
  await saetNaesteFejl(miljoe, 'tjeneste');
  await stopOptagelse(side);
  await knap(side, 'Send').click();
  await vis(side, 'Transskriptionen mislykkedes');
  assert.ok(await side.evaluate(() => document.documentElement.scrollWidth) <= 360);
  await knap(side, 'Prøv igen').click();
  await vis(side, SENDT);
  await kontekst.close();
});

test('en anden fane uden Web Locks, der åbnes under optagelsen, sletter eller ændrer den ikke', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const foer = await tal(miljoe);
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  // Den anden fane åbner, før første stykke lyd er gemt, og kan ikke se låsene (som en ældre browser).
  const anden = await kontekst.newPage();
  await anden.addInitScript(() => Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined }));
  await anden.goto(miljoe.adresse);
  await knap(anden, 'Optag').waitFor();
  const noter = await anden.evaluate(async () => (await import('/js/lager.js')).alleNoter());
  assert.equal(noter.length, 1);
  assert.equal(noter[0].status, 'optager');
  await anden.close();
  await side.waitForTimeout(800);
  await knap(side, 'Stop').click();
  await navngiv(side, 'To faner');
  await vis(side, SENDT);
  const efter = await tal(miljoe);
  assert.equal(efter.mailKald - foer.mailKald, 1);
  assert.ok(efter.modtaget.bytes > 0);
  await kontekst.close();
});

// Tidligere optagelser og Send referat igen

const TIDLIGERE = 'Tidligere optagelser';

async function aabnTidligere(side) {
  await knap(side, TIDLIGERE).click();
  await side.getByRole('heading', { name: TIDLIGERE }).waitFor();
}

test('efter afsendelse ligger referatet under Tidligere optagelser med Sendt og Slettes om 7 dage', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await optag(side, { titel: 'Historik' });
  await vis(side, SENDT);
  await tilForsiden(side);
  assert.equal(await side.getByRole('heading', { name: 'Afventer' }).count(), 0);
  await aabnTidligere(side);
  await vis(side, 'Her finder du dine optagelser fra de sidste 7 dage. Optagelser, der endnu ikke er sendt, gemmes, indtil de er sendt.');
  assert.equal(await side.getByText('bliver, til de er sendt', { exact: false }).count(), 0);
  await vis(side, 'Historik');
  await vis(side, 'Sendt');
  await vis(side, 'Slettes om 7 dage');
  await knap(side, 'Send referat igen').waitFor();
  await knap(side, 'Tilbage').click();
  await knap(side, 'Optag').waitFor();
  await kontekst.close();
});

test('Send referat igen sender samme emne og pdf uden nyt Gemini- eller referatkald', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await optag(side, { titel: 'Igen' });
  await vis(side, SENDT);
  await tilForsiden(side);
  const foer = await tal(miljoe);
  await aabnTidligere(side);
  await knap(side, 'Send referat igen').click();
  await vis(side, 'Sendt igen kl.');
  const efter = await tal(miljoe);
  assert.equal(efter.geminiKald, foer.geminiKald);
  assert.equal(efter.referatKald, foer.referatKald);
  assert.equal(efter.mailKald, foer.mailKald + 1);
  assert.equal(efter.sidsteMail.message.subject, foer.sidsteMail.message.subject);
  assert.equal(efter.sidsteMail.message.attachments[0].contentBytes, foer.sidsteMail.message.attachments[0].contentBytes);
  await kontekst.close();
});

test('Læs fra Tidligere optagelser kan sende igen og fører tilbage til listen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await optag(side, { titel: 'Læses' });
  await vis(side, SENDT);
  await tilForsiden(side);
  await aabnTidligere(side);
  await knap(side, 'Læs').click();
  await vis(side, 'Testreferat af');
  await knap(side, 'Send referat igen').waitFor();
  await knap(side, 'Tilbage').click();
  await side.getByRole('heading', { name: TIDLIGERE }).waitFor();
  await kontekst.close();
});

test('fejlet optagelse vises som Fejlet med Slettes ikke, før den er sendt, og Prøv igen virker', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'tjeneste');
  await optag(side, { titel: 'Fejler' });
  await vis(side, 'Transskriptionen mislykkedes');
  await tilForsiden(side);
  await aabnTidligere(side);
  await vis(side, 'Fejlet');
  await vis(side, 'Slettes ikke, før den er sendt');
  await knap(side, 'Prøv igen').click();
  await vis(side, 'Slettes om 7 dage');
  await kontekst.close();
});

test('tom liste viser Ingen optagelser endnu.', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await aabnTidligere(side);
  await vis(side, 'Ingen optagelser endnu.');
  await kontekst.close();
});

test('Tidligere optagelser kan betjenes på 360 px', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { viewport: { width: 360, height: 640 } });
  await logInd(side);
  await optag(side, { titel: `Lang${'x'.repeat(100)}` });
  await vis(side, SENDT);
  await tilForsiden(side);
  await saetNaesteFejl(miljoe, 'tjeneste');
  await optag(side, { titel: 'Fejler på smal skærm' });
  await vis(side, 'Transskriptionen mislykkedes');
  await tilForsiden(side);
  await aabnTidligere(side);
  const m = await side.evaluate(() => ({
    bred: document.documentElement.scrollWidth,
    knapper: [...document.querySelectorAll('button')].map((b) => [b.textContent, Math.round(b.getBoundingClientRect().height), b.className]),
    tekst: [...document.querySelectorAll('button, p, h1, h2')].map((e) => parseFloat(getComputedStyle(e).fontSize)),
  }));
  assert.ok(m.bred <= 360, `vandret rulning: ${m.bred}`);
  for (const [tekst, hoejde, klasse] of m.knapper) assert.ok(hoejde >= (klasse.includes('top-knap') ? 44 : 72), `"${tekst}" er ${hoejde} px`);
  for (const s of m.tekst) assert.ok(s >= 16, `tekst på ${s} px`);
  await kontekst.close();
});

// Fortsæt optagelsen efter afbrydelse

const AFBRUDT = 'Optagelsen blev afbrudt — det optagede er gemt. Vil du fortsætte?';
const MARKOER = '[Optagelsen blev afbrudt her]';

/** Som når telefonen låses eller man skifter app. */
async function skjul(side) {
  await side.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function synlig(side) {
  await side.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function afbrydOptagelse(side) {
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await side.waitForTimeout(800);
  await skjul(side);
  await side.getByLabel(FELT).waitFor();
  await synlig(side);
}

async function fortsaetOgStop(side) {
  await knap(side, 'Fortsæt optagelsen').click();
  await knap(side, 'Stop').waitFor();
  await side.waitForTimeout(800);
  await knap(side, 'Stop').click();
  await side.getByLabel(FELT).waitFor();
}

test('skjult app under optagelse giver beskeden og Fortsæt optagelsen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await afbrydOptagelse(side);
  await vis(side, AFBRUDT);
  await knap(side, 'Fortsæt optagelsen').waitFor();
  await knap(side, 'Send').waitFor();
  await kontekst.close();
});

test('fortsat optagelse giver én mail med markøren og én pdf', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const foer = await tal(miljoe);
  await afbrydOptagelse(side);
  await fortsaetOgStop(side);
  assert.equal(await side.getByText(AFBRUDT).count(), 0);
  await navngiv(side, 'To dele');
  await vis(side, SENDT);
  const efter = await tal(miljoe);
  assert.equal(efter.geminiKald - foer.geminiKald, 2);
  assert.equal(efter.referatKald - foer.referatKald, 1);
  assert.equal(efter.mailKald - foer.mailKald, 1);
  assert.equal(efter.sidsteReferat.titel, 'To dele');
  assert.ok(efter.sidsteMail.message.body.content.includes(MARKOER));
  assert.equal(efter.sidsteMail.message.attachments.length, 1);
  await kontekst.close();
});

test('afbrudt og sendt uden at fortsætte giver mail med én del', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const foer = await tal(miljoe);
  await afbrydOptagelse(side);
  await navngiv(side, 'Én del');
  await vis(side, SENDT);
  const efter = await tal(miljoe);
  assert.equal(efter.geminiKald - foer.geminiKald, 1);
  assert.ok(!efter.sidsteMail.message.body.content.includes(MARKOER));
  await kontekst.close();
});

test('afbrudt note kan fortsættes efter genåbning', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const foer = await tal(miljoe);
  await afbrydOptagelse(side);
  await side.reload();
  await side.getByLabel(FELT).waitFor();
  await vis(side, AFBRUDT);
  await fortsaetOgStop(side);
  await navngiv(side, 'Genåbnet');
  await vis(side, SENDT);
  const efter = await tal(miljoe);
  assert.equal(efter.referatKald - foer.referatKald, 1);
  assert.ok(efter.sidsteMail.message.body.content.includes(MARKOER));
  await kontekst.close();
});

test('navneskærmen med Fortsæt optagelsen kan betjenes på 360 px', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { viewport: { width: 360, height: 640 } });
  await logInd(side);
  await afbrydOptagelse(side);
  const m = await side.evaluate(() => ({
    bred: document.documentElement.scrollWidth,
    knapper: [...document.querySelectorAll('button')].map((b) => [b.textContent, Math.round(b.getBoundingClientRect().height)]),
  }));
  assert.ok(m.bred <= 360, `vandret rulning: ${m.bred}`);
  for (const [tekst, hoejde] of m.knapper) assert.ok(hoejde >= 72, `"${tekst}" er ${hoejde} px`);
  await kontekst.close();
});

test('Tidligere optagelser kan ses øverst uden at rulle', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { viewport: { width: 360, height: 640 } });
  await logInd(side);
  const r = await knap(side, TIDLIGERE).boundingBox();
  assert.ok(r.y >= 0 && r.y + r.height <= 120, `knappen ligger ${Math.round(r.y)} px nede`);
  assert.ok(r.height >= 44, `knappen er ${r.height} px høj`);
  assert.ok(r.x + r.width <= 360);
  await kontekst.close();
});

// Notifikation, hvis appen skjules, mens referatet laves eller sendes

const IKKE_SENDT = 'Referatet er ikke sendt endnu — åbn appen igen, så det kan blive færdigt.';

/** Giver lov til notifikationer og gemmer dem, appen viser, i window.vist. */
async function fangNotifikationer(side) {
  await side.addInitScript(() => {
    window.vist = [];
    Object.defineProperty(window, 'Notification', { value: { permission: 'granted', requestPermission: async () => 'granted' }, configurable: true });
    ServiceWorkerRegistration.prototype.showNotification = async function (titel, valg) { window.vist.push(valg.body); };
  });
}

test('skjult app, mens referatet laves, giver en notifikation', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await fangNotifikationer(side);
  await logInd(side);
  await side.evaluate(() => navigator.serviceWorker.ready);
  await saetNaesteFejl(miljoe, 'langsom');
  await optag(side, { titel: 'Langsom' });
  await vis(side, 'Referatet laves');
  await skjul(side);
  await side.waitForFunction(() => window.vist.length > 0, null, { timeout: 5000 });
  assert.deepEqual(await side.evaluate(() => window.vist), [IKKE_SENDT]);
  await synlig(side);
  await vis(side, SENDT);
  await kontekst.close();
});

test('skjult app uden noget i gang giver ingen notifikation', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await fangNotifikationer(side);
  await logInd(side);
  await optag(side, { titel: 'Færdig' });
  await vis(side, SENDT);
  await skjul(side);
  await side.waitForTimeout(300);
  assert.deepEqual(await side.evaluate(() => window.vist), []);
  await kontekst.close();
});

// Notifikation, når optagelsen stopper i baggrunden, uanset hvilket signal der kommer først

const STOPPET_NY = 'Optagelsen er stoppet. Åbn appen og hold den åben, mens du optager.';

async function gemStream(side) {
  await side.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (krav) => { window.testStream = await original(krav); return window.testStream; };
  });
}

async function startOptagelse(side) {
  await logInd(side);
  await side.evaluate(() => navigator.serviceWorker.ready);
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await side.waitForTimeout(800);
}

const mute = (side) => side.evaluate(() => window.testStream.getAudioTracks()[0].dispatchEvent(new Event('mute')));

test('mikrofonen stopper før appen skjules: én notifikation', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await fangNotifikationer(side);
  await gemStream(side);
  await startOptagelse(side);
  await mute(side);
  await side.waitForTimeout(100);
  await skjul(side);
  await side.waitForFunction(() => window.vist.length > 0, null, { timeout: 5000 });
  await side.waitForTimeout(300);
  assert.deepEqual(await side.evaluate(() => window.vist), [STOPPET_NY]);
  await kontekst.close();
});

test('appen skjules før mikrofonen stopper: én notifikation', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await fangNotifikationer(side);
  await gemStream(side);
  await startOptagelse(side);
  await skjul(side);
  await mute(side);
  await side.waitForFunction(() => window.vist.length > 0, null, { timeout: 5000 });
  await side.waitForTimeout(300);
  assert.deepEqual(await side.evaluate(() => window.vist), [STOPPET_NY]);
  await kontekst.close();
});

test('stop med knappen og skjul bagefter: ingen notifikation', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await fangNotifikationer(side);
  await startOptagelse(side);
  await knap(side, 'Stop').click();
  await side.getByLabel(FELT).waitFor();
  await skjul(side);
  await side.waitForTimeout(300);
  assert.deepEqual(await side.evaluate(() => window.vist), []);
  await kontekst.close();
});

test('appen lukket under optagelse åbner direkte på den afbrudte optagelse', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await side.waitForTimeout(6000); // Mindst ét stykke lyd er gemt.
  await side.goto(`${miljoe.adresse}/test/tom`);
  await side.goto(miljoe.adresse);
  await side.getByLabel(FELT).waitFor({ timeout: 15000 });
  await vis(side, AFBRUDT);
  await knap(side, 'Fortsæt optagelsen').waitFor();
  await knap(side, 'Send').waitFor();
  await kontekst.close();
});

// Skærmen efter Send: fire trin

test('efter Send vises trinene, og til sidst at referatet er sendt til mailadressen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'langsom');
  await optag(side, { titel: 'Trin' });
  await vis(side, 'Optagelsen er gemt');
  await vis(side, 'Sendes til test@ollgaard.dk');
  await vis(side, 'Hold appen åben, til referatet er sendt.');
  await vis(side, SENDT);
  assert.equal(await side.getByText('Referatet er lavet').count(), 1);
  await knap(side, 'Ny optagelse').click();
  await knap(side, 'Optag').waitFor();
  await kontekst.close();
});

test('langsomt referat viser Lyden er sendt, Referatet laves og Det kan tage et par minutter', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'langsom');
  await optag(side, { titel: 'Langsomt' });
  await vis(side, 'Referatet laves …');
  await vis(side, 'Det kan tage et par minutter.');
  await vis(side, 'Lyden er sendt');
  await vis(side, SENDT);
  await kontekst.close();
});

test('fejl viser en venlig besked og Prøv igen, og Prøv igen sender', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'tjeneste');
  await optag(side, { titel: 'Fejl' });
  await vis(side, 'Referatet kunne ikke laves lige nu');
  await vis(side, 'Optagelsen er gemt');
  await knap(side, 'Til forsiden').waitFor();
  await knap(side, 'Prøv igen').click();
  await vis(side, SENDT);
  await kontekst.close();
});

test('skærmen efter Send kan betjenes på 360 px', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { viewport: { width: 360, height: 640 } });
  await logInd(side);
  await optag(side, { titel: `Lang${'x'.repeat(100)}` });
  await vis(side, SENDT);
  const m = await side.evaluate(() => ({
    bred: document.documentElement.scrollWidth,
    knapper: [...document.querySelectorAll('button')].map((b) => [b.textContent, Math.round(b.getBoundingClientRect().height)]),
  }));
  assert.ok(m.bred <= 360, `vandret rulning: ${m.bred}`);
  for (const [tekst, hoejde] of m.knapper) assert.ok(hoejde >= 72, `"${tekst}" er ${hoejde} px`);
  await kontekst.close();
});

// Slet med Fortryd

test('Slet i Tidligere viser Fortryd, og Fortryd bringer optagelsen tilbage', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await optag(side, { titel: 'Fortrydes' });
  await vis(side, SENDT);
  await tilForsiden(side);
  await aabnTidligere(side);
  await knap(side, 'Slet').click();
  await vis(side, 'Optagelsen er slettet.');
  await vis(side, 'Ingen optagelser endnu.');
  await knap(side, 'Fortryd').click();
  await vis(side, 'Fortrydes');
  await side.waitForTimeout(7500);
  assert.equal(await antalNoter(side), 1);
  await kontekst.close();
});

test('en optagelse, der ikke er sendt, er helt væk efter Fortryd-tiden', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'tjeneste');
  await optag(side, { titel: 'Væk' });
  await vis(side, 'Referatet kunne ikke laves lige nu');
  await tilForsiden(side);
  await aabnTidligere(side);
  await knap(side, 'Slet').click();
  await vis(side, 'Optagelsen er slettet og bliver aldrig sendt.');
  await side.waitForTimeout(7500);
  assert.equal(await antalNoter(side), 0);
  assert.equal(await side.getByRole('button', { name: 'Fortryd' }).count(), 0);
  await kontekst.close();
});

test('slet under afsendelse stopper den, og der sendes ingen mail', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const foer = await tal(miljoe);
  await saetNaesteFejl(miljoe, 'langsom');
  await optag(side, { titel: 'Stoppes' });
  await vis(side, 'Referatet laves');
  await tilForsiden(side);
  await knap(side, 'Slet').click();
  await vis(side, 'Optagelsen er slettet og bliver aldrig sendt.');
  await side.waitForTimeout(8000);
  assert.equal((await tal(miljoe)).mailKald, foer.mailKald);
  assert.equal(await antalNoter(side), 0);
  await kontekst.close();
});

// Rettelser efter gennemgang

test('Stop og lås med det samme giver ingen notifikation', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await fangNotifikationer(side);
  await startOptagelse(side);
  await knap(side, 'Stop').click();
  await skjul(side);
  await side.waitForTimeout(800);
  assert.deepEqual(await side.evaluate(() => window.vist), []);
  await kontekst.close();
});

test('en fortsat optagelse, der afbrydes igen, giver en ny notifikation', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await fangNotifikationer(side);
  await gemStream(side);
  await startOptagelse(side);
  await skjul(side);
  await side.waitForFunction(() => window.vist.length === 1, null, { timeout: 5000 });
  await side.getByLabel(FELT).waitFor();
  await synlig(side);
  await knap(side, 'Fortsæt optagelsen').click();
  await knap(side, 'Stop').waitFor();
  await side.waitForTimeout(800);
  await mute(side);
  await skjul(side);
  await side.waitForFunction(() => window.vist.length === 2, null, { timeout: 5000 });
  await kontekst.close();
});

test('en gammel afbrudt optagelse åbner ikke navneskærmen, og navneskærmen har Til forsiden', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await afbrydOptagelse(side);
  await knap(side, 'Til forsiden').click();
  await knap(side, 'Optag').waitFor();
  // To timer gammel: appen åbner på forsiden, og noten ligger i Afventer.
  await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    const [note] = await l.alleNoter();
    const gammel = Date.now() - 2 * 60 * 60 * 1000;
    await l.opdaterNote(note.id, { oprettet: gammel, sidstAktiv: gammel });
  });
  await side.reload();
  await knap(side, 'Optag').waitFor();
  await vis(side, AFBRUDT);
  assert.equal(await side.getByLabel(FELT).count(), 0);
  await kontekst.close();
});

test('Fortryd-bjælken er den samme, mens skærmen tegnes igen, og glider derfor kun ind én gang', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await optag(side, { titel: 'Bjælke' });
  await vis(side, SENDT);
  await tilForsiden(side);
  await aabnTidligere(side);
  await knap(side, 'Slet').click();
  await knap(side, 'Fortryd').waitFor();
  await side.evaluate(() => { window.foersteBjaelke = document.querySelector('.toast'); });
  await knap(side, 'Tilbage').click();
  await knap(side, 'Optag').waitFor();
  assert.equal(await side.evaluate(() => document.querySelector('.toast') === window.foersteBjaelke), true);
  await knap(side, 'Fortryd').click();
  assert.equal(await side.locator('.toast').count(), 0);
  await kontekst.close();
});

// Tilbage i toppen og Information

test('Information viser afsnittene og en klikbar mailadresse, og Tilbage fører til forsiden', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await knap(side, 'Information').click();
  await side.getByRole('heading', { name: 'Information', exact: true }).waitFor();
  for (const overskrift of ['Hvad appen kan bruges til', 'Sådan bruger du den', 'Vigtigt at vide', 'Kontakt']) {
    await side.getByRole('heading', { name: overskrift }).waitFor();
  }
  await vis(side, 'Brug appen fra hjemmeskærmen');
  await vis(side, 'Tjek altid vigtige tal, mål og frister.');
  const link = side.getByRole('link', { name: 'rw@ollgaard.dk' });
  assert.equal(await link.getAttribute('href'), 'mailto:rw@ollgaard.dk');
  await knap(side, 'Tilbage').click();
  await knap(side, 'Optag').waitFor();
  await kontekst.close();
});

test('Tilbage sidder øverst og ens på Tidligere, Læs og Information', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { viewport: { width: 360, height: 640 } });
  await logInd(side);
  await optag(side, { titel: 'Tilbage øverst' });
  await vis(side, SENDT);
  await tilForsiden(side);
  const maal = async () => {
    const tilbage = knap(side, 'Tilbage');
    assert.equal(await tilbage.count(), 1, 'præcis én Tilbage');
    const r = await tilbage.boundingBox();
    assert.ok(r.y >= 0 && r.y < 80 && r.x < 60, `Tilbage sidder ${Math.round(r.x)},${Math.round(r.y)}`);
    assert.ok(r.height >= 44);
    return { klasse: await tilbage.getAttribute('class'), hoejde: Math.round(r.height) };
  };
  await aabnTidligere(side);
  const tidligere = await maal();
  await knap(side, 'Læs').click();
  await vis(side, 'Testreferat af');
  const laes = await maal();
  await knap(side, 'Tilbage').click();
  await side.getByRole('heading', { name: TIDLIGERE }).waitFor();
  await knap(side, 'Tilbage').click();
  await knap(side, 'Information').click();
  const information = await maal();
  assert.deepEqual(laes, tidligere);
  assert.deepEqual(information, tidligere);
  assert.ok(await side.evaluate(() => document.documentElement.scrollWidth) <= 360);
  await kontekst.close();
});

// Login, der fornyes af sig selv

const IKKE_LOGGET_IND = 'Du er ikke logget ind. Du kan stadig optage. Log ind for at få dine referater sendt.';
const fornyelser = (side) => side.evaluate(() => Number(localStorage.getItem('testFornyelser') || 0));

test('logget ud med session hos Microsoft: logges ind af sig selv uden tryk', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await side.evaluate(() => localStorage.removeItem('testKonto'));
  await side.reload();
  await side.waitForFunction(() => localStorage.getItem('testKonto') === '1', null, { timeout: 15000 });
  await knap(side, 'Optag').waitFor();
  await side.waitForTimeout(500);
  assert.equal(await side.getByText(IKKE_LOGGET_IND).count(), 0);
  assert.equal(await fornyelser(side), 1);
  await kontekst.close();
});

test('logget ud uden session: boksen vises, ingen løkke, optagelse virker, og login via boksen sender den', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await side.evaluate(() => { localStorage.removeItem('testKonto'); localStorage.removeItem('testSession'); });
  await side.reload();
  await vis(side, IKKE_LOGGET_IND);
  await side.reload();
  await vis(side, IKKE_LOGGET_IND);
  assert.equal(await fornyelser(side), 1, 'højst ét forsøg på at forny');
  const foer = await tal(miljoe);
  await optag(side, { titel: 'Venter på login' });
  await vis(side, 'Du skal logge ind igen. Optagelsen er gemt.');
  assert.equal(await antalNoter(side), 1);
  await tilForsiden(side);
  await knap(side, 'Log ind med din ØLLGAARD-konto').click();
  await knap(side, 'Optag').waitFor({ timeout: 15000 });
  // Lageret læses asynkront, så der ventes i en løkke. Et async-udtryk i waitForFunction er altid sandt.
  for (let i = 0; i < 150 && (await sendteUdenLyd(side)) !== 1; i++) await side.waitForTimeout(100);
  assert.equal(await sendteUdenLyd(side), 1);
  assert.equal((await tal(miljoe)).mailKald, foer.mailKald + 1);
  assert.equal(await side.getByText(IKKE_LOGGET_IND).count(), 0);
  await kontekst.close();
});

test('logget ind: ingen login-boks', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await side.waitForTimeout(500);
  assert.equal(await side.getByText(IKKE_LOGGET_IND).count(), 0);
  await kontekst.close();
});

test('Information viser kontoen, og Log ud viser boksen og beholder optagelser', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'tjeneste');
  await optag(side, { titel: 'Bliver' });
  await vis(side, 'Referatet kunne ikke laves lige nu');
  await tilForsiden(side);
  await knap(side, 'Information').click();
  await vis(side, 'Logget ind som test@ollgaard.dk');
  await vis(side, 'Vil du forblive logget på?');
  await knap(side, 'Log ud').click();
  await knap(side, 'Optag').waitFor();
  await vis(side, IKKE_LOGGET_IND);
  assert.equal(await antalNoter(side), 1);
  // Efter Log ud logger appen ikke selv ind igen, selv om sessionen hos Microsoft findes.
  await side.reload();
  await vis(side, IKKE_LOGGET_IND);
  assert.equal(await fornyelser(side), 0);
  await knap(side, 'Information').click();
  await vis(side, 'Du er ikke logget ind.');
  await knap(side, 'Log ind med din ØLLGAARD-konto').waitFor();
  await kontekst.close();
});

test('uden net ved start: ingen fornyelse', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await side.evaluate(async () => { await navigator.serviceWorker.ready; localStorage.removeItem('testKonto'); });
  await kontekst.setOffline(true);
  await side.reload();
  await knap(side, 'Optag').waitFor();
  await side.waitForTimeout(500);
  assert.equal(await fornyelser(side), 0);
  assert.equal(await side.getByText(IKKE_LOGGET_IND).count(), 0);
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await kontekst.setOffline(false);
  await kontekst.close();
});

test('login-boksen kan betjenes på 360 px', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { viewport: { width: 360, height: 640 } });
  await logInd(side);
  await side.evaluate(() => { localStorage.removeItem('testKonto'); localStorage.removeItem('testSession'); });
  await side.reload();
  await vis(side, IKKE_LOGGET_IND);
  const r = await knap(side, 'Log ind med din ØLLGAARD-konto').boundingBox();
  assert.ok(r.height >= 72 && r.x + r.width <= 360);
  assert.ok(await side.evaluate(() => document.documentElement.scrollWidth) <= 360);
  await kontekst.close();
});

test('under fornyelsen kan Optag ikke trykkes, og går appen i gang med andet, skifter den ikke', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await side.evaluate(() => { localStorage.removeItem('testKonto'); localStorage.setItem('testFornyVent', '1500'); });
  await side.reload();
  await vis(side, 'Logger ind …');
  assert.equal(await knap(side, 'Optag').isDisabled(), true);
  await knap(side, 'Information').click();
  await side.waitForTimeout(2000);
  assert.equal(await side.evaluate(() => localStorage.getItem('testKonto')), null);
  assert.equal(await fornyelser(side), 0);
  await knap(side, 'Tilbage').click();
  await vis(side, IKKE_LOGGET_IND);
  assert.equal(await knap(side, 'Optag').isDisabled(), false);
  await kontekst.close();
});

test('to optagelser venter på login: begge sendes efter login, og boksen forsvinder', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await side.evaluate(() => { localStorage.removeItem('testKonto'); localStorage.removeItem('testSession'); });
  await side.reload();
  await vis(side, IKKE_LOGGET_IND);
  const foer = await tal(miljoe);
  await optag(side, { titel: 'Første' });
  await vis(side, 'Du skal logge ind igen. Optagelsen er gemt.');
  await tilForsiden(side);
  await optag(side, { titel: 'Anden' });
  await vis(side, 'Du skal logge ind igen. Optagelsen er gemt.');
  await tilForsiden(side);
  await knap(side, 'Log ind med din ØLLGAARD-konto').click();
  await knap(side, 'Optag').waitFor({ timeout: 15000 });
  for (let i = 0; i < 150 && (await sendteUdenLyd(side)) !== 2; i++) await side.waitForTimeout(100);
  assert.equal(await sendteUdenLyd(side), 2);
  assert.equal((await tal(miljoe)).mailKald, foer.mailKald + 2);
  assert.equal(await side.getByText(IKKE_LOGGET_IND).count(), 0);
  await kontekst.close();
});

// Forsiden kan ses uden at rulle

for (const [navn, viewport] of [['iPhone SE', { width: 375, height: 647 }], ['stor iPhone', { width: 393, height: 759 }]]) {
  test(`forsiden kan ses uden at rulle på ${navn}`, async () => {
    const { kontekst, side } = await nyTelefon(miljoe, { viewport });
    // Som den installerede app på hjemmeskærmen: uden hjælpen til at lægge den der.
    await side.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true }));
    await logInd(side);
    await side.waitForTimeout(300);
    const m = await side.evaluate(() => ({ rul: document.documentElement.scrollHeight - innerHeight, hoejde: innerHeight }));
    assert.ok(m.rul <= 0, `${navn}: rul ${m.rul} px`);
    for (const k of [knap(side, 'Optag'), knap(side, 'Tidligere optagelser'), knap(side, 'Information')]) {
      const r = await k.boundingBox();
      assert.ok(r.y >= 0 && r.y + r.height <= m.hoejde, `${navn}: knap uden for skærmen`);
    }
    await kontekst.close();
  });
}
