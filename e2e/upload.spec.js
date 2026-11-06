'use strict';
// Upload af en lydfil, brugeren allerede har: kontrol, gemning før afsendelse, navneskærm, fremdrift og del-menuen.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomFillSync } = require('node:crypto');
const { startMiljoe, nyTelefon, tal, saetNaesteFejl } = require('./hjaelpere.js');

let miljoe;
before(async () => { miljoe = await startMiljoe(); });
after(async () => { await miljoe.stop(); });

const knap = (side, navn) => side.getByRole('button', { name: navn, exact: true });
const SENDT = 'Referatet er sendt til test@ollgaard.dk';
const FELT = 'Hvad handler optagelsen om?';
const KB = 1024;

async function vis(side, tekst, timeout = 15000) {
  await side.getByText(tekst, { exact: false }).first().waitFor({ timeout });
}

async function logInd(side) {
  await side.goto(miljoe.adresse);
  await side.evaluate(() => localStorage.setItem('testNaesteType', 'medarbejder'));
  await knap(side, 'Log ind').click();
  await knap(side, 'Optag').waitFor({ timeout: 15000 });
}

/** En m4a-lignende fil: rigtigt ftyp-hoved og tilfældige bytes. Den lokale server tjekker ikke lyden. */
function m4a(bytes = 200 * KB) {
  const b = Buffer.alloc(bytes);
  randomFillSync(b);
  Buffer.from([0, 0, 0, 0x20]).copy(b, 0);
  Buffer.from('ftypM4A ').copy(b, 4);
  return b;
}

/** En rigtig WAV-fil med en tone, så telefonen kan læse varigheden. */
function wav(sek = 2, rate = 8000) {
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
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), 44 + i * 2);
  return b;
}

function mp3(bytes = 64 * KB) {
  const b = Buffer.alloc(bytes);
  randomFillSync(b);
  Buffer.from('ID3').copy(b, 0);
  return b;
}

/** Trykker Upload lydfil og vælger filen i telefonens filvælger. */
async function upload(side, { name = 'Ny optagelse 14.m4a', mimeType = 'audio/mp4', buffer = m4a() } = {}) {
  const [vaelger] = await Promise.all([side.waitForEvent('filechooser'), knap(side, 'Upload lydfil').click()]);
  await vaelger.setFiles({ name, mimeType, buffer });
  return buffer;
}

const noter = (side) => side.evaluate(async () => (await import('/js/lager.js')).alleNoter());
const sha = (b) => createHash('sha256').update(b).digest('hex');
const lydSha = (side, id) => side.evaluate(async (i) => {
  const blob = await (await import('/js/lager.js')).hentLyd(i);
  const h = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return { bytes: blob.size, sha: [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('') };
}, id);

// Forsiden

test('forsiden har Upload lydfil under Optag, og filvælgeren tager kun lyd', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await vis(side, 'Har du allerede en lydfil?');
  const optag = await knap(side, 'Optag').boundingBox();
  const upload = await knap(side, 'Upload lydfil').boundingBox();
  assert.ok(upload.y > optag.y + optag.height, 'Upload lydfil ligger ikke under Optag');
  assert.ok(upload.height >= 44, `knappen er ${upload.height} px høj`);
  assert.ok(upload.width < optag.width * 1.6, 'Upload lydfil er ikke en lille pilleknap');
  const accept = await side.locator('input[type=file]').getAttribute('accept');
  assert.equal(accept, 'audio/*,.m4a,.mp3,.wav,.webm,.ogg,.oga,.aac,.flac');
  assert.equal(await side.locator('input[type=file]').isVisible(), false);
  await kontekst.close();
});

for (const [navn, viewport] of [['iPhone SE', { width: 375, height: 647 }], ['stor iPhone', { width: 393, height: 759 }]]) {
  test(`forsiden med Upload lydfil kan ses uden at rulle på ${navn}`, async () => {
    const { kontekst, side } = await nyTelefon(miljoe, { viewport });
    await side.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true }));
    await logInd(side);
    await side.waitForTimeout(300);
    const m = await side.evaluate(() => ({ rul: document.documentElement.scrollHeight - innerHeight, hoejde: innerHeight }));
    assert.ok(m.rul <= 0, `${navn}: rul ${m.rul} px`);
    for (const k of [knap(side, 'Optag'), knap(side, 'Upload lydfil'), knap(side, 'Tidligere optagelser'), knap(side, 'Information')]) {
      const r = await k.boundingBox();
      assert.ok(r.y >= 0 && r.y + r.height <= m.hoejde, `${navn}: knap uden for skærmen`);
    }
    if (viewport.height < 700) assert.equal(Math.round((await knap(side, 'Optag').boundingBox()).height), 152);
    await kontekst.close();
  });
}

// Hele forløbet

test('en m4a gemmes byte for byte før afsendelse, navneskærmen viser filen, og referatet sendes', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const foer = await tal(miljoe);
  const fil = await upload(side);
  const felt = side.getByLabel(FELT);
  await felt.waitFor();
  assert.equal(await felt.inputValue(), 'Ny optagelse 14');
  await vis(side, 'Ny optagelse 14.m4a');
  await vis(side, '0,2 MB');
  assert.equal(await side.getByRole('button', { name: 'Fortsæt optagelsen' }).count(), 0);
  // Gemt på telefonen, før noget er sendt.
  const [n] = await noter(side);
  assert.equal(n.status, 'gemt');
  assert.equal(n.kilde, 'fil');
  assert.equal(n.filnavn, 'Ny optagelse 14.m4a');
  assert.equal(n.bytes, fil.length);
  assert.notEqual(n.navngivet, true);
  assert.deepEqual(await lydSha(side, n.id), { bytes: fil.length, sha: sha(fil) });
  assert.equal((await tal(miljoe)).geminiKald, foer.geminiKald);

  await felt.fill('Byggemøde fra Diktafon');
  await knap(side, 'Send').click();
  await vis(side, 'Lydfilen er gemt');
  await vis(side, SENDT);
  const efter = await tal(miljoe);
  assert.equal(efter.modtaget.bytes, fil.length);
  assert.equal(efter.modtaget.mime, 'audio/mp4');
  assert.equal(efter.sidsteReferat.titel, 'Byggemøde fra Diktafon');
  assert.equal(efter.mailKald - foer.mailKald, 1);
  assert.equal((await lydSha(side, n.id)).bytes, 0);
  await kontekst.close();
});

test('feltet bruger navnet fra forsiden, hvis der er skrevet et', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await side.getByLabel('Navn (valgfrit)').fill('Tagrenovering');
  await upload(side);
  assert.equal(await side.getByLabel(FELT).inputValue(), 'Tagrenovering');
  await kontekst.close();
});

test('Tilbage fra navneskærmen: filen venter under Afventer og kan navngives og sendes', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await upload(side, { name: 'Vent.m4a' });
  await side.getByLabel(FELT).waitFor();
  await knap(side, 'Tilbage').click();
  await vis(side, 'Afventer');
  await vis(side, 'Lydfilen er gemt.');
  await knap(side, 'Navngiv og send').click();
  assert.equal(await side.getByLabel(FELT).inputValue(), 'Vent');
  await knap(side, 'Send').click();
  await vis(side, SENDT);
  await kontekst.close();
});

test('en fil med tal, varighed og lang titel ser rigtig ud på 360 px uden at rulle til siden', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { viewport: { width: 360, height: 640 } });
  await logInd(side);
  await upload(side, { name: 'Ny_optagelse_fra_byggepladsen_på_Amager_Strandvej_123_tirsdag.wav', mimeType: 'audio/wav', buffer: wav(2) });
  await side.getByLabel(FELT).waitFor();
  await vis(side, '2 sek · 0 MB');
  assert.ok(await side.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await kontekst.close();
});

// Kontrol før gemning

test('en fil, der ikke er lyd, afvises med dansk besked, og intet gemmes', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await upload(side, { name: 'tegning.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 tegning') });
  await vis(side, 'Filen er ikke en lydfil, appen kan bruge. Brug m4a, mp3, wav, ogg eller webm.');
  assert.equal((await noter(side)).length, 0);
  // Samme fil kan vælges igen, og knappen virker stadig.
  await upload(side, { name: 'tegning.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 tegning') });
  await vis(side, 'Filen er ikke en lydfil');
  await kontekst.close();
});

test('fuldt lager, når filen gemmes: besked om plads, og intet halvt gemt bliver liggende', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await kontekst.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (vaerdi, ...rest) {
      const r = original.call(this, vaerdi, ...rest);
      if (window.__fuld && vaerdi && 'bytes' in vaerdi && 'nr' in vaerdi) {
        const t = this.transaction;
        r.addEventListener('success', () => {
          Object.defineProperty(t, 'error', { value: new DOMException('Lageret er fuldt', 'QuotaExceededError'), configurable: true });
          t.abort();
        });
      }
      return r;
    };
  });
  await logInd(side);
  await side.evaluate(() => { window.__fuld = true; });
  await upload(side);
  await vis(side, 'Telefonen er løbet tør for plads, så intet blev gemt.');
  assert.equal((await noter(side)).length, 0);
  await side.evaluate(() => { window.__fuld = false; });
  await upload(side);
  await side.getByLabel(FELT).waitFor();
  assert.equal((await noter(side)).length, 1);
  await kontekst.close();
});

test('en lydfil, der stadig gemmes i en anden fane, vises ikke, og en halvt gemt fil fjernes ved næste start', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    await l.opretNote({ id: 'halv', mime: 'audio/mp4', titel: 'Halv fil', kilde: 'fil', filnavn: 'Halv.m4a' });
    await l.gemStykke('halv', 0, new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]).buffer);
  });
  // En anden fane er i gang med at gemme filen og holder låsen.
  const anden = await kontekst.newPage();
  await anden.goto(`${miljoe.adresse}/test/tom`);
  await anden.evaluate(() => { navigator.locks.request('optag-halv', () => new Promise(() => {})); });
  await side.reload();
  await knap(side, 'Optag').waitFor();
  await side.waitForTimeout(300);
  assert.equal(await side.getByText('Halv fil').count(), 0);
  assert.equal(await side.getByText('Afventer').count(), 0);
  assert.equal((await noter(side)).length, 1);
  // Fanen lukkes midt i gemningen. Filen ligger stadig, hvor brugeren valgte den.
  await anden.close();
  await side.reload();
  await knap(side, 'Optag').waitFor();
  await side.waitForTimeout(300);
  assert.equal((await noter(side)).length, 0);
  await kontekst.close();
});

// Afsendelse

async function langsomtNet(kontekst, side, opKBs = 32) {
  const cdp = await kontekst.newCDPSession(side);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 200, uploadThroughput: opKBs * KB, downloadThroughput: 256 * KB });
}

test('Sender lyden viser procent, MB og en fremdriftslinje', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const fil = await upload(side, { buffer: m4a(512 * KB) });
  await side.getByLabel(FELT).waitFor();
  await langsomtNet(kontekst, side);
  await knap(side, 'Send').click();
  await side.getByText(/Sender lyden … \d+ %/).waitFor({ timeout: 15000 });
  await side.getByText(/^[\d,]+ af 0,5 MB\. Hold appen åben\.$/).waitFor({ timeout: 15000 });
  const bar = side.getByRole('progressbar');
  await bar.waitFor();
  const v1 = Number(await bar.getAttribute('aria-valuenow'));
  await side.waitForTimeout(3000);
  const v2 = Number(await bar.getAttribute('aria-valuenow'));
  assert.ok(v2 > v1, `fremdriften står stille: ${v1} → ${v2}`);
  await vis(side, SENDT, 90000);
  assert.equal((await tal(miljoe)).modtaget.bytes, fil.length);
  // Fremdriften gemmes ikke på telefonen.
  const [n] = await noter(side);
  assert.deepEqual(Object.keys(n).filter((k) => /upload|procent|sendtBytes/i.test(k)), []);
  await kontekst.close();
});

test('net væk midt i upload af en fil: lyden bevares, og Prøv igen under Afventer sender én mail', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const fil = await upload(side, { buffer: m4a(512 * KB) });
  await side.getByLabel(FELT).waitFor();
  const foer = await tal(miljoe);
  await saetNaesteFejl(miljoe, 'afbrydUpload');
  await knap(side, 'Send').click();
  await vis(side, 'Lyden kunne ikke sendes', 30000);
  await vis(side, 'Ingen forbindelse. Optagelsen er gemt.');
  const [n] = await noter(side);
  assert.deepEqual(await lydSha(side, n.id), { bytes: fil.length, sha: sha(fil) });
  await saetNaesteFejl(miljoe, 'ingen');
  await knap(side, 'Til forsiden').click();
  await vis(side, 'Afventer');
  await knap(side, 'Prøv igen').click();
  await vis(side, 'Referatet er sendt', 30000);
  const efter = await tal(miljoe);
  assert.equal(efter.modtaget.bytes, fil.length);
  assert.equal(efter.mailKald - foer.mailKald, 1);
  await kontekst.close();
});

test('en wav viser varigheden, og x-varighed sendes med, så serveren kan vælge model', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await upload(side, { name: 'Diktat.wav', mimeType: 'audio/wav', buffer: wav(3) });
  await vis(side, '3 sek');
  const [anmodning] = await Promise.all([
    side.waitForRequest((r) => r.url().endsWith('/transskriber') && r.method() === 'POST'),
    knap(side, 'Send').click(),
  ]);
  const h = anmodning.headers();
  assert.equal(h['x-varighed'], '3');
  assert.equal(h['content-type'], 'audio/wav');
  await kontekst.close();
});

// Venter på serveren: indtil den godtager mp3 og wav, svarer den lokale server 415, og testen fejler.
test('en mp3 sendes hele vejen (kræver, at serveren godtager audio/mpeg)', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const fil = await upload(side, { name: 'Møde.mp3', mimeType: 'audio/mpeg', buffer: mp3() });
  await side.getByLabel(FELT).waitFor();
  await knap(side, 'Send').click();
  await vis(side, SENDT, 20000);
  const efter = await tal(miljoe);
  assert.equal(efter.modtaget.bytes, fil.length);
  assert.equal(efter.modtaget.mime, 'audio/mpeg');
  await kontekst.close();
});

test('Tidligere optagelser viser den sendte fil som enhver anden note', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await upload(side, { name: 'Ugemøde.m4a' });
  await knap(side, 'Send').click();
  await vis(side, SENDT);
  await side.getByRole('button', { name: /^(Ny optagelse|Til forsiden)$/ }).first().click();
  await knap(side, 'Tidligere optagelser').click();
  const kort = side.locator('.historik').filter({ hasText: 'Ugemøde' });
  await kort.waitFor();
  assert.match(await kort.textContent(), /Sendt/);
  assert.equal(await kort.getByRole('button', { name: 'Send referat igen' }).count(), 1);
  await kontekst.close();
});

// Information

test('Information forklarer, hvordan en optagelse fra Diktafon uploades', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await knap(side, 'Information').click();
  await side.getByRole('heading', { name: 'Lydfil fra Diktafon' }).waitFor();
  await vis(side, 'Åbn optagelsen i Diktafon → Del → Gem i Filer. Tryk derefter Upload lydfil i appen, og vælg filen.');
  await vis(side, 'Du kan også vælge lydfiler fra OneDrive eller en mail, du har gemt i Filer.');
  await kontekst.close();
});

// Del-menuen på Android (Web Share Target). Chromium kan ikke åbne del-menuen, så POST-kaldet,
// Android laver, efterlignes med en formular, der sendes gennem service workeren.

async function delGennemServiceWorker(side, { name, mimeType, buffer }) {
  await side.evaluate(async () => { await navigator.serviceWorker.ready; });
  await side.goto(`${miljoe.adresse}/test/tom`);
  await side.evaluate(() => {
    const f = document.createElement('form');
    f.method = 'POST';
    f.action = '/del';
    f.enctype = 'multipart/form-data';
    const i = document.createElement('input');
    i.type = 'file';
    i.name = 'lyd';
    f.append(i);
    document.body.append(f);
  });
  await side.locator('input[name=lyd]').setInputFiles({ name, mimeType, buffer });
  await Promise.all([side.waitForURL(/\?delt=|\/$/), side.evaluate(() => document.forms[0].submit())]);
}

test('del-menuen: en delt lydfil gemmes, navneskærmen åbnes, og den midlertidige kopi fjernes', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const fil = m4a(300 * KB);
  await delGennemServiceWorker(side, { name: 'Delt møde.m4a', mimeType: 'audio/mp4', buffer: fil });
  const felt = side.getByLabel(FELT);
  await felt.waitFor({ timeout: 15000 });
  assert.equal(await felt.inputValue(), 'Delt møde');
  await vis(side, 'Delt møde.m4a');
  assert.equal(new URL(side.url()).search, '');
  const [n] = await noter(side);
  assert.deepEqual(await lydSha(side, n.id), { bytes: fil.length, sha: sha(fil) });
  assert.equal(await side.evaluate(async () => (await (await caches.open('delt-lydfil')).keys()).length), 0);
  // En ny start henter ikke filen igen.
  await side.reload();
  await side.waitForTimeout(500);
  assert.equal((await noter(side)).length, 1);
  await knap(side, 'Navngiv og send').click();
  await knap(side, 'Send').click();
  await vis(side, SENDT);
  assert.equal((await tal(miljoe)).modtaget.bytes, fil.length);
  await kontekst.close();
});

test('del-menuen: en fil, der ikke er lyd, afvises med besked, og kopien fjernes', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await delGennemServiceWorker(side, { name: 'billede.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) });
  await vis(side, 'Filen er ikke en lydfil, appen kan bruge.');
  assert.equal((await noter(side)).length, 0);
  assert.equal(await side.evaluate(async () => (await (await caches.open('delt-lydfil')).keys()).length), 0);
  await kontekst.close();
});
