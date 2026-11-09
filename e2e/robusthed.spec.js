'use strict';
// Dårligt net, afbrudt upload, udløbet login og fuld lagerplads. Intet må gå tabt, og ingen mail må sendes to gange.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startMiljoe, nyTelefon, tal, saetNaesteFejl } = require('./hjaelpere.js');

let miljoe;
before(async () => { miljoe = await startMiljoe(); });
after(async () => { await miljoe.stop(); });
// En test, der fejler, før den selv har slået serverens fejl fra, må ikke vælte de næste.
afterEach(async () => { await saetNaesteFejl(miljoe, 'ingen'); });

const knap = (side, navn) => side.getByRole('button', { name: navn, exact: true });
const SENDT = 'Referatet er sendt til test@ollgaard.dk';
const FELT = 'Hvad handler optagelsen om?';
const KB = 1024;

async function vis(side, tekst, timeout = 15000) {
  await side.getByText(tekst, { exact: false }).first().waitFor({ timeout });
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

/**
 * Lægger en længere optagelse på telefonen, som var den optaget: tilfældige bytes i stykker på 64 KB.
 * dele > 1 er en afbrudt optagelse, der er fortsat. Den lokale server tjekker ikke lydens indhold.
 */
async function lagOptagelse(side, { bytes, dele = 1 }) {
  return side.evaluate(async ({ bytes, dele }) => {
    const l = await import('/js/lager.js');
    const id = await l.opretNote({ mime: 'audio/webm;codecs=opus' });
    const stykke = 64 * 1024;
    let nr = 0;
    for (let d = 0; d < dele; d++) {
      for (let i = 0; i < bytes / dele; i += stykke) {
        const b = new Uint8Array(Math.min(stykke, bytes / dele - i));
        for (let j = 0; j < b.length; j += 65536) crypto.getRandomValues(b.subarray(j, j + 65536));
        await l.gemStykke(id, nr++, b.buffer, d);
      }
    }
    await l.opdaterNote(id, { status: 'gemt', varighedMs: 10 * 60 * 1000, dele, afbrudt: dele > 1 ? false : undefined });
    return id;
  }, { bytes, dele });
}

const note = (side, id) => side.evaluate(async (i) => (await import('/js/lager.js')).hentNote(i), id);
const lydBytes = (side, id) => side.evaluate(async (i) => (await (await import('/js/lager.js')).hentLyd(i)).size, id);

async function venTil(betingelse, ms = 15000) {
  const slut = Date.now() + ms;
  while (!(await betingelse())) {
    if (Date.now() > slut) throw new Error('Betingelsen blev ikke opfyldt');
    await new Promise((ok) => setTimeout(ok, 200));
  }
}

/** Åbner navneskærmen for den lagte optagelse og trykker Send. */
async function sendLagt(side, titel) {
  await side.reload();
  await knap(side, 'Navngiv og send').click();
  await navngiv(side, titel);
}

async function langsomtNet(kontekst, side, { latens = 300, opKBs = 32, nedKBs = 128 } = {}) {
  const cdp = await kontekst.newCDPSession(side);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: latens, uploadThroughput: opKBs * KB, downloadThroughput: nedKBs * KB,
  });
  return {
    async normalt() {
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, uploadThroughput: -1, downloadThroughput: -1 });
    },
  };
}

test('dårligt 4G: en længere optagelse sendes med trin undervejs, og appen giver ikke op for tidligt', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const bytes = 512 * KB;
  const id = await lagOptagelse(side, { bytes });
  const foer = await tal(miljoe);
  await langsomtNet(kontekst, side);
  const start = Date.now();
  await sendLagt(side, 'Langsomt net');
  await vis(side, 'Sender lyden …');
  await vis(side, 'Optagelsen er gemt');
  // Efter flere sekunder sendes der stadig, og der er ingen fejl.
  await side.waitForTimeout(6000);
  assert.equal(await side.getByText('Sender lyden …').count(), 1);
  assert.equal(await side.getByText('Lyden kunne ikke sendes').count(), 0);
  await vis(side, SENDT, 90000);
  assert.ok(Date.now() - start > 10000, 'nettet blev ikke gjort langsomt');
  const efter = await tal(miljoe);
  assert.equal(efter.modtaget.bytes, bytes);
  assert.equal(efter.mailKald - foer.mailKald, 1);
  assert.equal((await note(side, id)).status, 'sendt');
  await kontekst.close();
});

test('net væk midt i upload: lyden bevares, Fejlet med dansk besked, og Prøv igen sender én mail', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const bytes = 512 * KB;
  const id = await lagOptagelse(side, { bytes });
  const foer = await tal(miljoe);
  // Forbindelsen tabes, når serveren har fået de første 64 KB.
  await saetNaesteFejl(miljoe, 'afbrydUpload');
  await sendLagt(side, 'Net væk');
  await vis(side, 'Lyden kunne ikke sendes', 30000);
  await vis(side, 'Ingen forbindelse. Optagelsen er gemt.');
  assert.equal(await lydBytes(side, id), bytes);
  assert.equal((await note(side, id)).status, 'fejl');
  assert.equal((await tal(miljoe)).mailKald, foer.mailKald);
  await saetNaesteFejl(miljoe, 'ingen');
  // Nettet er væk, når der trykkes Prøv igen første gang.
  await kontekst.setOffline(true);
  await knap(side, 'Prøv igen').click();
  await side.waitForTimeout(500);
  await vis(side, 'Ingen forbindelse. Optagelsen er gemt.');
  assert.equal(await lydBytes(side, id), bytes);
  await kontekst.setOffline(false);
  await knap(side, 'Prøv igen').click();
  await vis(side, SENDT, 30000);
  const efter = await tal(miljoe);
  assert.equal(efter.modtaget.bytes, bytes);
  assert.equal(efter.mailKald - foer.mailKald, 1);
  assert.equal(await lydBytes(side, id), 0);
  await kontekst.close();
});

test('afbrudt efter første del af en fortsat optagelse: kun den manglende del sendes igen, og én mail', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const id = await lagOptagelse(side, { bytes: 256 * KB, dele: 2 });
  const foer = await tal(miljoe);
  let kald = 0;
  await side.route('**/transskriber', (route) => (++kald === 2 ? route.abort('internetdisconnected') : route.continue()));
  await sendLagt(side, 'To dele');
  await vis(side, 'Ingen forbindelse. Optagelsen er gemt.');
  const n = await note(side, id);
  assert.equal(n.status, 'fejl');
  assert.equal(typeof n.deltekster[0], 'string');
  assert.equal(await lydBytes(side, id), 256 * KB);
  await side.unroute('**/transskriber');
  await knap(side, 'Prøv igen').click();
  await vis(side, SENDT);
  const efter = await tal(miljoe);
  // Del 1 to gange (første forsøg nåede serveren ikke), del 0 kun én gang.
  assert.equal(efter.geminiKald - foer.geminiKald, 2);
  assert.equal(efter.referatKald - foer.referatKald, 1);
  assert.equal(efter.mailKald - foer.mailKald, 1);
  await kontekst.close();
});

test('net væk mens referatet laves: Prøv igen virker, og der sendes én mail', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const id = await lagOptagelse(side, { bytes: 128 * KB });
  const foer = await tal(miljoe);
  // Serveren laver referatet, men svaret når aldrig frem.
  await side.route('**/transskriber', async (route) => {
    await route.fetch().catch(() => {});
    await route.abort('internetdisconnected');
  });
  await sendLagt(side, 'Referat uden net');
  await vis(side, 'Ingen forbindelse. Optagelsen er gemt.');
  assert.equal(await lydBytes(side, id), 128 * KB);
  assert.equal((await tal(miljoe)).mailKald, foer.mailKald);
  await side.unroute('**/transskriber');
  await knap(side, 'Prøv igen').click();
  await vis(side, SENDT);
  assert.equal((await tal(miljoe)).mailKald - foer.mailKald, 1);
  await kontekst.close();
});

test('net væk mens mailen sendes: Mailen er måske allerede sendt, lyden bevares, og intet sendes af sig selv', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const id = await lagOptagelse(side, { bytes: 128 * KB });
  const foer = await tal(miljoe);
  // Microsoft modtager mailen, men svaret når aldrig frem.
  await side.route('**/me/sendMail', async (route) => {
    await route.fetch().catch(() => {});
    await route.abort('internetdisconnected');
  });
  await sendLagt(side, 'Mail uden net');
  await vis(side, 'Mailen er måske allerede sendt. Tjek din indbakke, før du sender igen.');
  assert.equal(await knap(side, 'Prøv igen').count(), 0);
  assert.equal((await tal(miljoe)).mailKald - foer.mailKald, 1);
  assert.equal(await lydBytes(side, id), 128 * KB);
  await side.unroute('**/me/sendMail');
  // Genstart og login sender ikke igen af sig selv.
  await side.reload();
  await vis(side, 'Mailen er måske allerede sendt.');
  await side.waitForTimeout(1500);
  assert.equal((await tal(miljoe)).mailKald - foer.mailKald, 1);
  assert.equal(await lydBytes(side, id), 128 * KB);
  await kontekst.close();
});

test('mailen når aldrig frem, mens telefonen tror, den har net: appen advarer i stedet for at sende igen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const id = await lagOptagelse(side, { bytes: 128 * KB });
  const foer = await tal(miljoe);
  await side.route('**/me/sendMail', (route) => route.abort('internetdisconnected'));
  await sendLagt(side, 'Mail aldrig sendt');
  await vis(side, 'Mailen er måske allerede sendt.');
  assert.equal((await tal(miljoe)).mailKald, foer.mailKald);
  assert.equal(await lydBytes(side, id), 128 * KB);
  await kontekst.close();
});

test('ingen net, når mailen skal sendes: Mailen blev ikke sendt, ingen advarsel om dobbelt mail, og Prøv igen sender én mail', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const id = await lagOptagelse(side, { bytes: 128 * KB });
  const foer = await tal(miljoe);
  // Referatet når frem, og lige derefter er nettet væk.
  await side.route('**/transskriber', async (route) => {
    const svar = await route.fetch();
    await kontekst.setOffline(true);
    await route.fulfill({ response: svar });
  });
  await sendLagt(side, 'Mail uden net');
  await vis(side, 'Mailen blev ikke sendt. Referatet er gemt. Prøv igen.');
  assert.equal(await side.getByText('Mailen er måske allerede sendt.').count(), 0);
  assert.equal((await tal(miljoe)).mailKald, foer.mailKald);
  assert.equal(await lydBytes(side, id), 128 * KB);
  await side.unroute('**/transskriber');
  await kontekst.setOffline(false);
  await knap(side, 'Prøv igen').click();
  await vis(side, SENDT);
  const efter = await tal(miljoe);
  assert.equal(efter.mailKald - foer.mailKald, 1);
  assert.equal(efter.referatKald - foer.referatKald, 1);
  await kontekst.close();
});

test('udløbet login midt i afsendelsen: optagelsen gemmes, besked om login, og efter login sendes den af sig selv', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const bytes = 512 * KB;
  const id = await lagOptagelse(side, { bytes });
  const foer = await tal(miljoe);
  const net = await langsomtNet(kontekst, side);
  // Beviset er udløbet, når serveren tjekker det. Serveren svarer 401, før lyden er læst.
  await side.evaluate(() => localStorage.setItem('testType', 'udloebet'));
  await sendLagt(side, 'Udløbet login');
  await vis(side, 'Du skal logge ind igen. Optagelsen er gemt.', 60000);
  assert.equal(await lydBytes(side, id), bytes);
  assert.equal((await tal(miljoe)).geminiKald, foer.geminiKald);
  await net.normalt();
  await side.evaluate(() => localStorage.setItem('testNaesteType', 'medarbejder'));
  await knap(side, 'Log ind og prøv igen').click();
  await vis(side, SENDT);
  const efter = await tal(miljoe);
  assert.equal(efter.modtaget.bytes, bytes);
  assert.equal(efter.mailKald - foer.mailKald, 1);
  await kontekst.close();
});

test('401 efter upload er startet (svar fra serveren): login-besked og automatisk afsendelse efter login', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const id = await lagOptagelse(side, { bytes: 128 * KB });
  const foer = await tal(miljoe);
  await side.route('**/transskriber', (route) => route.fulfill({
    status: 401, contentType: 'application/json', body: '{"fejl":"login-kraeves"}',
    headers: { 'access-control-allow-origin': '*' },
  }));
  await sendLagt(side, 'Login 401');
  await vis(side, 'Du skal logge ind igen. Optagelsen er gemt.');
  await side.unroute('**/transskriber');
  // Login uden at trykke på noten: noten sendes af sig selv, når appen ser, at man er logget ind.
  await side.evaluate(() => localStorage.setItem('testFornyet', String(Date.now())));
  await side.reload();
  await venTil(async () => (await note(side, id))?.status === 'sendt');
  const efter = await tal(miljoe);
  assert.equal(efter.mailKald - foer.mailKald, 1);
  assert.equal((await note(side, id)).status, 'sendt');
  await kontekst.close();
});

// Fuld lagerplads. IndexedDB afviser skrivningen, som telefonen gør, når der ikke er mere plads:
// transaktionen afbrydes med QuotaExceededError, før den gemmes. window.__fuld er 'alt' eller en funktion af det, der gemmes.
function fuldtLagerScript() {
  window.__fuld = null;
  for (const navn of ['put', 'add']) {
    const original = IDBObjectStore.prototype[navn];
    IDBObjectStore.prototype[navn] = function (vaerdi, ...rest) {
      const r = original.call(this, vaerdi, ...rest);
      const f = window.__fuld;
      if (f === 'alt' || (typeof f === 'function' && f(vaerdi))) {
        // Som på en rigtig telefon: skrivningen ser ud til at lykkes, men transaktionen afvises bagefter.
        const t = this.transaction;
        r.addEventListener('success', () => {
          Object.defineProperty(t, 'error', { value: new DOMException('Lageret er fuldt', 'QuotaExceededError'), configurable: true });
          t.abort();
        });
      }
      return r;
    };
  }
}

async function telefonMedFuldtLager() {
  const t = await nyTelefon(miljoe);
  await t.kontekst.addInitScript(fuldtLagerScript);
  return t;
}

const fuldt = (side, hvad = 'alt') => side.evaluate((h) => {
  window.__fuld = h === 'alt' || h === null ? h : new Function('v', `return ${h}`);
}, hvad);
const PLADS = 'Telefonen er løbet tør for plads. Optagelsen er gemt.';

test('fuldt lager under optagelse: dansk besked, det optagede er gemt, og det kan sendes, når der er plads', async () => {
  const { kontekst, side } = await telefonMedFuldtLager();
  await logInd(side);
  const foer = await tal(miljoe);
  await knap(side, 'Optag').click();
  await knap(side, 'Stop').waitFor();
  await side.waitForTimeout(6000); // Første stykke er gemt.
  await fuldt(side);
  await vis(side, 'Telefonen er løbet tør for plads. Det indtalte indtil nu er gemt.', 20000);
  const [n] = await side.evaluate(async () => (await import('/js/lager.js')).alleNoter());
  assert.ok((await lydBytes(side, n.id)) > 0);
  await fuldt(side, null);
  await navngiv(side, 'Fuldt lager');
  await vis(side, SENDT);
  assert.equal((await tal(miljoe)).mailKald - foer.mailKald, 1);
  await kontekst.close();
});

test('fuldt lager, når optagelsen skal starte: dansk besked om plads, ikke "kan ikke optage her"', async () => {
  const { kontekst, side } = await telefonMedFuldtLager();
  await logInd(side);
  await fuldt(side);
  await knap(side, 'Optag').click();
  await vis(side, 'Telefonen er løbet tør for plads, så intet blev gemt.');
  assert.equal(await side.getByText('Telefonen kan ikke optage her.').count(), 0);
  await fuldt(side, null);
  assert.equal((await side.evaluate(async () => (await import('/js/lager.js')).alleNoter())).length, 0);
  await kontekst.close();
});

test('fuldt lager, når referatet gemmes: besked om plads, lyden bevares, og Prøv igen virker bagefter', async () => {
  const { kontekst, side } = await telefonMedFuldtLager();
  await logInd(side);
  const id = await lagOptagelse(side, { bytes: 128 * KB });
  const foer = await tal(miljoe);
  // Svaret med referatet kommer, og lige da er telefonen fuld.
  await side.route('**/transskriber', async (route) => {
    const svar = await route.fetch();
    await fuldt(side);
    await route.fulfill({ response: svar });
  });
  await sendLagt(side, 'Fuldt ved referat');
  await vis(side, PLADS);
  await knap(side, 'Prøv igen').waitFor();
  assert.equal(await side.getByText('Referatet laves …').count(), 0);
  await side.unroute('**/transskriber');
  await fuldt(side, null);
  assert.equal(await lydBytes(side, id), 128 * KB);
  assert.equal((await tal(miljoe)).mailKald, foer.mailKald);
  await knap(side, 'Prøv igen').click();
  await vis(side, SENDT);
  assert.equal((await tal(miljoe)).mailKald - foer.mailKald, 1);
  await kontekst.close();
});

test('fuldt lager, før mailen sendes: besked om plads, ingen mail, og Prøv igen sender én mail', async () => {
  const { kontekst, side } = await telefonMedFuldtLager();
  await logInd(side);
  const id = await lagOptagelse(side, { bytes: 128 * KB });
  const foer = await tal(miljoe);
  await side.reload();
  await fuldt(side, "v && v.status === 'sender-mail'");
  await knap(side, 'Navngiv og send').click();
  await navngiv(side, 'Fuldt ved mail');
  await vis(side, PLADS);
  assert.equal(await side.getByText('Referatet sendes til din mail').count(), 0);
  assert.equal((await tal(miljoe)).mailKald, foer.mailKald);
  assert.equal(await lydBytes(side, id), 128 * KB);
  await fuldt(side, null);
  await knap(side, 'Prøv igen').click();
  await vis(side, SENDT);
  const efter = await tal(miljoe);
  assert.equal(efter.mailKald - foer.mailKald, 1);
  assert.equal(efter.referatKald - foer.referatKald, 1);
  await kontekst.close();
});
