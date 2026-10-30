import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lavForloeb } from '../js/forloeb.js';
import { LoginKraevet } from '../js/login.js';
import { STATUS } from '../js/tilstand.js';

function falskLager(noter = []) {
  const kort = new Map(noter.map((n) => [n.id, { ...n }]));
  return {
    kort,
    async hentNote(id) { const n = kort.get(id); return n ? { ...n } : null; },
    async opdaterNote(id, felter) { Object.assign(kort.get(id), felter); },
    async hentLyd(id) { return kort.has(id) ? new Blob(['lyd']) : null; },
    async sletNote(id) { kort.delete(id); },
    async alleNoter() { return [...kort.values()].map((n) => ({ ...n })); },
  };
}

function opsaet({ noter = [{ id: 'a', status: STATUS.GEMT, mime: 'audio/mp4', oprettet: 1 }], sendLyd, sendMail, hentBevis } = {}) {
  const lager = falskLager(noter);
  const t = { lydKald: 0, mailKald: [] };
  const forloeb = lavForloeb({
    lager,
    login: {
      hentBevis: hentBevis || (async (o) => `bevis-${o}`),
      brugerMail: () => 'a@ollgaard.dk',
    },
    sendLyd: async (...a) => {
      t.lydKald++;
      t.lydArgs = a;
      return sendLyd ? sendLyd(...a) : { tekst: 'Hej' };
    },
    sendMail: async (v) => {
      t.mailKald.push(v);
      return sendMail ? sendMail(v) : undefined;
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

test('202 sletter note og lyd', async () => {
  const s = opsaet({ noter: [KLAR] });
  await s.forloeb.sendTilMig('a');
  assert.equal(s.lager.kort.has('a'), false);
  assert.equal(await s.lager.hentLyd('a'), null);
});

test('mail går kun til brugeren selv', async () => {
  const s = opsaet({ noter: [KLAR] });
  await s.forloeb.sendTilMig('a');
  assert.deepEqual(s.t.mailKald, [{ tekst: 'Min note', til: 'a@ollgaard.dk', oprettet: 7, bevis: 'bevis-mail' }]);
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

test('bekræftet mail sletter noten', async () => {
  const s = opsaet({ noter: [{ ...KLAR, maaskeSendt: true }] });
  await s.forloeb.bekraeftSendt('a');
  assert.equal(s.lager.kort.has('a'), false);
  assert.equal(s.t.mailKald.length, 0);
});

test('bekræftelse afvises uden advarsel om mulig afsendelse', async () => {
  const s = opsaet({ noter: [KLAR] });
  await assert.rejects(s.forloeb.bekraeftSendt('a'));
  assert.equal(s.lager.kort.has('a'), true);
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

test('slet virker på fejlede noter', async () => {
  const s = opsaet({ noter: [{ id: 'a', status: STATUS.FEJL, fejlType: 'kanIkkeBehandles' }] });
  await s.forloeb.slet('a');
  assert.equal(s.lager.kort.has('a'), false);
});

test('slet kræver fejl-status', async () => {
  for (const status of [STATUS.GEMT, STATUS.TEKST_KLAR, STATUS.SENDER, STATUS.SENDER_MAIL]) {
    const s = opsaet({ noter: [{ id: 'a', status }] });
    await assert.rejects(s.forloeb.slet('a'));
    assert.equal(s.lager.kort.has('a'), true);
  }
});
