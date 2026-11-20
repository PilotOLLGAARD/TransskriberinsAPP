'use strict';
// Feedback til Rasmus: sendes fra brugerens egen konto via (falsk) Microsoft Graph. Serveren og AI'en er ikke med.

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startMiljoe, nyTelefon, ryd, tal } = require('./hjaelpere.js');

let miljoe;
before(async () => { miljoe = await startMiljoe(); });
after(async () => { await miljoe.stop(); });
afterEach(async () => { await ryd(miljoe); });

const knap = (side, navn) => side.getByRole('button', { name: navn, exact: true });
const TAK = 'Tak! Din feedback er sendt til Rasmus.';

async function logInd(side) {
  await side.goto(miljoe.adresse);
  await side.evaluate(() => localStorage.setItem('testNaesteType', 'medarbejder'));
  await knap(side, 'Log ind').click();
  await knap(side, 'Optag').waitFor({ timeout: 15000 });
}

async function aabnOgSkriv(side, tekst) {
  await knap(side, 'Giv feedback').click();
  await side.getByRole('heading', { name: 'Giv feedback' }).waitFor();
  await side.getByLabel('Din feedback').fill(tekst);
}

const koe = (side) => side.evaluate(() => JSON.parse(localStorage.getItem('feedbackKoe') ?? '[]').length);

test('feedback sendes som ren tekst til Rasmus fra brugerens egen konto, og der står tak', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const foer = await tal(miljoe);
  const transskriber = [];
  side.on('request', (r) => { if (/\/(transskriber|referat)$/.test(r.url())) transskriber.push(r.url()); });
  await aabnOgSkriv(side, 'Knappen er nem at ramme.\nMen <b>teksten</b> er lille.');
  // Ikke anonym, og det står der.
  await side.getByText('Han kan se dit navn og svare dig, så den er ikke anonym.').waitFor();
  await knap(side, 'Send').click();
  await side.getByText(TAK).waitFor({ timeout: 15000 });
  await knap(side, 'Optag').waitFor();
  const t = await tal(miljoe);
  assert.equal(t.mailKald, foer.mailKald + 1);
  const m = t.sidsteMail.message;
  assert.deepEqual(m.toRecipients, [{ emailAddress: { address: 'rw@ollgaard.dk' } }]);
  assert.equal(m.subject, 'Feedback på transskriberingsappen');
  assert.equal(m.body.contentType, 'Text');
  assert.match(m.body.content, /^Knappen er nem at ramme\.\nMen <b>teksten<\/b> er lille\./);
  assert.match(m.body.content, /App-version: udvikling/);
  assert.match(m.body.content, /Telefon: /);
  assert.equal(t.sidsteMail.saveToSentItems, true);
  assert.equal(transskriber.length, 0, 'serveren og AI\'en er ikke med');
  assert.equal(await koe(side), 0);
  await kontekst.close();
});

test('uden net gemmes feedbacken og sendes af sig selv, når nettet kommer igen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const foer = await tal(miljoe);
  await aabnOgSkriv(side, 'Skrevet uden net.');
  await kontekst.setOffline(true);
  await knap(side, 'Send').click();
  await side.getByText('Ingen forbindelse. Din feedback er gemt og sendes, når du har net.').waitFor({ timeout: 15000 });
  assert.equal(await koe(side), 1, 'gemt på telefonen');
  assert.equal((await tal(miljoe)).mailKald, foer.mailKald);
  await kontekst.setOffline(false);
  for (let i = 0; i < 100 && (await koe(side)) !== 0; i++) await side.waitForTimeout(100);
  assert.equal(await koe(side), 0, 'sendt, da nettet kom');
  const t = await tal(miljoe);
  assert.equal(t.mailKald, foer.mailKald + 1);
  assert.match(t.sidsteMail.message.body.content, /^Skrevet uden net\./);
  await kontekst.close();
});

test('tom feedback sendes ikke, og feltet tager højst 2.000 tegn', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const foer = await tal(miljoe);
  await aabnOgSkriv(side, '   ');
  await knap(side, 'Send').click();
  await side.getByText('Skriv din feedback først.').waitFor();
  assert.equal((await tal(miljoe)).mailKald, foer.mailKald);
  await side.getByLabel('Din feedback').fill('x'.repeat(2100));
  assert.equal((await side.getByLabel('Din feedback').inputValue()).length, 2000);
  await side.getByText('2000 / 2000').waitFor();
  await kontekst.close();
});

test('det skrevne overlever, når skærmen tegnes igen, og Tilbage fører til forsiden', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await aabnOgSkriv(side, 'Halvt skrevet');
  await knap(side, 'Tilbage').click();
  await knap(side, 'Optag').waitFor();
  await knap(side, 'Giv feedback').click();
  assert.equal(await side.getByLabel('Din feedback').inputValue(), 'Halvt skrevet');
  await side.goBack();
  await knap(side, 'Optag').waitFor();
  await kontekst.close();
});

test('feedback kan også gives fra Information', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await knap(side, 'Information').click();
  await knap(side, 'Giv feedback').click();
  await side.getByRole('heading', { name: 'Giv feedback' }).waitFor();
  await kontekst.close();
});
