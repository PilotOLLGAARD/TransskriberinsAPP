'use strict';
// Upload af en lydfil, brugeren allerede har: kontrol, gemning før afsendelse, navneskærm, fremdrift og del-menuen.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomFillSync } = require('node:crypto');
const { startMiljoe, nyTelefon, tal, saetNaesteFejl, forsideLuft, ryd, swKlar, boks } = require('./hjaelpere.js');

let miljoe;
before(async () => { miljoe = await startMiljoe(); });
after(async () => { await miljoe.stop(); });
// En test, der fejler, før den selv har slået serverens fejl fra eller lukket sin telefon, må ikke vælte de næste.
afterEach(async () => { await ryd(miljoe); });

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
  const optag = await boks(knap(side, 'Optag'));
  const upload = await boks(knap(side, 'Upload lydfil'));
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
    const m = await forsideLuft(side);
    assert.ok(m.rul <= 0, `${navn}: rul ${m.rul} px`);
    // Ikke på kanten: en lidt bredere skrift eller større tekst må ikke få forsiden til at rulle.
    assert.ok(m.luft >= 12, `${navn}: kun ${m.luft} px luft`);
    for (const k of [knap(side, 'Optag'), knap(side, 'Upload lydfil'), knap(side, 'Tidligere optagelser'), knap(side, 'Information')]) {
      const r = await k.boundingBox();
      assert.ok(r.y >= 0 && r.y + r.height <= m.hoejde, `${navn}: knap uden for skærmen`);
    }
    if (viewport.height < 700) assert.equal(Math.round((await knap(side, 'Optag').boundingBox()).height), 144);
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

test('en fil på 20 MB gemmes som Blob-stykker og når serveren byte for byte i rigtig rækkefølge', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const fil = await upload(side, { name: 'Stor.m4a', buffer: m4a(20 * KB * KB) });
  const felt = side.getByLabel(FELT);
  await felt.waitFor({ timeout: 30000 });
  // Stykkerne er Blob-udsnit, som browseren lægger på disk. Intet er læst ind som rå bytes.
  const stykker = await side.evaluate(() => new Promise((ok, fejl) => {
    const r = indexedDB.open('transskribering');
    r.onerror = () => fejl(r.error);
    r.onsuccess = () => {
      const g = r.result.transaction('stykker').objectStore('stykker').getAll();
      g.onsuccess = () => { ok(g.result.map((s) => ({ nr: s.nr, blob: s.bytes instanceof Blob, bytes: s.bytes.size }))); r.result.close(); };
      g.onerror = () => fejl(g.error);
    };
  }));
  const MB8 = 8 * KB * KB;
  assert.deepEqual(stykker, [
    { nr: 0, blob: true, bytes: MB8 }, { nr: 1, blob: true, bytes: MB8 }, { nr: 2, blob: true, bytes: fil.length - 2 * MB8 },
  ]);
  const [n] = await noter(side);
  assert.deepEqual(await lydSha(side, n.id), { bytes: fil.length, sha: sha(fil) });
  await knap(side, 'Send').click();
  await vis(side, SENDT, 60000);
  const efter = await tal(miljoe);
  assert.equal(efter.modtaget.bytes, fil.length);
  assert.equal(efter.modtaget.sha256, sha(fil));
  await kontekst.close();
});

test('optagedatoen er filens ændringsdato og sendes som x-optaget', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const tid = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const bytes = [...m4a(4 * KB)];
  // Filvælgeren i Chromium kan ikke sætte en dato, så filen lægges i feltet med DataTransfer.
  await side.evaluate(({ bytes, tid }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'Fra i tirsdags.m4a', { type: 'audio/mp4', lastModified: tid }));
    const felt = document.getElementById('lydfil');
    felt.files = dt.files;
    felt.dispatchEvent(new Event('change'));
  }, { bytes, tid });
  await side.getByLabel(FELT).waitFor();
  const [n] = await noter(side);
  assert.equal(n.oprettet, tid);
  const [anmodning] = await Promise.all([
    side.waitForRequest((r) => r.url().endsWith('/transskriber') && r.method() === 'POST'),
    knap(side, 'Send').click(),
  ]);
  assert.equal(anmodning.headers()['x-optaget'], String(tid));
  await vis(side, SENDT);
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

const FOR_LANG = 'Lydfilen er længere end 2½ time. Del den op i en anden app, og upload delene hver for sig.';

test('en fil over 2½ time afvises med dansk besked, og intet gemmes', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  // Telefonen læser varigheden af filen. Her siger den 2 t 31 min.
  await kontekst.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', { get: () => 9060, configurable: true });
  });
  await logInd(side);
  const foer = await tal(miljoe);
  await upload(side, { name: 'Heldagsmøde.wav', mimeType: 'audio/wav', buffer: wav(1) });
  await vis(side, FOR_LANG);
  assert.equal((await noter(side)).length, 0);
  assert.equal((await tal(miljoe)).geminiKald, foer.geminiKald);
  await kontekst.close();
});

test('serveren afviser over 2½ time med for-lang: appen viser samme besked, lyden bevares, og Prøv igen vises ikke', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const foer = await tal(miljoe);
  await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    await l.opretNote({ id: 'lang', mime: 'audio/mp4', titel: 'Lang fil', kilde: 'fil', filnavn: 'Lang.m4a' });
    await l.gemStykke('lang', 0, new Blob([new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 1, 2, 3])]));
    await l.opdaterNote('lang', { status: 'gemt', bytes: 11, varighedMs: 9500 * 1000 });
  });
  await side.reload();
  await knap(side, 'Navngiv og send').click();
  await knap(side, 'Send').click();
  await vis(side, FOR_LANG);
  assert.equal((await tal(miljoe)).geminiKald, foer.geminiKald);
  assert.equal(await knap(side, 'Prøv igen').count(), 0);
  assert.equal((await lydSha(side, 'lang')).bytes, 11);
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

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const MEMOER = 'Lydfil fra Memoer';
const ANDROID_AFSNIT = 'Lydfil fra telefonens optager';

async function aabnInformation(side) {
  await logInd(side);
  await knap(side, 'Information').click();
  await side.getByRole('heading', { name: 'Information' }).waitFor();
}

test('Information på iPhone: trin for Memoer med telefonens egne knapnavne, og intet om Android eller Diktafon', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { userAgent: IPHONE });
  await aabnInformation(side);
  const afsnit = side.locator('section').filter({ has: side.getByRole('heading', { name: MEMOER }) });
  await afsnit.waitFor();
  const trin = afsnit.locator('ol > li');
  assert.equal(await trin.count(), 4);
  const tekst = (await trin.allTextContents()).join(' | ');
  for (const ord of ['Memoer', 'Del', 'Gem i Arkiver', 'På min iPhone', 'Upload lydfil']) assert.ok(tekst.includes(ord), `mangler ${ord}: ${tekst}`);
  // Knappen ⋯ har kun et ikon. Skærmlæsere skal kunne læse den.
  assert.match(await trin.nth(1).textContent(), /Tryk på\s*Mere\s*og derefter på/);
  await vis(side, 'Vælg ikke "Kan redigeres"');
  assert.equal(await side.getByRole('heading', { name: ANDROID_AFSNIT }).count(), 0);
  assert.equal(await side.getByText(/Diktafon|Gem i Filer/).count(), 0);
  await kontekst.close();
});

test('Information på iPhone: Upload lydfil i vejledningen åbner filvælgeren og går til navneskærmen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { userAgent: IPHONE });
  await aabnInformation(side);
  const afsnit = side.locator('section').filter({ has: side.getByRole('heading', { name: MEMOER }) });
  const [vaelger] = await Promise.all([side.waitForEvent('filechooser'), afsnit.getByRole('button', { name: 'Upload lydfil' }).click()]);
  await vaelger.setFiles({ name: 'Ny optagelse 3.m4a', mimeType: 'audio/mp4', buffer: m4a() });
  assert.equal(await side.getByLabel(FELT).inputValue(), 'Ny optagelse 3');
  await kontekst.close();
});

test('Information på Android: trin for Del-menuen, og intet om Memoer', async () => {
  const { kontekst, side } = await nyTelefon(miljoe, { userAgent: ANDROID });
  await aabnInformation(side);
  const afsnit = side.locator('section').filter({ has: side.getByRole('heading', { name: ANDROID_AFSNIT }) });
  await afsnit.waitFor();
  const trin = afsnit.locator('ol > li');
  assert.equal(await trin.count(), 4);
  const tekst = (await trin.allTextContents()).join(' | ');
  for (const ord of ['Stemmeoptager', 'Optager', 'Del', 'Transskribering', 'Send']) assert.ok(tekst.includes(ord), `mangler ${ord}: ${tekst}`);
  await vis(side, 'Appen står kun i Del-menuen, når den er føjet til startskærmen.');
  assert.equal(await side.getByRole('heading', { name: MEMOER }).count(), 0);
  await kontekst.close();
});

test('Information på en computer viser begge vejledninger', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await aabnInformation(side);
  await side.getByRole('heading', { name: MEMOER }).waitFor();
  await side.getByRole('heading', { name: ANDROID_AFSNIT }).waitFor();
  await kontekst.close();
});

// 260 px svarer til 360 px med forstørret tekst (ca. 140 %) i telefonens indstillinger.
for (const [navn, userAgent, bredde] of [['iPhone', IPHONE, 360], ['Android', ANDROID, 360], ['iPhone', IPHONE, 260], ['Android', ANDROID, 260]]) {
  test(`Information på ${navn} kan læses på ${bredde} px uden at rulle til siden`, async () => {
    const { kontekst, side } = await nyTelefon(miljoe, { userAgent, viewport: { width: bredde, height: 640 } });
    await aabnInformation(side);
    await side.locator('ol.guide').first().waitFor();
    // En bred skrift som Linux' DejaVu Sans (Verdana på Windows), så testen giver det samme på GitHub.
    await side.evaluate(() => { document.body.style.fontFamily = 'Verdana, "DejaVu Sans", sans-serif'; });
    await side.waitForTimeout(100);
    // Vejledningen og telefonens knapnavne må aldrig gå ud over kanten. (Ved 260 px er logoet i toppen bredere end skærmen.)
    const udenfor = await side.evaluate(() => [...document.querySelectorAll('.info-afsnit *:not(.skjult)')]
      .filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5 || e.scrollWidth > e.clientWidth + 1)
      .map((e) => e.className || e.tagName));
    assert.deepEqual(udenfor, []);
    if (bredde >= 360) assert.ok(await side.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await kontekst.close();
  });
}

// Del-menuen på Android (Web Share Target). Chromium kan ikke åbne del-menuen, så POST-kaldet,
// Android laver, efterlignes med en formular, der sendes gennem service workeren.

async function delGennemServiceWorker(side, { name, mimeType, buffer }) {
  await side.goto(miljoe.adresse);
  await swKlar(side);
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

const kopier = (side) => side.evaluate(async () => (await (await caches.open('delt-lydfil')).keys()).length);
const IKKE_GEMT = 'Lydfilen er ikke gemt';

test('del-menuen: filen gemmes straks, navneskærmen åbner med filen klar, og kopien fjernes', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const fil = m4a(300 * KB);
  await delGennemServiceWorker(side, { name: 'Delt møde.m4a', mimeType: 'audio/mp4', buffer: fil });
  const felt = side.getByLabel(FELT);
  await felt.waitFor({ timeout: 15000 });
  assert.equal(await felt.inputValue(), 'Delt møde');
  await vis(side, 'Delt møde.m4a');
  await vis(side, '0,3 MB');
  assert.equal(await knap(side, 'Gem lydfilen').count(), 0);
  assert.equal(new URL(side.url()).search, '');
  const [n] = await noter(side);
  assert.equal(n.kilde, 'fil');
  assert.deepEqual(await lydSha(side, n.id), { bytes: fil.length, sha: sha(fil) });
  assert.equal(await kopier(side), 0);
  await knap(side, 'Send').click();
  await vis(side, SENDT);
  assert.equal((await tal(miljoe)).modtaget.bytes, fil.length);
  // Noten står under Tidligere som enhver anden.
  await side.getByRole('button', { name: /^(Ny optagelse|Til forsiden)$/ }).first().click();
  await knap(side, 'Tidligere optagelser').click();
  await side.locator('.historik').filter({ hasText: 'Delt møde' }).waitFor();
  await kontekst.close();
});

test('del-menuen: en ny start henter ikke filen igen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await delGennemServiceWorker(side, { name: 'En gang.m4a', mimeType: 'audio/mp4', buffer: m4a(64 * KB) });
  await side.getByLabel(FELT).waitFor({ timeout: 15000 });
  assert.equal(await kopier(side), 0);
  await side.reload();
  await vis(side, 'Afventer');
  await side.waitForTimeout(500);
  assert.equal(await side.getByLabel(FELT).count(), 0);
  assert.equal((await noter(side)).length, 1);
  await kontekst.close();
});

test('del-menuen: Tilbage fra navneskærmen lader filen vente under Afventer', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await delGennemServiceWorker(side, { name: 'Senere.m4a', mimeType: 'audio/mp4', buffer: m4a(64 * KB) });
  await side.getByLabel(FELT).waitFor({ timeout: 15000 });
  await knap(side, 'Tilbage').click();
  await vis(side, 'Afventer');
  await knap(side, 'Navngiv og send').click();
  await knap(side, 'Send').click();
  await vis(side, SENDT);
  await kontekst.close();
});

/** Får gemningen af lydstykker til at fejle, så længe sessionStorage.fejl er sat. */
async function fejlVedGemning(kontekst, fejlnavn) {
  await kontekst.addInitScript((fejlnavn) => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (vaerdi, ...rest) {
      const r = original.call(this, vaerdi, ...rest);
      if (sessionStorage.getItem('fejl') && vaerdi && 'bytes' in vaerdi && 'nr' in vaerdi) {
        const t = this.transaction;
        r.addEventListener('success', () => {
          Object.defineProperty(t, 'error', { value: new DOMException('fejl', fejlnavn), configurable: true });
          t.abort();
        });
      }
      return r;
    };
  }, fejlnavn);
}

for (const [navn, fejlnavn, besked] of [
  ['fuldt lager', 'QuotaExceededError', 'Telefonen er løbet tør for plads, så intet blev gemt.'],
  ['læsefejl', 'NotReadableError', 'Filen kunne ikke læses, så intet blev gemt.'],
]) {
  test(`del-menuen: ${navn} viser Lydfilen er ikke gemt, kopien bevares, og Prøv igen gemmer filen`, async () => {
    const { kontekst, side } = await nyTelefon(miljoe);
    await fejlVedGemning(kontekst, fejlnavn);
    await logInd(side);
    const fil = m4a(100 * KB);
    await side.evaluate(() => sessionStorage.setItem('fejl', '1'));
    await delGennemServiceWorker(side, { name: 'Prøv igen.m4a', mimeType: 'audio/mp4', buffer: fil });
    await side.getByRole('heading', { name: IKKE_GEMT }).waitFor({ timeout: 15000 });
    await vis(side, besked);
    await vis(side, 'Prøv igen.m4a');
    assert.equal((await noter(side)).length, 0);
    assert.equal(await kopier(side), 1);
    // Lukkes appen, prøves det igen ved næste start.
    await side.reload();
    await side.getByRole('heading', { name: IKKE_GEMT }).waitFor({ timeout: 15000 });
    assert.equal(await kopier(side), 1);
    await side.evaluate(() => sessionStorage.removeItem('fejl'));
    await knap(side, 'Prøv igen').click();
    await side.getByLabel(FELT).waitFor({ timeout: 15000 });
    const [n] = await noter(side);
    assert.deepEqual(await lydSha(side, n.id), { bytes: fil.length, sha: sha(fil) });
    assert.equal(await kopier(side), 0);
    await kontekst.close();
  });
}

test('del-menuen: Til forsiden efter en fejl beholder kopien, så næste start prøver igen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await fejlVedGemning(kontekst, 'QuotaExceededError');
  await logInd(side);
  await side.evaluate(() => sessionStorage.setItem('fejl', '1'));
  const fil = m4a(64 * KB);
  await delGennemServiceWorker(side, { name: 'Senere igen.m4a', mimeType: 'audio/mp4', buffer: fil });
  await side.getByRole('heading', { name: IKKE_GEMT }).waitFor({ timeout: 15000 });
  await knap(side, 'Til forsiden').click();
  await knap(side, 'Optag').waitFor();
  // Fra forsiden kan man fx slette gamle noter under Tidligere for at få plads.
  await knap(side, 'Tidligere optagelser').click();
  await side.getByRole('heading', { name: 'Tidligere optagelser' }).waitFor();
  assert.equal((await noter(side)).length, 0);
  assert.equal(await kopier(side), 1);
  await side.evaluate(() => sessionStorage.removeItem('fejl'));
  await side.reload();
  await side.getByLabel(FELT).waitFor({ timeout: 15000 });
  const [n] = await noter(side);
  assert.deepEqual(await lydSha(side, n.id), { bytes: fil.length, sha: sha(fil) });
  assert.equal(await kopier(side), 0);
  await kontekst.close();
});

test('del-menuen: Annullér efter en fejl fjerner kopien og gemmer intet', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await fejlVedGemning(kontekst, 'QuotaExceededError');
  await logInd(side);
  await side.evaluate(() => sessionStorage.setItem('fejl', '1'));
  await delGennemServiceWorker(side, { name: 'Fremmed.m4a', mimeType: 'audio/mp4', buffer: m4a(64 * KB) });
  await side.getByRole('heading', { name: IKKE_GEMT }).waitFor({ timeout: 15000 });
  await knap(side, 'Annullér').click();
  await knap(side, 'Optag').waitFor();
  assert.equal((await noter(side)).length, 0);
  assert.equal(await kopier(side), 0);
  await side.evaluate(() => sessionStorage.removeItem('fejl'));
  await side.reload();
  await knap(side, 'Optag').waitFor();
  await side.waitForTimeout(300);
  assert.equal(await side.getByRole('heading', { name: IKKE_GEMT }).count(), 0);
  await kontekst.close();
});

test('del-menuen: en fil, der ikke er lyd, afvises med besked på forsiden, og kopien fjernes', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  await delGennemServiceWorker(side, { name: 'billede.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) });
  await vis(side, 'Filen er ikke en lydfil, appen kan bruge.');
  await knap(side, 'Optag').waitFor();
  assert.equal((await noter(side)).length, 0);
  assert.equal(await kopier(side), 0);
  await kontekst.close();
});

test('del-menuen: en fil på 48 MB kommer gennem service workeren byte for byte', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  const fil = m4a(48 * KB * KB); // Playwright kan højst sende 50 MB på denne måde.
  await delGennemServiceWorker(side, { name: 'Langt møde.m4a', mimeType: 'audio/mp4', buffer: fil });
  await side.getByLabel(FELT).waitFor({ timeout: 60000 });
  const [n] = await noter(side);
  assert.deepEqual(await lydSha(side, n.id), { bytes: fil.length, sha: sha(fil) });
  assert.equal(await kopier(side), 0);
  await kontekst.close();
});

// Formater, som Samsung Stemmeoptager, Pixel Optager og andre apps deler. Formatet afgøres af filens
// første bytes, så MIME-typen fra appen er ligegyldig. Serveren får en type, den kender.

const hoved = (tekst, laengde = 64 * KB) => {
  const b = Buffer.alloc(laengde, 7);
  Buffer.from(tekst, 'latin1').copy(b, 0);
  return b;
};
const SAMSUNG_M4A = () => { const b = m4a(); Buffer.from('ftyp3gp4').copy(b, 4); return b; };
const PIXEL_M4A = () => { const b = m4a(); Buffer.from('ftypisom').copy(b, 4); return b; };

test('del-menuen: m4a, wav, mp3, ogg, aac og flac med forskellige MIME-typer når serveren med en type, den kender', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  for (const [name, mimeType, buffer, forventet] of [
    ['Stemme 001.m4a', 'audio/mp4', SAMSUNG_M4A(), 'audio/mp4'],
    ['Stemme 002.m4a', 'audio/mp4a-latm', SAMSUNG_M4A(), 'audio/mp4'],
    ['Stemme 003.m4a', 'audio/3gpp', SAMSUNG_M4A(), 'audio/mp4'],
    ['Optagelse 9. nov.m4a', 'audio/x-m4a', PIXEL_M4A(), 'audio/x-m4a'],
    ['Optagelse uden type.m4a', '', PIXEL_M4A(), 'audio/mp4'],
    ['Opkald.wav', 'audio/x-wav', wav(1), 'audio/wav'],
    ['Lyd.mp3', 'audio/mpeg', mp3(), 'audio/mpeg'],
    ['Lyd.ogg', 'audio/ogg', hoved('OggS'), 'audio/ogg'],
    ['Lyd.aac', 'audio/aac', hoved(String.fromCharCode(0xff, 0xf1, 0x50, 0x80)), 'audio/aac'],
    ['Lyd.flac', 'application/octet-stream', hoved('fLaC'), 'audio/flac'],
  ]) {
    await delGennemServiceWorker(side, { name, mimeType, buffer });
    await side.getByLabel(FELT).waitFor({ timeout: 15000 });
    await knap(side, 'Send').click();
    await vis(side, SENDT);
    const { modtaget } = await tal(miljoe);
    assert.equal(modtaget.mime, forventet, name);
    assert.equal(modtaget.bytes, buffer.length, name);
  }
  await kontekst.close();
});

test('del-menuen: AMR og en tom fil afvises med beskeden om formater, og intet gemmes', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await logInd(side);
  for (const [name, mimeType, buffer] of [['Opkald.amr', 'audio/amr', hoved('#!AMR\n', 4 * KB)], ['Tom.m4a', 'audio/mp4', Buffer.alloc(0)]]) {
    await delGennemServiceWorker(side, { name, mimeType, buffer });
    await vis(side, 'Filen er ikke en lydfil, appen kan bruge.');
    await knap(side, 'Optag').waitFor();
    assert.equal((await noter(side)).length, 0, name);
    assert.equal(await kopier(side), 0, name);
  }
  await kontekst.close();
});

// Ikke logget ind: filen gemmes alligevel. Send giver login, og efter login sendes den. Uden bevis kaldes serveren ikke.

for (const [navn, forbered] of [
  ['aldrig logget ind', async () => {}],
  ['logget ud', async (side) => {
    await logInd(side);
    await knap(side, 'Information').click();
    await knap(side, 'Log ud').click();
    await knap(side, 'Log ind').first().waitFor();
  }],
]) {
  test(`del-menuen, ${navn}: filen gemmes, Send beder om login, og efter login sendes den`, async () => {
    const { kontekst, side } = await nyTelefon(miljoe);
    await side.goto(miljoe.adresse);
    await forbered(side);
    const foer = await tal(miljoe);
    const fil = m4a(200 * KB);
    await delGennemServiceWorker(side, { name: 'Uden login.m4a', mimeType: 'audio/mp4', buffer: fil });
    const felt = side.getByLabel(FELT);
    await felt.waitFor({ timeout: 15000 });
    assert.equal(await felt.inputValue(), 'Uden login');
    await knap(side, 'Send').click();
    await vis(side, 'Du skal logge ind igen. Optagelsen er gemt.');
    assert.equal((await tal(miljoe)).geminiKald, foer.geminiKald);
    const [n] = await noter(side);
    assert.deepEqual(await lydSha(side, n.id), { bytes: fil.length, sha: sha(fil) });
    await knap(side, 'Log ind og prøv igen').click();
    await vis(side, SENDT, 20000);
    const efter = await tal(miljoe);
    assert.equal(efter.modtaget.bytes, fil.length);
    assert.equal(efter.modtaget.sha256, sha(fil));
    assert.equal(efter.sidsteReferat.titel, 'Uden login');
    await kontekst.close();
  });
}

test('del-menuen, ikke logget ind: Tilbage lader filen vente under Afventer, også når telefonen aldrig har været logget ind', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.goto(miljoe.adresse);
  await delGennemServiceWorker(side, { name: 'Venter.m4a', mimeType: 'audio/mp4', buffer: m4a(64 * KB) });
  await side.getByLabel(FELT).waitFor({ timeout: 15000 });
  await knap(side, 'Tilbage').click();
  await vis(side, 'Afventer');
  await side.reload();
  await vis(side, 'Afventer');
  assert.equal((await noter(side)).length, 1);
  await kontekst.close();
});
