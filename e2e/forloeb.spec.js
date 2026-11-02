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

const antalNoter = (side) => side.evaluate(async () => (await (await import('/js/lager.js')).alleNoter()).length);

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
  assert.equal(await antalNoter(side), 0);
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
  await knap(ny, 'Navngiv og send').click();
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
  await side.evaluate(() => localStorage.removeItem('testKonto'));
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
  await knap(side, 'Jeg har fået mailen, slet').click();
  await knap(side, 'Optag').waitFor();
  assert.equal(await antalNoter(side), 0);
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

test('kan ikke behandles vises og kan slettes med bekræftelse', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'format');
  await optag(side);
  await vis(side, 'Optagelsen kunne ikke behandles.');

  side.once('dialog', (d) => d.dismiss());
  await knap(side, 'Slet').click();
  assert.equal(await antalNoter(side), 1);

  side.once('dialog', (d) => d.accept());
  await knap(side, 'Slet').click();
  await side.getByText('Optagelsen kunne ikke behandles.').waitFor({ state: 'detached' });
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
  await knap(side, 'Send igen').click();
  await vis(side, SENDT);
  const efter = await tal(miljoe);
  assert.equal(efter.geminiKald, foer.geminiKald);
  assert.equal(efter.referatKald, foer.referatKald);
  assert.equal(await antalNoter(side), 0);
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
      knapper: [...document.querySelectorAll('button')].map((b) => [b.textContent, b.getBoundingClientRect().height, b.getAttribute('role'), b.getBoundingClientRect().right]),
      lille: [...document.querySelectorAll('button, p, h1, h2, input')].map((e) => parseFloat(getComputedStyle(e).fontSize)),
    }));
    assert.ok(m.bred <= 360, `${navn}: vandret rulning, ${m.bred}`);
    assert.ok(m.knapper.length > 0, navn);
    for (const [tekst, hoejde, rolle, hoejre] of m.knapper) {
      assert.ok(Math.round(hoejde) >= (rolle === 'radio' ? 56 : 72), `${navn}: "${tekst}" er ${hoejde} px`);
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

// Typer og navn før optagelsen

const radio = (side, navn) => side.getByRole('radio', { name: navn, exact: true });
const STARTNAVN = 'Navn (valgfrit)';

test('navn og type før optagelse følger med til navneskærmen og mailen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  assert.equal(await radio(side, 'Automatisk').getAttribute('aria-checked'), 'true');
  await radio(side, 'Møde').click();
  assert.equal(await radio(side, 'Møde').getAttribute('aria-checked'), 'true');
  assert.equal(await radio(side, 'Automatisk').getAttribute('aria-checked'), 'false');
  await side.getByLabel(STARTNAVN).fill('Tagrenovering');
  await stopOptagelse(side);
  await side.getByLabel(FELT).waitFor();
  assert.equal(await side.getByLabel(FELT).inputValue(), 'Tagrenovering');
  assert.equal(await radio(side, 'Møde').getAttribute('aria-checked'), 'true');
  await knap(side, 'Send').click();
  await vis(side, SENDT);
  const t = await tal(miljoe);
  assert.equal(t.sidsteReferat.type, 'moede');
  assert.equal(t.sidsteReferat.titel, 'Tagrenovering');
  assert.match(t.sidsteMail.message.subject, /^Møde: Tagrenovering – \d{1,2}\. \S+ \d{4}$/);
  await kontekst.close();
});

test('type kan skiftes på navneskærmen uden at miste det skrevne navn', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await stopOptagelse(side);
  await side.getByLabel(FELT).fill('Ring til VVS');
  await radio(side, 'Påmindelse').click();
  assert.equal(await side.getByLabel(FELT).inputValue(), 'Ring til VVS');
  await knap(side, 'Send').click();
  await vis(side, SENDT);
  assert.match((await tal(miljoe)).sidsteMail.message.subject, /^Påmindelse: Ring til VVS – /);
  await kontekst.close();
});

test('navn og type nulstilles, når optagelsen er startet', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await radio(side, 'Byggenotat').click();
  await side.getByLabel(STARTNAVN).fill('Gåtur');
  await optag(side, { titel: 'Gåtur' });
  await vis(side, SENDT);
  assert.equal(await radio(side, 'Automatisk').getAttribute('aria-checked'), 'true');
  assert.equal(await side.getByLabel(STARTNAVN).inputValue(), '');
  await kontekst.close();
});

test('navnet på startskærmen bevares, når en note bliver færdig i baggrunden', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'langsom');
  await optag(side, { titel: 'Første' });
  await side.getByLabel(STARTNAVN).fill('Næste no');
  await vis(side, SENDT);
  assert.equal(await side.getByLabel(STARTNAVN).inputValue(), 'Næste no');
  assert.equal(await side.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.id), 'startnavn');
  await kontekst.close();
});

test('forklaringen kan skjules og forbliver skjult efter genindlæsning', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await vis(side, 'Sådan gør du');
  await vis(side, 'Du får et referat på mail.');
  for (const navn of ['Byggenotat', 'Møde', 'Påmindelse', 'Andet']) {
    assert.ok(await side.locator('.forklaring-kort').getByText(navn, { exact: true }).count(), navn);
  }
  await knap(side, 'Skjul forklaringen').click();
  await side.reload();
  await knap(side, 'Optag').waitFor();
  assert.equal(await side.getByText('Sådan gør du').count(), 0);
  await knap(side, 'Vis forklaring').click();
  await vis(side, 'Sådan gør du');
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
