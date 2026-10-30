'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMiljoe, nyTelefon, tal, saetNaesteFejl } = require('./hjaelpere.js');

let miljoe;
before(async () => { miljoe = await startMiljoe(); });
after(async () => { await miljoe.stop(); });

const knap = (side, navn) => side.getByRole('button', { name: navn, exact: true });

async function vis(side, tekst) {
  await side.getByText(tekst, { exact: false }).first().waitFor({ timeout: 15000 });
}

async function logInd(side, type = 'medarbejder') {
  await side.goto(miljoe.adresse);
  await side.evaluate((t) => localStorage.setItem('testNaesteType', t), type);
  await knap(side, 'Log ind').click();
  await knap(side, 'Optag').waitFor({ timeout: 15000 });
}

async function optag(side, ms = 800) {
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await side.waitForTimeout(ms);
  await knap(side, 'Stop').click();
}

const antalNoter = (side) => side.evaluate(async () => (await (await import('/js/lager.js')).alleNoter()).length);

async function lydBytes(side) {
  return side.evaluate(async () => {
    const l = await import('/js/lager.js');
    const [note] = await l.alleNoter();
    return (await l.hentLyd(note.id)).size;
  });
}

test('hele forløbet', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  const foer = await tal(miljoe);
  await logInd(side);
  await optag(side);
  await vis(side, 'Testtekst fra lokal server');
  const midt = await tal(miljoe);
  assert.equal(midt.geminiKald - foer.geminiKald, 1);
  assert.ok(midt.modtaget.bytes > 0);
  assert.match(midt.modtaget.mime, /^audio\/(mp4|webm)/);

  await knap(side, 'Send til mig').click();
  await vis(side, 'Mailen er sendt til test@ollgaard.dk');
  const efter = await tal(miljoe);
  assert.equal(efter.mailKald - foer.mailKald, 1);
  assert.deepEqual(efter.sidsteMail.message.toRecipients, [{ emailAddress: { address: 'test@ollgaard.dk' } }]);
  assert.match(efter.sidsteMail.message.body.content, /Testtekst/);
  assert.equal(await antalNoter(side), 0);
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
  await vis(side, 'Testtekst');
  await kontekst.close();
});

test('optagelse overlever netværksfejl', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await side.evaluate(async () => { await navigator.serviceWorker.ready; });
  const foer = await tal(miljoe);

  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await side.waitForTimeout(800);
  await kontekst.setOffline(true);
  await knap(side, 'Stop').click();
  await vis(side, 'Ingen forbindelse. Optagelsen er gemt.');
  const bytes = await lydBytes(side);
  assert.ok(bytes > 0);

  await side.reload();
  await vis(side, 'Ingen forbindelse. Optagelsen er gemt.');
  assert.equal(await lydBytes(side), bytes);

  await kontekst.setOffline(false);
  await knap(side, 'Prøv igen').click();
  await vis(side, 'Testtekst');
  const efter = await tal(miljoe);
  assert.equal(efter.geminiKald - foer.geminiKald, 1);
  assert.equal(efter.modtaget.bytes, bytes);
  await kontekst.close();
});

for (const type of ['fremmed', 'gaest', 'uden-rolle']) {
  test(`fremmed koster ikke penge: ${type}`, async () => {
    const { kontekst, side } = await nyTelefon(miljoe);
    const foer = await tal(miljoe);
    await logInd(side, type);
    await optag(side);
    await vis(side, 'Din konto har ikke adgang til appen.');
    assert.equal((await tal(miljoe)).geminiKald, foer.geminiKald);
    assert.ok((await lydBytes(side)) > 0);
    await kontekst.close();
  });
}

test('login-forløb overlever genindlæsning', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side, 'udloebet');
  await optag(side);
  await vis(side, 'Du skal logge ind igen. Optagelsen er gemt.');
  const bytes = await lydBytes(side);
  await side.evaluate(() => localStorage.setItem('testNaesteType', 'medarbejder'));
  await knap(side, 'Log ind og prøv igen').click();
  await vis(side, 'Testtekst');
  assert.equal((await tal(miljoe)).modtaget.bytes, bytes);
  await kontekst.close();
});

test('app dræbt under optagelse', async () => {
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
  await knap(ny, 'Prøv igen').click();
  await vis(ny, 'Testtekst');
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
  await vis(side, 'Testtekst');
  await kontekst.close();
});

test('måske sendt: advarsel, ingen automatisk afsendelse, og noten kan fjernes', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await optag(side);
  await vis(side, 'Testtekst');
  const foer = await tal(miljoe);
  await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    const [note] = await l.alleNoter();
    await l.opdaterNote(note.id, { status: 'sender-mail' });
  });
  await side.reload();
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
  await optag(side);
  await vis(side, 'Testtekst');
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

test('øjeblikkeligt stop giver en forståelig besked eller tekst, aldrig en fejlet note', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').click();
  await side.getByText(/Der blev ikke optaget noget lyd|Testtekst/).first().waitFor({ timeout: 15000 });
  await kontekst.close();
});

test('tjeneste-fejl vises, intet tabt, og det kan prøves igen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await saetNaesteFejl(miljoe, 'tjeneste');
  await optag(side);
  await vis(side, 'Transskriptionen mislykkedes. Optagelsen er gemt.');
  assert.ok((await lydBytes(side)) > 0);
  await knap(side, 'Prøv igen').click();
  await vis(side, 'Testtekst');
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

test('mailfejl viser besked, beholder alt, og det kan prøves igen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await optag(side);
  await vis(side, 'Testtekst');
  await saetNaesteFejl(miljoe, 'mail');
  await knap(side, 'Send til mig').click();
  await vis(side, 'Mailen blev ikke sendt. Teksten er gemt.');
  await vis(side, 'Testtekst');
  assert.equal(await antalNoter(side), 1);
  assert.ok((await lydBytes(side)) > 0);
  await knap(side, 'Send til mig').click();
  await vis(side, 'Mailen er sendt');
  assert.equal(await antalNoter(side), 0);
  await kontekst.close();
});

test('tekst kan genfindes efter genstart', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await optag(side);
  await vis(side, 'Testtekst');
  await side.reload();
  await knap(side, 'Læs og send').click();
  await vis(side, 'Testtekst');
  await knap(side, 'Send til mig').waitFor();
  await kontekst.close();
});

test('kan betjenes på 360 px', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { viewport: { width: 360, height: 640 } });
  await logInd(side);

  async function tjek(navn) {
    const m = await side.evaluate(() => ({
      bred: document.documentElement.scrollWidth,
      knapper: [...document.querySelectorAll('button')].map((b) => [b.textContent, b.getBoundingClientRect().height]),
      lille: [...document.querySelectorAll('button, p, h1, h2')].map((e) => parseFloat(getComputedStyle(e).fontSize)),
    }));
    assert.ok(m.bred <= 360, `${navn}: vandret rulning, ${m.bred}`);
    assert.ok(m.knapper.length > 0, navn);
    for (const [tekst, hoejde] of m.knapper) assert.ok(hoejde >= 72, `${navn}: "${tekst}" er ${hoejde} px`);
    for (const stoerrelse of m.lille) assert.ok(stoerrelse >= 18, `${navn}: tekst på ${stoerrelse} px`);
  }

  await tjek('start');
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await tjek('optager');
  await saetNaesteFejl(miljoe, 'tjeneste');
  await side.waitForTimeout(800);
  await knap(side, 'Stop').click();
  await vis(side, 'Transskriptionen mislykkedes');
  await tjek('fejl');
  await knap(side, 'Prøv igen').click();
  await vis(side, 'Testtekst');
  await tjek('tekst');
  await kontekst.close();
});
