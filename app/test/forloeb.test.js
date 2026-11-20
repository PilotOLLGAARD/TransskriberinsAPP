import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lavForloeb } from '../js/forloeb.js';
import { LoginKraevet } from '../js/login.js';
import { STATUS } from '../js/tilstand.js';
import { planlaegBidder } from '../js/opdeling/index.js';

function falskLager(noter = []) {
  const kort = new Map(noter.map((n) => [n.id, { ...n }]));
  return {
    kort,
    async hentNote(id) { const n = kort.get(id); return n ? { ...n } : null; },
    async opdaterNote(id, felter) { Object.assign(kort.get(id), felter); },
    lydSlettet: new Set(),
    async hentLyd(id) { if (!kort.has(id)) return null; return this.lydSlettet.has(id) ? new Blob([]) : new Blob(['lyd']); },
    async sletLyd(id) { this.lydSlettet.add(id); },
    async sletNote(id) { kort.delete(id); },
    async alleNoter() { return [...kort.values()].map((n) => ({ ...n })); },
    async hentDele(id) { return Array.from({ length: kort.get(id)?.dele ?? 1 }, (_, i) => new Blob([`del${i}`])); },
    // Alle dele med lyd som kilder (som lager.lavKilder).
    async lavKilder(id) {
      const n = kort.get(id);
      const antal = n?.kilde === 'filer' ? n.filer.length : n?.dele ?? 1;
      const ud = new Map();
      for (let d = 0; d < antal; d++) if (!n?.tommeDele?.includes(d)) ud.set(d, await this.lavKilde(id, d));
      return ud;
    },
    // Én del som kilde til klipningen. Lyden er teksten "del0", "del1" … så testene kan se, hvad der sendes.
    async lavKilde(id, del = 0) {
      // En del uden lyd (appen blev lukket lige efter Fortsæt) er tom.
      const blob = new Blob(kort.get(id)?.tommeDele?.includes(del) ? [] : [`del${del}`]);
      return {
        del, stoerrelse: blob.size, varighedMs: kort.get(id)?.delVarigheder?.[del],
        laes: async (a, b) => new Uint8Array(await blob.slice(a, b).arrayBuffer()), udsnit: async (a, b) => blob.slice(a, b),
      };
    },
  };
}

function opsaet({ noter = [{ id: 'a', status: STATUS.GEMT, mime: 'audio/mp4', oprettet: 1 }], sendLyd, sendMail, hentBevis, nu, aktivAndetSted, sendReferat, vedAendring, vedUpload, opdeling, bidder, vedBidder } = {}) {
  const lager = falskLager(noter);
  const t = { lydKald: 0, mailKald: [], lydListe: [], referatKald: [] };
  const forloeb = lavForloeb({
    lager,
    nu,
    aktivAndetSted,
    vedAendring,
    vedUpload,
    vedBidder,
    ...(opdeling ? { opdeling } : {}),
    ...(bidder ? { bidder } : {}),
    login: {
      hentBevis: hentBevis || (async (o) => `bevis-${o}`),
      brugerMail: () => 'a@ollgaard.dk',
    },
    sendLyd: async (...a) => {
      t.lydKald++;
      t.lydArgs = a;
      t.lydListe.push(a);
      return sendLyd ? sendLyd(...a) : { tekst: 'Hej' };
    },
    sendMail: async (v) => {
      t.mailKald.push(v);
      return sendMail ? sendMail(v) : undefined;
    },
    sendReferat: async (...a) => {
      t.referatKald.push(a);
      return sendReferat ? sendReferat(...a) : { ...REFERAT_SVAR, tekst: (a[0].tekster ?? a[0].dele.flatMap((d) => d.bidder.map((b) => b.tekst))).join(' | ') };
    },
  });
  return { lager, t, forloeb };
}

const fejl = (type) => async () => { throw Object.assign(new Error(type), { type }); };

test('succes gemmer teksten, og lyden bevares', async () => {
  const s = opsaet();
  await s.forloeb.behandl('a');
  const n = s.lager.kort.get('a');
  assert.equal(n.status, STATUS.TEKST_KLAR);
  assert.equal(n.tekst, 'Hej');
  assert.ok(await s.lager.hentLyd('a'));
  assert.equal(s.t.lydArgs[1], 'audio/mp4');
  assert.equal(s.t.lydArgs[2], 'bevis-api');
});

for (const [navn, type] of [
  ['netværksfejl', 'net'],
  ['401', 'login'],
  ['403', 'adgang'],
  ['tjeneste-fejl', 'tjeneste'],
  ['format-fejl', 'kanIkkeBehandles'],
]) {
  test(`${navn} beholder lyden`, async () => {
    const s = opsaet({ sendLyd: fejl(type) });
    await s.forloeb.behandl('a');
    const n = s.lager.kort.get('a');
    assert.equal(n.status, STATUS.FEJL);
    assert.equal(n.fejlType, type);
    assert.ok(await s.lager.hentLyd('a'));
  });
}

test('tom tekst beholder lyden', async () => {
  const s = opsaet({ sendLyd: async () => ({ tekst: '' }) });
  await s.forloeb.behandl('a');
  const n = s.lager.kort.get('a');
  assert.equal(n.status, STATUS.FEJL);
  assert.equal(n.fejlType, 'ingenTale');
  assert.ok(await s.lager.hentLyd('a'));
});

test('LoginKraevet beholder lyden uden kald til serveren', async () => {
  const s = opsaet({ hentBevis: async () => { throw new LoginKraevet(); } });
  await s.forloeb.behandl('a');
  assert.equal(s.t.lydKald, 0);
  assert.equal(s.lager.kort.get('a').fejlType, 'login');
});

test('net-fejl ved bevis giver net', async () => {
  const s = opsaet({ hentBevis: fejl('net') });
  await s.forloeb.behandl('a');
  assert.equal(s.lager.kort.get('a').fejlType, 'net');
});

test('uventet fejl giver fejl-status, ikke hængende note', async () => {
  const s = opsaet({ sendLyd: async () => { throw new Error('uventet'); } });
  await s.forloeb.behandl('a');
  assert.equal(s.lager.kort.get('a').status, STATUS.FEJL);
  assert.equal(s.lager.kort.get('a').fejlType, 'tjeneste');
});

test('prøv igen rydder fejlen', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.FEJL, fejlType: 'net', mime: 'audio/mp4' }] });
  await s.forloeb.behandl('a');
  const n = s.lager.kort.get('a');
  assert.equal(n.status, STATUS.TEKST_KLAR);
  assert.equal(n.fejlType, undefined);
});

test('dobbelttryk transskriberer én gang', async () => {
  const s = opsaet();
  await Promise.all([s.forloeb.behandl('a'), s.forloeb.behandl('a')]);
  assert.equal(s.t.lydKald, 1);
});

test('behandl rører ikke en note med tekst', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.TEKST_KLAR, tekst: 'x' }] });
  await s.forloeb.behandl('a');
  assert.equal(s.t.lydKald, 0);
});

const KLAR = { id: 'a', status: STATUS.TEKST_KLAR, tekst: 'Min note', oprettet: 7, mime: 'audio/mp4' };

test('ved 202 bliver noten sendt, lyden slettes, og referat og pdf bliver', async () => {
  const s = opsaet({ noter: [{ ...KLAR, referat: { opsummering: 'O' }, pdf: 'JVBERg==', maaskeSendt: true }], nu: () => 5000 });
  await s.forloeb.sendTilMig('a');
  const n = s.lager.kort.get('a');
  assert.equal(n.status, STATUS.SENDT);
  assert.equal(n.sendt, 5000);
  assert.equal(n.pdf, 'JVBERg==');
  assert.deepEqual(n.referat, { opsummering: 'O' });
  assert.equal(n.maaskeSendt, undefined);
  assert.equal((await s.lager.hentLyd('a')).size, 0);
});

test('mail går kun til brugeren selv', async () => {
  const s = opsaet({ noter: [KLAR] });
  await s.forloeb.sendTilMig('a');
  assert.equal(s.t.mailKald.length, 1);
  assert.equal(s.t.mailKald[0].til, 'a@ollgaard.dk');
  assert.equal(s.t.mailKald[0].bevis, 'bevis-mail');
  assert.equal(s.t.mailKald[0].note.tekst, 'Min note');
});

test('andet svar end 202 beholder alt', async () => {
  const s = opsaet({ noter: [KLAR], sendMail: fejl('mailFejl') });
  await s.forloeb.sendTilMig('a');
  const n = s.lager.kort.get('a');
  assert.equal(n.status, STATUS.TEKST_KLAR);
  assert.equal(n.tekst, 'Min note');
  assert.equal(n.fejlType, 'mailFejl');
  assert.ok(await s.lager.hentLyd('a'));
});

test('ukendt udfald af mail giver advarsel, ikke en påstand om at den ikke er sendt', async () => {
  const s = opsaet({ noter: [KLAR], sendMail: fejl('mailUkendt') });
  await s.forloeb.sendTilMig('a');
  const n = s.lager.kort.get('a');
  assert.equal(n.status, STATUS.TEKST_KLAR);
  assert.equal(n.maaskeSendt, true);
  assert.equal(n.fejlType, undefined);
  assert.ok(await s.lager.hentLyd('a'));
});

test('udløbet login under mail beholder alt', async () => {
  const s = opsaet({ noter: [KLAR], hentBevis: async () => { throw new LoginKraevet(); } });
  await s.forloeb.sendTilMig('a');
  const n = s.lager.kort.get('a');
  assert.equal(n.status, STATUS.TEKST_KLAR);
  assert.equal(n.fejlType, 'login');
  assert.equal(s.t.mailKald.length, 0);
});

test('dobbelttryk sender én mail', async () => {
  const s = opsaet({ noter: [KLAR] });
  await Promise.all([s.forloeb.sendTilMig('a'), s.forloeb.sendTilMig('a')]);
  assert.equal(s.t.mailKald.length, 1);
});

test('sender ikke mail uden tekst', async () => {
  const s = opsaet();
  await s.forloeb.sendTilMig('a');
  assert.equal(s.t.mailKald.length, 0);
});

test('genstart under mail advarer og sender ikke', async () => {
  const s = opsaet({ noter: [{ ...KLAR, status: STATUS.SENDER_MAIL }] });
  const noter = await s.forloeb.genoptag();
  assert.equal(noter[0].status, STATUS.TEKST_KLAR);
  assert.equal(noter[0].maaskeSendt, true);
  assert.equal(s.t.mailKald.length, 0);
});

test('genstart under afsendelse giver netfejl og sender ikke', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.SENDER, mime: 'audio/mp4' }] });
  const noter = await s.forloeb.genoptag();
  assert.equal(noter[0].status, STATUS.FEJL);
  assert.equal(noter[0].fejlType, 'net');
  assert.equal(s.t.lydKald, 0);
});

test('note, der stadig står som optager efter afslutning, kan behandles', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.OPTAGER, mime: 'audio/mp4' }] });
  await s.forloeb.behandl('a');
  assert.equal(s.lager.kort.get('a').status, STATUS.TEKST_KLAR);
});

test('lagerfejl under behandling afviser ikke, så skærmen ikke hænger', async () => {
  const s = opsaet();
  s.lager.opdaterNote = async () => { throw new Error('lager'); };
  await s.forloeb.behandl('a');
  assert.ok(await s.lager.hentLyd('a'));
});

test('lagerfejl under mail afviser ikke, og noten slettes ikke', async () => {
  const s = opsaet({ noter: [KLAR] });
  s.lager.opdaterNote = async () => { throw new Error('lager'); };
  await s.forloeb.sendTilMig('a');
  assert.equal(s.lager.kort.has('a'), true);
  assert.equal(s.t.mailKald.length, 0);
});

test('fuldt lager under genstart viser stadig alle noter', async () => {
  const s = opsaet({ noter: [
    { id: 'a', status: STATUS.SENDER, mime: 'audio/mp4' },
    { id: 'b', status: STATUS.FEJL, fejlType: 'net', mime: 'audio/mp4' },
  ] });
  s.lager.opdaterNote = async () => { throw new DOMException('fuld', 'QuotaExceededError'); };
  const noter = await s.forloeb.genoptag();
  assert.deepEqual(noter.map((n) => n.id), ['a', 'b']);
});

test('bekræft sendt gør noten sendt i stedet for at slette den', async () => {
  const s = opsaet({ noter: [{ ...KLAR, maaskeSendt: true }], nu: () => 9000 });
  await s.forloeb.bekraeftSendt('a');
  const n = s.lager.kort.get('a');
  assert.equal(n.status, STATUS.SENDT);
  assert.equal(n.sendt, 9000);
  assert.equal(n.maaskeSendt, undefined);
  assert.equal((await s.lager.hentLyd('a')).size, 0);
  assert.equal(s.t.mailKald.length, 0);
});

test('bekræftelse afvises uden advarsel om mulig afsendelse', async () => {
  const s = opsaet({ noter: [KLAR] });
  await assert.rejects(s.forloeb.bekraeftSendt('a'));
  assert.equal(s.lager.kort.has('a'), true);
});

test('genstart rører ikke en optagelse, der kører i en anden fane', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.OPTAGER, mime: 'audio/mp4' }] });
  s.lager.hentLyd = async () => new Blob([]);
  const noter = await s.forloeb.genoptag(new Set(['a']));
  assert.deepEqual(noter, []);
  assert.equal(s.lager.kort.get('a').status, STATUS.OPTAGER);
});

test('genstart fjerner en optagelse uden lyd', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.OPTAGER, mime: 'audio/mp4' }] });
  s.lager.hentLyd = async () => new Blob([]);
  assert.deepEqual(await s.forloeb.genoptag(), []);
});

test('genstart beholder en optagelse med lyd', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.OPTAGER, mime: 'audio/mp4' }] });
  const [note] = await s.forloeb.genoptag();
  assert.equal(note.status, STATUS.GEMT);
  assert.equal(note.afbrudt, true);
});

test('slet markerer noten som slettet i alle statusser, og endeligSlet fjerner den', async () => {
  for (const status of [STATUS.FEJL, STATUS.GEMT, STATUS.TEKST_KLAR, STATUS.SENDT, STATUS.SENDER]) {
    const s = opsaet({ noter: [{ id: 'a', status }], nu: () => 5000 });
    await s.forloeb.slet('a');
    assert.equal(s.lager.kort.get('a').slettet, 5000, status);
    await s.forloeb.endeligSlet('a');
    assert.equal(s.lager.kort.has('a'), false, status);
  }
});

test('endeligSlet rører kun noter, der er markeret slettet', async () => {
  const s = opsaet();
  await s.forloeb.endeligSlet('a');
  assert.equal(s.lager.kort.has('a'), true);
});

const REFERAT_SVAR = { tekst: 'Fuld tekst', titel: 'AI-titel', referat: { opsummering: 'O' }, pdf: 'JVBERg==', filnavn: 'f.pdf' };

test('behandl sender titel, varighed og tidspunkt med', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.GEMT, mime: 'audio/mp4', oprettet: 7, titel: 'Tag', type: 'moede', varighedMs: 9000 }] });
  await s.forloeb.behandl('a');
  assert.deepEqual(s.t.lydArgs[3], { titel: 'Tag', type: 'moede', varighedMs: 9000, oprettet: 7 });
});

test('behandl gemmer referat, pdf og AI-titel', async () => {
  const s = opsaet({ sendLyd: async () => REFERAT_SVAR });
  await s.forloeb.behandl('a');
  const n = s.lager.kort.get('a');
  assert.equal(n.status, STATUS.TEKST_KLAR);
  assert.equal(n.titel, 'AI-titel');
  assert.deepEqual(n.referat, { opsummering: 'O' });
  assert.equal(n.pdf, 'JVBERg==');
  assert.equal(n.filnavn, 'f.pdf');
  assert.equal(n.tekst, 'Fuld tekst');
});

test('navngivOgSend gemmer titel før afsendelse', async () => {
  const s = opsaet({ sendLyd: fejl('net') });
  await s.forloeb.navngivOgSend('a', '  Møde om tag  ');
  const n = s.lager.kort.get('a');
  assert.equal(n.titel, 'Møde om tag');
  assert.equal(n.navngivet, true);
  assert.equal(s.t.lydArgs[3].titel, 'Møde om tag');
  assert.equal(n.fejlType, 'net');
});

test('tomt navn gemmes som navngivet uden titel', async () => {
  const s = opsaet({ sendLyd: fejl('net') });
  await s.forloeb.navngivOgSend('a', '   ');
  const n = s.lager.kort.get('a');
  assert.equal(n.titel, '');
  assert.equal(n.navngivet, true);
});

test('navnet overlever netværksfejl og genforsøg', async () => {
  let forsoeg = 0;
  const s = opsaet({ sendLyd: async () => { forsoeg++; if (forsoeg === 1) throw Object.assign(new Error(), { type: 'net' }); return { ...REFERAT_SVAR, titel: 'Møde om tag' }; } });
  await s.forloeb.navngivOgSend('a', 'Møde om tag');
  assert.equal(s.lager.kort.get('a').status, STATUS.FEJL);
  await s.forloeb.behandlOgSend('a');
  assert.equal(s.t.lydArgs[3].titel, 'Møde om tag');
  assert.equal(s.t.mailKald.length, 1);
  assert.equal(s.lager.kort.get('a').status, STATUS.SENDT);
});

test('mail sendes automatisk efter referat', async () => {
  const s = opsaet({ sendLyd: async () => REFERAT_SVAR });
  await s.forloeb.navngivOgSend('a', '');
  assert.equal(s.t.mailKald.length, 1);
  assert.equal(s.t.mailKald[0].note.pdf, 'JVBERg==');
  assert.equal(s.lager.kort.get('a').status, STATUS.SENDT);
});

test('ingen mail ved tom tekst', async () => {
  const s = opsaet({ sendLyd: async () => ({ tekst: '' }) });
  await s.forloeb.navngivOgSend('a', 'x');
  assert.equal(s.t.mailKald.length, 0);
  assert.equal(s.lager.kort.get('a').fejlType, 'ingenTale');
});

test('mailfejl efter referat sender igen uden nyt referat', async () => {
  let mailForsoeg = 0;
  const s = opsaet({
    sendLyd: async () => REFERAT_SVAR,
    sendMail: async () => { mailForsoeg++; if (mailForsoeg === 1) throw Object.assign(new Error(), { type: 'mailFejl' }); },
  });
  await s.forloeb.navngivOgSend('a', 'x');
  assert.equal(s.lager.kort.get('a').fejlType, 'mailFejl');
  await s.forloeb.behandlOgSend('a');
  assert.equal(s.t.lydKald, 1);
  assert.equal(s.t.mailKald.length, 2);
  assert.equal(s.lager.kort.get('a').status, STATUS.SENDT);
});

test('behandlOgSend sender ikke, når mailen måske er sendt', async () => {
  const s = opsaet({ noter: [{ ...KLAR, maaskeSendt: true }] });
  await s.forloeb.behandlOgSend('a');
  assert.equal(s.t.mailKald.length, 0);
});

test('titel afkortes uden at dele en emoji', async () => {
  const s = opsaet({ sendLyd: fejl('net') });
  await s.forloeb.navngivOgSend('a', `${'a'.repeat(119)}🏗️`);
  const titel = s.lager.kort.get('a').titel;
  assert.equal(titel, titel.toWellFormed());
  assert.ok([...titel].length <= 120);
});

test('svarets type, emne og html gemmes', async () => {
  const s = opsaet({ sendLyd: async () => ({ ...REFERAT_SVAR, type: 'moede', emne: 'Møde: AI-titel – 2. nov. 2026', html: '<p>x</p>' }) });
  await s.forloeb.behandl('a');
  const n = s.lager.kort.get('a');
  assert.equal(n.type, 'moede');
  assert.equal(n.emne, 'Møde: AI-titel – 2. nov. 2026');
  assert.equal(n.html, '<p>x</p>');
});

test('svarets Word-dokument og filnavn gemmes på noten', async () => {
  const s = opsaet({ sendLyd: async () => ({ ...REFERAT_SVAR, docx: 'UEsDBA==', docxFilnavn: 'f.docx' }) });
  await s.forloeb.behandl('a');
  const n = s.lager.kort.get('a');
  assert.equal(n.docx, 'UEsDBA==');
  assert.equal(n.docxFilnavn, 'f.docx');
});

test('svar uden Word-dokument gemmes uden docx', async () => {
  const s = opsaet({ sendLyd: async () => REFERAT_SVAR });
  await s.forloeb.behandl('a');
  const n = s.lager.kort.get('a');
  assert.equal(n.pdf, 'JVBERg==');
  assert.equal('docx' in n, false);
  assert.equal('docxFilnavn' in n, false);
});

test('navngivOgSend gemmer navnet og sender ingen type for nye noter', async () => {
  const s = opsaet({ sendLyd: fejl('net') });
  await s.forloeb.navngivOgSend('a', 'Tag', 'byggenotat');
  assert.equal(s.lager.kort.get('a').titel, 'Tag');
  assert.equal(s.lager.kort.get('a').type, undefined);
  assert.equal(s.t.lydArgs[3].type, undefined);
});

test('en gammel note med valgt type beholder den og sendes med den', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.GEMT, mime: 'audio/mp4', oprettet: 1, type: 'moede' }], sendLyd: fejl('net') });
  await s.forloeb.navngivOgSend('a', 'Tag');
  assert.equal(s.lager.kort.get('a').type, 'moede');
  assert.equal(s.t.lydArgs[3].type, 'moede');
});

// Optagelser, der måske kører i en anden fane, må aldrig røres

const NU = 1_000_000_000;

test('ukendt låsetilstand: genstart rører ikke en optagelse, der lige har gemt lyd', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.OPTAGER, mime: 'audio/mp4', oprettet: NU - 600000, sidstAktiv: NU - 5000 }], nu: () => NU });
  assert.deepEqual(await s.forloeb.genoptag(null), []);
  assert.equal(s.lager.kort.get('a').status, STATUS.OPTAGER);
});

test('ukendt låsetilstand: genstart sletter ikke en ny optagelse uden lyd endnu', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.OPTAGER, mime: 'audio/mp4', oprettet: NU - 2000 }], nu: () => NU });
  s.lager.hentLyd = async () => new Blob([]);
  assert.deepEqual(await s.forloeb.genoptag(null), []);
  assert.equal(s.lager.kort.has('a'), true);
});

test('ukendt låsetilstand: en gammel afbrudt optagelse rettes som før', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.OPTAGER, mime: 'audio/mp4', oprettet: NU - 600000, sidstAktiv: NU - 120000 }], nu: () => NU });
  const [note] = await s.forloeb.genoptag(null);
  assert.equal(note.status, STATUS.GEMT);
  assert.equal(note.afbrudt, true);
});

test('behandl sender ikke en optagelse, der kører i en anden fane', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.OPTAGER, mime: 'audio/mp4', oprettet: NU - 600000 }], nu: () => NU, aktivAndetSted: async (id) => id === 'a' });
  await s.forloeb.behandlOgSend('a');
  assert.equal(s.t.lydKald, 0);
  assert.equal(s.lager.kort.get('a').status, STATUS.OPTAGER);
});

test('behandl med ukendt låsetilstand sender ikke en optagelse, der lige har gemt lyd', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.OPTAGER, mime: 'audio/mp4', sidstAktiv: NU - 3000 }], nu: () => NU, aktivAndetSted: async () => null });
  await s.forloeb.behandlOgSend('a');
  assert.equal(s.t.lydKald, 0);
});

test('behandl sender en afbrudt optagelse, der ikke kører andre steder', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.OPTAGER, mime: 'audio/mp4', sidstAktiv: NU - 120000 }], nu: () => NU, aktivAndetSted: async () => null });
  await s.forloeb.behandlOgSend('a');
  assert.equal(s.t.lydKald, 1);
});

test('genstart læser låsene efter noterne, så en optagelse, der starter imens, ikke slettes', async () => {
  // Den anden fane tager sin lås og opretter noten, mens denne fane starter op.
  const s = opsaet({ noter: [], nu: () => NU });
  s.lager.hentLyd = async () => new Blob([]);
  let laast = false;
  const alleNoter = s.lager.alleNoter;
  s.lager.alleNoter = async () => {
    laast = true;
    s.lager.kort.set('a', { id: 'a', status: STATUS.OPTAGER, mime: 'audio/mp4', oprettet: NU - 1000 });
    return alleNoter();
  };
  const hentAktive = async () => (laast ? new Set(['a']) : new Set());
  assert.deepEqual(await s.forloeb.genoptag(hentAktive), []);
  assert.equal(s.lager.kort.has('a'), true);
});

// Opbevaring i 7 dage

const DAG_MS = 24 * 60 * 60 * 1000;

test('ryd sletter kun sendte noter over 7 dage', async () => {
  const t0 = Date.UTC(2026, 10, 3, 12);
  const s = opsaet({
    nu: () => t0,
    noter: [
      { id: 'gammel-sendt', status: STATUS.SENDT, sendt: t0 - 7 * DAG_MS },
      { id: 'ny-sendt', status: STATUS.SENDT, sendt: t0 - 6 * DAG_MS },
      { id: 'sendt-uden-tid', status: STATUS.SENDT },
      { id: 'fejl', status: STATUS.FEJL, oprettet: t0 - 30 * DAG_MS, sendt: t0 - 30 * DAG_MS },
      { id: 'gemt', status: STATUS.GEMT, oprettet: t0 - 30 * DAG_MS },
      { id: 'klar', status: STATUS.TEKST_KLAR, oprettet: t0 - 30 * DAG_MS },
    ],
  });
  assert.equal(await s.forloeb.ryd(), 1);
  assert.deepEqual([...s.lager.kort.keys()].sort(), ['fejl', 'gemt', 'klar', 'ny-sendt', 'sendt-uden-tid']);
});

test('genoptag rydder op og viser sendte noter', async () => {
  const t0 = Date.UTC(2026, 10, 3, 12);
  const s = opsaet({
    nu: () => t0,
    noter: [
      { id: 'gammel', status: STATUS.SENDT, sendt: t0 - 8 * DAG_MS },
      { id: 'ny', status: STATUS.SENDT, sendt: t0 - DAG_MS },
    ],
  });
  const noter = await s.forloeb.genoptag();
  assert.deepEqual(noter.map((n) => n.id), ['ny']);
  assert.equal(s.lager.kort.has('gammel'), false);
});

// Send referat igen

const SENDT_NOTE = { id: 'a', status: STATUS.SENDT, sendt: 1000, tekst: 'T', referat: { opsummering: 'O' }, pdf: 'JVBERg==', emne: 'Møde: X – 3. nov. 2026', html: '<p>x</p>', oprettet: 1 };

test('send igen bruger den gemte pdf og laver intet kald til serveren', async () => {
  const s = opsaet({ noter: [SENDT_NOTE], nu: () => 5000 });
  await s.forloeb.sendIgen('a');
  assert.equal(s.t.lydKald, 0);
  assert.equal(s.t.mailKald.length, 1);
  assert.equal(s.t.mailKald[0].note.pdf, 'JVBERg==');
  assert.equal(s.t.mailKald[0].note.emne, 'Møde: X – 3. nov. 2026');
  assert.equal(s.t.mailKald[0].bevis, 'bevis-mail');
});

test('send igen ændrer ikke sendt, men gemmer sendtIgen', async () => {
  const s = opsaet({ noter: [SENDT_NOTE], nu: () => 5000 });
  await s.forloeb.sendIgen('a');
  const n = s.lager.kort.get('a');
  assert.equal(n.status, STATUS.SENDT);
  assert.equal(n.sendt, 1000);
  assert.equal(n.sendtIgen, 5000);
});

test('send igen med ukendt udfald giver måske sendt og sender ikke selv igen', async () => {
  const s = opsaet({ noter: [SENDT_NOTE], sendMail: fejl('mailUkendt') });
  await s.forloeb.sendIgen('a');
  const n = s.lager.kort.get('a');
  assert.equal(n.status, STATUS.SENDT);
  assert.equal(n.maaskeSendt, true);
  assert.equal(s.t.mailKald.length, 1);
});

test('send igen med udløbet login giver login, og andre fejl giver mailFejl', async () => {
  const a = opsaet({ noter: [SENDT_NOTE], sendMail: fejl('login') });
  await a.forloeb.sendIgen('a');
  assert.equal(a.lager.kort.get('a').fejlType, 'login');
  const b = opsaet({ noter: [SENDT_NOTE], sendMail: fejl('mailFejl') });
  await b.forloeb.sendIgen('a');
  assert.equal(b.lager.kort.get('a').fejlType, 'mailFejl');
  assert.equal(b.lager.kort.get('a').status, STATUS.SENDT);
});

test('vellykket send igen fjerner en tidligere fejl', async () => {
  const s = opsaet({ noter: [{ ...SENDT_NOTE, fejlType: 'mailFejl', maaskeSendt: true }] });
  await s.forloeb.sendIgen('a');
  assert.equal(s.lager.kort.get('a').fejlType, undefined);
  assert.equal(s.lager.kort.get('a').maaskeSendt, undefined);
});

test('to tryk på send igen giver én mail', async () => {
  const s = opsaet({ noter: [SENDT_NOTE] });
  await Promise.all([s.forloeb.sendIgen('a'), s.forloeb.sendIgen('a')]);
  assert.equal(s.t.mailKald.length, 1);
});

test('send igen virker kun på sendte noter med pdf', async () => {
  const s = opsaet({ noter: [{ ...KLAR }, { ...SENDT_NOTE, id: 'b', pdf: undefined }] });
  await s.forloeb.sendIgen('a');
  await s.forloeb.sendIgen('b');
  assert.equal(s.t.mailKald.length, 0);
});

// Flere dele giver ét referat

const DELT = { id: 'a', status: STATUS.GEMT, mime: 'audio/mp4', oprettet: 7, titel: 'Møde', type: 'moede', varighedMs: 90000, dele: 3 };
const delTekst = async (del) => ({ tekst: `Tekst ${await del.text()}` });

test('tre dele giver tre lydkald med kunTekst og ét referatkald', async () => {
  const s = opsaet({ noter: [DELT], sendLyd: delTekst });
  await s.forloeb.behandlOgSend('a');
  assert.equal(s.t.lydKald, 3);
  for (const [del, mime, bevis, meta] of s.t.lydListe) {
    assert.ok(del instanceof Blob);
    assert.equal(mime, 'audio/mp4');
    assert.equal(bevis, 'bevis-api');
    assert.equal(meta.kunTekst, true);
    assert.equal(meta.afsnit, true);
  }
  assert.equal(s.t.referatKald.length, 1);
  const [krop, bevis] = s.t.referatKald[0];
  const { dele, ...resten } = krop;
  assert.deepEqual(resten, { titel: 'Møde', type: 'moede', varighedMs: 90000, oprettet: 7 });
  assert.deepEqual(dele.map((d) => d.bidder.map((b) => b.tekst)), [['Tekst del0'], ['Tekst del1'], ['Tekst del2']]);
  assert.deepEqual(dele.map((d) => d.afbrudt), [false, true, true]);
  assert.equal(bevis, 'bevis-api');
  assert.equal(s.lager.kort.get('a').status, STATUS.SENDT);
  assert.equal(s.t.mailKald.length, 1);
});

test('en afbrudt ny optagelse uden type sendes til referatet uden type, og den valgte type gemmes', async () => {
  const { type, ...udenType } = DELT;
  const s = opsaet({ noter: [udenType], sendLyd: delTekst, sendReferat: async () => ({ ...REFERAT_SVAR, type: 'moede' }) });
  await s.forloeb.behandlOgSend('a');
  assert.equal(s.t.referatKald.length, 1);
  assert.equal(s.t.referatKald[0][0].type, undefined);
  for (const [, , , meta] of s.t.lydListe) assert.equal(meta.type, undefined);
  assert.equal(s.lager.kort.get('a').type, 'moede');
});

test('genforsøg sender ikke dele, der allerede er transskriberet', async () => {
  let kald = 0;
  const s = opsaet({ noter: [DELT], sendLyd: async (del) => { kald++; if (kald === 2) throw Object.assign(new Error(), { type: 'net' }); return delTekst(del); } });
  await s.forloeb.behandl('a');
  assert.equal(s.lager.kort.get('a').status, STATUS.FEJL);
  assert.equal(s.lager.kort.get('a').bidder[0].tekster[0].tekst, 'Tekst del0');
  await s.forloeb.behandl('a');
  assert.equal(kald, 4);
  assert.deepEqual(s.t.referatKald[0][0].dele.map((d) => d.bidder[0].tekst), ['Tekst del0', 'Tekst del1', 'Tekst del2']);
  assert.equal(s.lager.kort.get('a').status, STATUS.TEKST_KLAR);
});

test('en tavs del markeres som manglende (aldrig stille sprunget over), og alle tavse giver ingenTale', async () => {
  const s = opsaet({ noter: [DELT], sendLyd: async (del) => ((await del.text()) === 'del1' ? { tekst: '' } : delTekst(del)) });
  await s.forloeb.behandl('a');
  assert.deepEqual(s.t.referatKald[0][0].dele.map((d) => d.bidder[0].tekst), ['Tekst del0', '', 'Tekst del2']);
  assert.deepEqual(s.t.referatKald[0][0].dele.map((d) => d.bidder[0].mangler === true), [false, true, false]);
  const tavs = opsaet({ noter: [DELT], sendLyd: async () => ({ tekst: '' }) });
  await tavs.forloeb.behandl('a');
  assert.equal(tavs.lager.kort.get('a').status, STATUS.FEJL);
  assert.equal(tavs.lager.kort.get('a').fejlType, 'ingenTale');
  assert.equal(tavs.t.referatKald.length, 0);
});

test('fejl i referatkaldet beholder delteksterne og lyden', async () => {
  const s = opsaet({ noter: [DELT], sendLyd: delTekst, sendReferat: fejl('tjeneste') });
  await s.forloeb.behandl('a');
  const n = s.lager.kort.get('a');
  assert.equal(n.status, STATUS.FEJL);
  assert.equal(n.fejlType, 'tjeneste');
  assert.equal(Object.keys(n.bidder).length, 3);
  assert.ok((await s.lager.hentLyd('a')).size > 0);
  await s.forloeb.behandl('a');
  assert.equal(s.t.lydKald, 3);
});

test('en note med én del bruger den gamle vej', async () => {
  const s = opsaet();
  await s.forloeb.behandl('a');
  assert.equal(s.t.lydKald, 1);
  assert.equal(s.t.referatKald.length, 0);
  assert.equal(s.t.lydListe[0][3].kunTekst, undefined);
});

// Fremdrift til skærmen efter Send

test('fremdrift går sender → laver → mailer, og appen får besked', async () => {
  const set = [];
  let aendringer = 0;
  const s = opsaet({ sendLyd: async (lyd, mime, bevis, meta, hent, valg) => { valg.vedSendt(); return REFERAT_SVAR; }, vedAendring: () => { aendringer++; } });
  const opdater = s.lager.opdaterNote;
  s.lager.opdaterNote = async (id, felter) => { if ('fremdrift' in felter) set.push(felter.fremdrift); return opdater(id, felter); };
  await s.forloeb.behandlOgSend('a');
  assert.deepEqual(set, ['sender', 'laver', 'mailer', undefined]);
  assert.ok(aendringer >= 3);
});

// Slet med Fortryd

/** sendLyd, der først svarer, når den bliver afbrudt. */
const venterPaaAfbrydelse = (t) => (lyd, mime, bevis, meta, hent, valg) => new Promise((_, afvis) => {
  t.signal = valg?.signal;
  valg?.signal?.addEventListener('abort', () => afvis(Object.assign(new Error('net'), { type: 'net' })));
});

test('slet under afsendelse stopper den, og ingen mail sendes', async () => {
  const t = {};
  const s = opsaet({ sendLyd: venterPaaAfbrydelse(t), nu: () => 5000 });
  const afsendelse = s.forloeb.behandlOgSend('a');
  for (let i = 0; i < 20 && !t.signal; i++) await new Promise((ok) => setTimeout(ok, 1));
  await s.forloeb.slet('a');
  await afsendelse;
  assert.equal(t.signal.aborted, true);
  assert.equal(s.t.mailKald.length, 0);
  assert.equal(s.lager.kort.get('a').slettet, 5000);
});

test('fortryd bringer noten tilbage, og den kan sendes', async () => {
  const t = {};
  let gang = 0;
  const s = opsaet({ sendLyd: async (...a) => (++gang === 1 ? venterPaaAfbrydelse(t)(...a) : REFERAT_SVAR) });
  const afsendelse = s.forloeb.behandlOgSend('a');
  for (let i = 0; i < 20 && !t.signal; i++) await new Promise((ok) => setTimeout(ok, 1));
  await s.forloeb.slet('a');
  await afsendelse;
  await s.forloeb.fortrydSlet('a');
  assert.equal(s.lager.kort.get('a').slettet, undefined);
  await s.forloeb.behandlOgSend('a');
  assert.equal(s.lager.kort.get('a').status, STATUS.SENDT);
  assert.equal(s.t.mailKald.length, 1);
});

test('en slettet note sendes ikke, og Send igen virker ikke på den', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.GEMT, mime: 'audio/mp4', slettet: 1 }, { id: 'b', status: STATUS.SENDT, sendt: 1, pdf: 'x', slettet: 1 }] });
  await s.forloeb.behandlOgSend('a');
  await s.forloeb.sendIgen('b');
  assert.equal(s.t.lydKald, 0);
  assert.equal(s.t.mailKald.length, 0);
});

test('slettede noter ryddes ved næste start efter Fortryd-tiden og vises ikke', async () => {
  const NU2 = 1_000_000;
  const s = opsaet({
    nu: () => NU2,
    noter: [
      { id: 'gammel', status: STATUS.GEMT, slettet: NU2 - 8000 },
      { id: 'frisk', status: STATUS.GEMT, slettet: NU2 - 2000 },
      { id: 'synlig', status: STATUS.GEMT },
    ],
  });
  const vist = await s.forloeb.genoptag();
  assert.deepEqual(vist.map((n) => n.id), ['synlig']);
  assert.equal(s.lager.kort.has('gammel'), false);
  assert.equal(s.lager.kort.has('frisk'), true);
});

test('slet i de første millisekunder af en afsendelse: lyden sendes slet ikke', async () => {
  const s = opsaet({ nu: () => 5000 });
  const opdater = s.lager.opdaterNote;
  let slip;
  // Telefonens lager er langsomt lige der, hvor afsendelsen begynder.
  s.lager.opdaterNote = async (id, felter) => {
    if (felter.status === STATUS.SENDER) await new Promise((ok) => { slip = ok; });
    return opdater(id, felter);
  };
  const afsendelse = s.forloeb.behandlOgSend('a');
  for (let i = 0; i < 20 && !slip; i++) await new Promise((ok) => setTimeout(ok, 1));
  await s.forloeb.slet('a');
  slip();
  await afsendelse;
  assert.equal(s.t.lydKald, 0);
  assert.equal(s.t.mailKald.length, 0);
});

// Efter login sendes det, der ventede på login

test('sendVentende sender noter, der fejlede på login, og intet andet', async () => {
  const s = opsaet({
    sendLyd: async () => REFERAT_SVAR,
    noter: [
      { id: 'login-lyd', status: STATUS.FEJL, fejlType: 'login', mime: 'audio/mp4', oprettet: 1 },
      { id: 'login-mail', status: STATUS.TEKST_KLAR, fejlType: 'login', tekst: 'T', referat: { opsummering: 'O' }, pdf: 'x', oprettet: 2 },
      { id: 'net', status: STATUS.FEJL, fejlType: 'net', mime: 'audio/mp4', oprettet: 3 },
      { id: 'gemt', status: STATUS.GEMT, mime: 'audio/mp4', oprettet: 4 },
      { id: 'maaske', status: STATUS.TEKST_KLAR, fejlType: 'login', maaskeSendt: true, pdf: 'x', oprettet: 5 },
      { id: 'slettet', status: STATUS.FEJL, fejlType: 'login', slettet: 1, mime: 'audio/mp4', oprettet: 6 },
    ],
  });
  await s.forloeb.sendVentende();
  assert.equal(s.lager.kort.get('login-lyd').status, STATUS.SENDT);
  assert.equal(s.lager.kort.get('login-mail').status, STATUS.SENDT);
  assert.equal(s.lager.kort.get('net').status, STATUS.FEJL);
  assert.equal(s.lager.kort.get('gemt').status, STATUS.GEMT);
  assert.equal(s.lager.kort.get('maaske').status, STATUS.TEKST_KLAR);
  assert.equal(s.lager.kort.get('slettet').status, STATUS.FEJL);
  assert.equal(s.t.lydKald, 1);
  assert.equal(s.t.mailKald.length, 2);
});

test('sendVentende rydder alle ventende, før den sender, så en anden fane ikke tager dem', async () => {
  let andenUnderSend;
  const s = opsaet({
    sendLyd: async () => { andenUnderSend = s.lager.kort.get('to').fejlType; return REFERAT_SVAR; },
    noter: [
      { id: 'en', status: STATUS.FEJL, fejlType: 'login', mime: 'audio/mp4', oprettet: 1 },
      { id: 'to', status: STATUS.FEJL, fejlType: 'login', mime: 'audio/mp4', oprettet: 2 },
    ],
  });
  await s.forloeb.sendVentende();
  assert.equal(andenUnderSend, undefined);
  assert.equal(s.lager.kort.get('en').status, STATUS.SENDT);
  assert.equal(s.lager.kort.get('to').status, STATUS.SENDT);
});

test('sendVentende sender også Send referat igen, der fejlede på login', async () => {
  const s = opsaet({ noter: [{ ...SENDT_NOTE, fejlType: 'login' }], nu: () => 5000 });
  await s.forloeb.sendVentende();
  assert.equal(s.t.mailKald.length, 1);
  assert.equal(s.lager.kort.get('a').fejlType, undefined);
  assert.equal(s.lager.kort.get('a').sendtIgen, 5000);
});

// Fuld lagerplads. Lyden må aldrig gå tabt, og skærmen må aldrig hænge i "sender".

const FULD = () => new DOMException('fuld', 'QuotaExceededError');

/** Lageret fejler for skrivninger, hvor fuld(felter) er sand. */
function fuldtLager(s, fuld = () => true) {
  const opdater = s.lager.opdaterNote;
  s.lager.opdaterNote = async (id, felter) => {
    if (fuld(felter)) throw FULD();
    return opdater.call(s.lager, id, felter);
  };
  return () => { s.lager.opdaterNote = opdater; };
}

test('fuldt lager, når referatet gemmes: Fejlet med plads, og lyden bevares', async () => {
  const s = opsaet({ sendLyd: async () => REFERAT_SVAR });
  fuldtLager(s, (f) => 'pdf' in f);
  await s.forloeb.behandl('a');
  const n = s.lager.kort.get('a');
  assert.equal(n.status, STATUS.FEJL);
  assert.equal(n.fejlType, 'plads');
  assert.equal(s.lager.lydSlettet.size, 0);
});

test('kan intet skrives, vises fejlen alligevel, og Prøv igen virker, når der er plads', async () => {
  const s = opsaet({ sendLyd: async () => REFERAT_SVAR });
  const fri = fuldtLager(s);
  await s.forloeb.behandlOgSend('a');
  assert.equal(s.t.mailKald.length, 0);
  const vist = s.forloeb.medUgemt(await s.lager.hentNote('a'));
  assert.equal(vist.status, STATUS.FEJL);
  assert.equal(vist.fejlType, 'plads');
  assert.equal(s.lager.lydSlettet.size, 0);
  fri();
  await s.forloeb.behandlOgSend('a');
  assert.equal(s.t.mailKald.length, 1);
  assert.equal(s.lager.kort.get('a').status, STATUS.SENDT);
  assert.equal(s.forloeb.medUgemt(await s.lager.hentNote('a')).status, STATUS.SENDT);
});

test('fuldt lager før mailen: mailen sendes ikke, og noten viser plads i stedet for at hænge', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.TEKST_KLAR, mime: 'audio/mp4', oprettet: 1, tekst: 'x', referat: {}, pdf: 'p' }] });
  fuldtLager(s);
  await s.forloeb.sendTilMig('a');
  assert.equal(s.t.mailKald.length, 0);
  const vist = s.forloeb.medUgemt(await s.lager.hentNote('a'));
  assert.equal(vist.status, STATUS.TEKST_KLAR);
  assert.equal(vist.fejlType, 'plads');
  assert.equal(s.lager.lydSlettet.size, 0);
});

test('mailen er modtaget, men status kan ikke gemmes: vises som sendt, og lyden bevares til næste start', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.TEKST_KLAR, mime: 'audio/mp4', oprettet: 1, tekst: 'x', referat: {}, pdf: 'p' }] });
  fuldtLager(s, (f) => f.status === STATUS.SENDT);
  await s.forloeb.sendTilMig('a');
  assert.equal(s.t.mailKald.length, 1);
  assert.equal(s.forloeb.medUgemt(await s.lager.hentNote('a')).status, STATUS.SENDT);
  assert.equal(s.lager.lydSlettet.size, 0);
});

test('navnet kan ikke gemmes: intet sendes, ingen fejl kastes, og noten viser plads', async () => {
  const s = opsaet();
  fuldtLager(s);
  await s.forloeb.navngivOgSend('a', 'Tag');
  assert.equal(s.t.lydKald, 0);
  const vist = s.forloeb.medUgemt(await s.lager.hentNote('a'));
  assert.equal(vist.status, STATUS.FEJL);
  assert.equal(vist.fejlType, 'plads');
});

test('medUgemt ændrer ikke noter uden ugemte ændringer', async () => {
  const s = opsaet();
  const n = await s.lager.hentNote('a');
  assert.equal(s.forloeb.medUgemt(n), n);
  assert.equal(s.forloeb.medUgemt(null), null);
});

// Lydfiler, brugeren har valgt

const FIL = { id: 'f', status: STATUS.GEMT, kilde: 'fil', filnavn: 'Møde.mp3', mime: 'audio/mpeg', bytes: 3, varighedMs: 47 * 60 * 1000, titel: 'Møde', oprettet: 1 };

test('en gemt lydfil sendes som en optagelse, med format og varighed, og lyden slettes først ved 202', async () => {
  const s = opsaet({ noter: [FIL], sendLyd: async () => REFERAT_SVAR });
  await s.forloeb.navngivOgSend('f', 'Møde');
  const [lyd, mime, , meta] = s.t.lydArgs;
  assert.equal(mime, 'audio/mpeg');
  assert.equal(meta.varighedMs, 47 * 60 * 1000);
  assert.ok(lyd);
  assert.equal(s.lager.kort.get('f').status, STATUS.SENDT);
  assert.equal(s.lager.lydSlettet.has('f'), true);
});

test('en lydfil, der fejler på nettet, beholder lyden og kan prøves igen', async () => {
  let gang = 0;
  const s = opsaet({ noter: [FIL], sendLyd: async () => { if (gang++ === 0) throw Object.assign(new Error('net'), { type: 'net' }); return REFERAT_SVAR; } });
  await s.forloeb.navngivOgSend('f', 'Møde');
  assert.equal(s.lager.kort.get('f').status, STATUS.FEJL);
  assert.equal(s.lager.kort.get('f').fejlType, 'net');
  assert.equal(s.lager.lydSlettet.has('f'), false);
  await s.forloeb.behandlOgSend('f');
  assert.equal(s.lager.kort.get('f').status, STATUS.SENDT);
  assert.equal(s.t.lydKald, 2);
});

test('fremdriften under upload gives til appen med sendte og samlede bytes og gemmes ikke', async () => {
  const meldt = [];
  const s = opsaet({
    noter: [FIL],
    sendLyd: async (lyd, mime, bevis, meta, hent, valg) => { valg.vedFremdrift(10, 40); valg.vedFremdrift(40, 40); valg.vedSendt(); return REFERAT_SVAR; },
    vedUpload: (...a) => meldt.push(a),
  });
  const opdater = s.lager.opdaterNote;
  const felter = [];
  s.lager.opdaterNote = async (id, f) => { felter.push(...Object.keys(f)); return opdater(id, f); };
  await s.forloeb.behandl('f');
  assert.deepEqual(meldt, [['f', 10, 40], ['f', 40, 40]]);
  assert.ok(!felter.some((k) => /upload|sendtBytes/i.test(k)), felter.join());
});

test('en lydfil, der ikke er færdig med at blive gemt, sendes aldrig', async () => {
  const s = opsaet({ noter: [{ ...FIL, status: STATUS.OPTAGER, sidstAktiv: NU - 600000 }], nu: () => NU, aktivAndetSted: async () => false });
  await s.forloeb.behandlOgSend('f');
  assert.equal(s.t.lydKald, 0);
  assert.equal(s.lager.kort.get('f').status, STATUS.OPTAGER);
});

test('genstart fjerner en halvt gemt lydfil, men ikke én, der stadig gemmes i en anden fane', async () => {
  const halv = { ...FIL, status: STATUS.OPTAGER, sidstAktiv: NU - 600000 };
  const s = opsaet({ noter: [halv], nu: () => NU });
  assert.deepEqual(await s.forloeb.genoptag(new Set()), []);
  assert.equal(s.lager.kort.has('f'), false);
  const s2 = opsaet({ noter: [halv], nu: () => NU });
  assert.deepEqual(await s2.forloeb.genoptag(new Set(['f'])), []);
  assert.equal(s2.lager.kort.has('f'), true);
});

// Transskriptionen lykkedes, men referatet fejlede på serveren: kun referatet laves igen

const UDEN_REFERAT = async () => ({ tekst: 'Hej fra pladsen', referatMangler: true });
const LANG_FIL = { ...FIL, varighedMs: 95 * 60 * 1000, oprettet: 1234, type: 'moede' };

test('referatMangler: teksten gemmes som deltekst, og referatet laves via /referat uden ny upload', async () => {
  const s = opsaet({ noter: [LANG_FIL], sendLyd: UDEN_REFERAT });
  await s.forloeb.behandlOgSend('f');
  assert.equal(s.t.lydKald, 1);
  assert.equal(s.t.referatKald.length, 1);
  const { dele, ...resten } = s.t.referatKald[0][0];
  assert.deepEqual(resten, { titel: 'Møde', type: 'moede', varighedMs: 95 * 60 * 1000, oprettet: 1234 });
  assert.equal(dele[0].bidder[0].tekst, 'Hej fra pladsen');
  const n = s.lager.kort.get('f');
  assert.equal(n.bidder[0].tekster[0].tekst, 'Hej fra pladsen');
  assert.equal(n.status, STATUS.SENDT);
  assert.equal(s.t.mailKald.length, 1);
});

test('referatMangler og /referat fejler: Fejlet med teksten gemt, og Prøv igen laver kun referatet', async () => {
  let referatGang = 0;
  const s = opsaet({
    noter: [LANG_FIL],
    sendLyd: async (lyd, mime, bevis, meta, hent, valg) => { valg.vedSendt(); return UDEN_REFERAT(); },
    sendReferat: async (krop) => { if (referatGang++ === 0) throw Object.assign(new Error('tjeneste'), { type: 'tjeneste' }); return { ...REFERAT_SVAR, tekst: krop.dele[0].bidder[0].tekst }; },
  });
  await s.forloeb.behandlOgSend('f');
  let n = s.lager.kort.get('f');
  assert.equal(n.status, STATUS.FEJL);
  assert.equal(n.fejlType, 'tjeneste');
  assert.equal(n.fremdrift, 'laver');
  assert.equal(n.bidder[0].tekster[0].tekst, 'Hej fra pladsen');
  assert.equal(s.lager.lydSlettet.has('f'), false);

  const set = [];
  const opdater = s.lager.opdaterNote;
  s.lager.opdaterNote = async (id, felter) => { if ('fremdrift' in felter) set.push(felter.fremdrift); return opdater(id, felter); };
  await s.forloeb.behandlOgSend('f');
  n = s.lager.kort.get('f');
  assert.equal(s.t.lydKald, 1, 'lyden må ikke sendes igen');
  assert.equal(s.t.referatKald.length, 2);
  assert.equal(n.status, STATUS.SENDT);
  assert.equal(n.tekst, 'Hej fra pladsen');
  // Skærmen viser, at referatet laves, ikke at lyden sendes.
  assert.deepEqual(set.slice(0, 2), ['sender', 'laver']);
});

test('en note med én del og gemt deltekst sender aldrig lyden igen', async () => {
  const s = opsaet({ noter: [{ ...FIL, status: STATUS.FEJL, fejlType: 'tjeneste', deltekster: ['Gemt tekst'] }] });
  await s.forloeb.behandl('f');
  assert.equal(s.t.lydKald, 0);
  assert.equal(s.t.referatKald[0][0].dele[0].bidder[0].tekst, 'Gemt tekst');
  assert.equal(s.lager.kort.get('f').status, STATUS.TEKST_KLAR);
});

// Lange optagelser i bidder

const MIN = 60000;
const LANG = { id: 'a', status: STATUS.GEMT, mime: 'audio/mp4', oprettet: 7, titel: 'Langt møde', varighedMs: 180 * MIN, delVarigheder: [180 * MIN] };

/** Falsk klipning: enheder på et minut, og en bid er teksten "d<del>:<fra>-<til>" i minutter. */
function falskOpdeling({ kanIkke = [] } = {}) {
  const o = {
    async lavIndeks(kilde) {
      if (kanIkke.includes(kilde.del) || !kilde.varighedMs) return null;
      const n = Math.ceil(kilde.varighedMs / MIN);
      return { format: 'falsk', del: kilde.del, varighedMs: kilde.varighedMs, enheder: Array.from({ length: n }, (_, i) => ({ tidMs: i * MIN, fra: i, til: i + 1 })) };
    },
    planlaegBidder,
    async lavBid(kilde, indeks, bid) { return new Blob([`d${indeks.del}:${bid.startMs / MIN}-${bid.slutMs / MIN}`]); },
  };
  return o;
}
const BIDDER_STD = { bidMs: 30 * MIN, overlapMs: 30000, delFraMs: 35 * MIN, smaaBidMs: 10 * MIN };
const bidTekst = async (lyd) => {
  const t = await lyd.text();
  return { tekst: `Tekst ${t}`, afsnit: [{ sek: 0, tekst: `Tekst ${t}` }] };
};
const blokeret = () => Object.assign(new Error(), { type: 'blokeret' });

test('3 timer giver 6 bidder med kunTekst, afsnit og bidens længde, og ét referat', async () => {
  const s = opsaet({ noter: [LANG], sendLyd: bidTekst, opdeling: falskOpdeling(), bidder: BIDDER_STD });
  await s.forloeb.behandlOgSend('a');
  assert.equal(s.t.lydKald, 6);
  const sendt = await Promise.all(s.t.lydListe.map(([lyd]) => lyd.text()));
  assert.deepEqual(sendt.sort(), ['d0:0-30', 'd0:29-60', 'd0:59-90', 'd0:89-120', 'd0:119-150', 'd0:149-180'].sort());
  for (const [, , , meta] of s.t.lydListe) {
    assert.equal(meta.kunTekst, true);
    assert.equal(meta.afsnit, true);
    assert.ok(meta.varighedMs === 30 * MIN || meta.varighedMs === 31 * MIN, String(meta.varighedMs));
  }
  const { dele, varighedMs, titel } = s.t.referatKald[0][0];
  assert.equal(varighedMs, 180 * MIN);
  assert.equal(titel, 'Langt møde');
  assert.equal(dele.length, 1);
  assert.equal(dele[0].varighedSek, 10800);
  assert.deepEqual(dele[0].bidder.map((b) => [b.startSek, b.overlapSek, b.varighedSek]), [[0, 0, 1800], [1740, 60, 1860], [3540, 60, 1860], [5340, 60, 1860], [7140, 60, 1860], [8940, 60, 1860]]);
  assert.deepEqual(dele[0].bidder[1].afsnit, [{ sek: 0, tekst: 'Tekst d0:29-60' }]);
  assert.equal(s.lager.kort.get('a').status, STATUS.SENDT);
});

test('højst tre bidder sendes ad gangen', async () => {
  let nu = 0;
  let hoejest = 0;
  const s = opsaet({
    noter: [LANG], opdeling: falskOpdeling(), bidder: BIDDER_STD,
    sendLyd: async (lyd) => { nu++; hoejest = Math.max(hoejest, nu); await new Promise((ok) => setTimeout(ok, 5)); nu--; return bidTekst(lyd); },
  });
  await s.forloeb.behandl('a');
  assert.equal(hoejest, 3);
  assert.equal(s.t.lydKald, 6);
});

test('en netfejl på én bid giver Fejlet med net, gemmer de andre, og Prøv igen sender kun de manglende', async () => {
  let fejlet = false;
  const s = opsaet({
    noter: [LANG], opdeling: falskOpdeling(), bidder: BIDDER_STD,
    sendLyd: async (lyd) => {
      if ((await lyd.text()) === 'd0:59-90' && !fejlet) { fejlet = true; throw Object.assign(new Error(), { type: 'net' }); }
      return bidTekst(lyd);
    },
  });
  await s.forloeb.behandl('a');
  const n = s.lager.kort.get('a');
  assert.equal(n.status, STATUS.FEJL);
  assert.equal(n.fejlType, 'net');
  const gemt = Object.keys(n.bidder[0].tekster).length;
  assert.ok(gemt >= 2 && gemt < 6, `de bidder, der lykkedes, er gemt (${gemt})`);
  const foer = s.t.lydKald;
  await s.forloeb.behandl('a');
  assert.equal(s.lager.kort.get('a').status, STATUS.TEKST_KLAR);
  assert.equal(s.t.lydKald - foer, 6 - gemt, 'kun de manglende sendes igen');
  assert.equal(s.t.referatKald.length, 1);
});

test('en note fra før opdateringen med deltekster som strenge sender dem aldrig igen', async () => {
  const s = opsaet({ noter: [{ ...DELT, deltekster: ['Gammel del0', 'Gammel del1'] }], sendLyd: delTekst });
  await s.forloeb.behandl('a');
  assert.equal(s.t.lydKald, 1);
  assert.deepEqual(s.t.referatKald[0][0].dele.map((d) => d.bidder[0].tekst), ['Gammel del0', 'Gammel del1', 'Tekst del2']);
});

test('en bid, som Googles filter blokerer, prøves igen i småbidder på 10 min.', async () => {
  const s = opsaet({
    noter: [LANG], opdeling: falskOpdeling(), bidder: BIDDER_STD,
    sendLyd: async (lyd) => { if ((await lyd.text()) === 'd0:29-60') throw blokeret(); return bidTekst(lyd); },
  });
  await s.forloeb.behandl('a');
  const sendt = await Promise.all(s.t.lydListe.map(([lyd]) => lyd.text()));
  for (const smaa of ['d0:29-39', 'd0:38-49', 'd0:48-60']) assert.ok(sendt.includes(smaa), `${smaa} i ${sendt}`);
  const bidder = s.t.referatKald[0][0].dele[0].bidder;
  assert.equal(bidder.length, 8);
  assert.deepEqual(bidder.slice(1, 4).map((b) => [b.startSek, b.overlapSek]), [[1740, 60], [2280, 60], [2880, 60]]);
  assert.equal(s.lager.kort.get('a').status, STATUS.TEKST_KLAR);
});

test('en småbid, der også blokeres, mangler, og referatet laves af resten', async () => {
  const s = opsaet({
    noter: [LANG], opdeling: falskOpdeling(), bidder: BIDDER_STD,
    sendLyd: async (lyd) => { if (['d0:29-60', 'd0:38-49'].includes(await lyd.text())) throw blokeret(); return bidTekst(lyd); },
  });
  await s.forloeb.behandl('a');
  const bidder = s.t.referatKald[0][0].dele[0].bidder;
  const mangler = bidder.filter((b) => b.mangler);
  assert.equal(mangler.length, 1);
  assert.deepEqual([mangler[0].startSek, mangler[0].tekst], [2280, '']);
  assert.equal(s.lager.kort.get('a').status, STATUS.TEKST_KLAR);
});

test('er alle bidder blokeret, fejler noten med blokeret, og intet referat bestilles', async () => {
  const s = opsaet({ noter: [LANG], opdeling: falskOpdeling(), bidder: BIDDER_STD, sendLyd: async () => { throw blokeret(); } });
  await s.forloeb.behandl('a');
  assert.equal(s.lager.kort.get('a').status, STATUS.FEJL);
  assert.equal(s.lager.kort.get('a').fejlType, 'blokeret');
  assert.equal(s.t.referatKald.length, 0);
});

test('en afbrudt optagelse med to lange dele sender afbrudt på del 2 og hver dels længde', async () => {
  const note = { ...LANG, dele: 2, varighedMs: 100 * MIN, delVarigheder: [60 * MIN, 40 * MIN] };
  const s = opsaet({ noter: [note], sendLyd: bidTekst, opdeling: falskOpdeling(), bidder: BIDDER_STD });
  await s.forloeb.behandl('a');
  const { dele } = s.t.referatKald[0][0];
  assert.deepEqual(dele.map((d) => [d.afbrudt, d.varighedSek, d.bidder.length]), [[false, 3600, 2], [true, 2400, 2]]);
});

test('flere filer: hver fil sendes med sin egen type og får sit filnavn', async () => {
  const note = {
    id: 'a', status: STATUS.GEMT, kilde: 'filer', oprettet: 7, mime: 'audio/mp4', varighedMs: 20 * MIN, delVarigheder: [10 * MIN, 10 * MIN],
    filer: [{ navn: 'Møde_del1.m4a', mime: 'audio/mp4', varighedMs: 10 * MIN }, { navn: 'Møde_del2.mp3', mime: 'audio/mpeg', varighedMs: 10 * MIN }],
  };
  const s = opsaet({ noter: [note], sendLyd: bidTekst, opdeling: falskOpdeling(), bidder: BIDDER_STD });
  await s.forloeb.behandl('a');
  assert.deepEqual(s.t.lydListe.map((a) => a[1]).sort(), ['audio/mp4', 'audio/mpeg']);
  const { dele } = s.t.referatKald[0][0];
  assert.deepEqual(dele.map((d) => [d.filnavn, d.afbrudt]), [['Møde_del1.m4a', false], ['Møde_del2.mp3', false]]);
  // En kort del sendes hel, ikke som en ny indpakning.
  assert.deepEqual((await Promise.all(s.t.lydListe.map(([l]) => l.text()))).sort(), ['del0', 'del1']);
});

test('en lydfil, der ikke kan klippes og er over 2½ time, giver forLang', async () => {
  const s = opsaet({ noter: [{ ...LANG, mime: 'audio/ogg' }], sendLyd: bidTekst, opdeling: falskOpdeling({ kanIkke: [0] }), bidder: BIDDER_STD });
  await s.forloeb.behandl('a');
  assert.equal(s.lager.kort.get('a').fejlType, 'forLang');
  assert.equal(s.t.lydKald, 0);
});

test('fremdriften i bidder meldes til skærmen', async () => {
  const meldt = [];
  const s = opsaet({ noter: [LANG], sendLyd: bidTekst, opdeling: falskOpdeling(), bidder: BIDDER_STD, vedBidder: (id, f) => meldt.push(f) });
  await s.forloeb.behandl('a');
  assert.deepEqual(meldt[0], { ialt: 6, faerdige: 0 });
  assert.deepEqual(meldt.at(-1), { ialt: 6, faerdige: 6 });
});

test('slet under afsendelse af bidder stopper alle, og intet mailes', async () => {
  const t = {};
  const s = opsaet({ noter: [LANG], opdeling: falskOpdeling(), bidder: BIDDER_STD, sendLyd: venterPaaAfbrydelse(t) });
  const kaeden = s.forloeb.behandlOgSend('a');
  await new Promise((ok) => setTimeout(ok, 30));
  assert.equal(s.t.lydKald, 3);
  await s.forloeb.slet('a');
  await kaeden;
  assert.equal(s.t.mailKald.length, 0);
  assert.equal(s.t.referatKald.length, 0);
  assert.equal(s.t.lydKald, 3, 'ingen nye bidder efter Slet');
});

test('et svar med huller gemmes på noten, så Læs kan vise det', async () => {
  const s = opsaet({ noter: [LANG], sendLyd: bidTekst, opdeling: falskOpdeling(), bidder: BIDDER_STD, sendReferat: async () => ({ ...REFERAT_SVAR, huller: 1, mangler: ['29:00-1:00:00'] }) });
  await s.forloeb.behandl('a');
  assert.equal(s.lager.kort.get('a').huller, 1);
  assert.deepEqual(s.lager.kort.get('a').mangler, ['29:00-1:00:00'], 'tidsrummet til trin-skærmen og Læs');
});

test('en bid, der kommer tom tilbage, prøves igen og bruger teksten fra andet forsøg', async () => {
  let forsoeg = 0;
  const s = opsaet({
    noter: [LANG], opdeling: falskOpdeling(), bidder: BIDDER_STD,
    sendLyd: async (lyd) => {
      if ((await lyd.text()) === 'd0:29-60' && forsoeg++ === 0) return { tekst: '', afsnit: [] };
      return bidTekst(lyd);
    },
  });
  await s.forloeb.behandl('a');
  assert.equal(s.t.lydKald, 7, '6 bidder og ét nyt forsøg');
  const bid = s.t.referatKald[0][0].dele[0].bidder[1];
  assert.equal(bid.tekst, 'Tekst d0:29-60');
  assert.notEqual(bid.mangler, true);
});

test('en bid, der også er tom anden gang, sendes som manglende, aldrig som stilhed', async () => {
  const s = opsaet({
    noter: [LANG], opdeling: falskOpdeling(), bidder: BIDDER_STD,
    sendLyd: async (lyd) => ((await lyd.text()) === 'd0:29-60' ? { tekst: '   ', afsnit: [{ sek: 0, tekst: '' }] } : bidTekst(lyd)),
  });
  await s.forloeb.behandl('a');
  assert.equal(s.t.lydKald, 7, 'kun ét nyt forsøg');
  const bid = s.t.referatKald[0][0].dele[0].bidder[1];
  assert.deepEqual([bid.startSek, bid.mangler, bid.tekst], [1740, true, '']);
  assert.equal(s.lager.kort.get('a').status, STATUS.TEKST_KLAR);
});

// Rettelser fra gennemgangen

test('flere lydfiler, der ikke blev gemt færdig, sendes aldrig og fjernes ved genstart', async () => {
  const halv = { id: 'h', status: STATUS.OPTAGER, kilde: 'filer', mime: 'audio/mp4', oprettet: 1, sidstAktiv: 0, filer: [{ navn: 'a.m4a', mime: 'audio/mp4' }] };
  const s = opsaet({ noter: [halv], nu: () => 10 * 60 * 1000, aktivAndetSted: async () => false });
  await s.forloeb.behandlOgSend('h');
  assert.equal(s.t.lydKald, 0);
  assert.deepEqual(await s.forloeb.genoptag(new Set()), []);
  assert.equal(s.lager.kort.has('h'), false);
});

test('en tom del efter Fortsæt springes over, så noten stadig kan sendes', async () => {
  const s = opsaet({ noter: [{ ...DELT, tommeDele: [1] }], sendLyd: delTekst });
  await s.forloeb.behandlOgSend('a');
  assert.equal(s.t.lydKald, 2);
  assert.deepEqual(s.t.referatKald[0][0].dele.map((d) => d.bidder[0].tekst), ['Tekst del0', '', 'Tekst del2']);
  assert.equal(s.lager.kort.get('a').status, STATUS.SENDT);
});

test('gamle deltekster hører til delene med lyd, også når en del er tom', async () => {
  const s = opsaet({ noter: [{ ...DELT, tommeDele: [1], deltekster: ['Gammel A', 'Gammel C'] }], sendLyd: delTekst });
  await s.forloeb.behandl('a');
  assert.equal(s.t.lydKald, 0);
  assert.deepEqual(s.t.referatKald[0][0].dele.map((d) => d.bidder[0].tekst), ['Gammel A', '', 'Gammel C']);
});

test('kun bidder, appen kan dele i småbidder, siger det til serveren', async () => {
  const s = opsaet({
    noter: [LANG], opdeling: falskOpdeling(), bidder: BIDDER_STD,
    sendLyd: async (lyd, ...a) => { if ((await lyd.text()) === 'd0:29-60') throw blokeret(); return bidTekst(lyd, ...a); },
  });
  await s.forloeb.behandl('a');
  const efterTekst = await Promise.all(s.t.lydListe.map(async ([lyd, , , meta]) => [await lyd.text(), meta.smaabidder]));
  const kort = new Map(efterTekst);
  assert.equal(kort.get('d0:0-30'), true, 'en hel bid på 30 min.');
  assert.equal(kort.get('d0:29-39'), false, 'en småbid');
  const udelt = opsaet({ noter: [{ ...LANG, mime: 'audio/ogg', varighedMs: 100 * MIN, delVarigheder: [100 * MIN] }], sendLyd: bidTekst, opdeling: falskOpdeling({ kanIkke: [0] }), bidder: BIDDER_STD });
  await udelt.forloeb.behandl('a');
  assert.equal(udelt.t.lydListe[0][3].smaabidder, false, 'en del, der ikke kan klippes');
});
