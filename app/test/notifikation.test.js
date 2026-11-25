import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTIFIKATIONER, lavNotifikationer } from '../js/notifikation.js';

/** En falsk service worker-registrering, der husker de viste og lukkede notifikationer. */
function lavRegistrering({ fejl = false, udenListe = false } = {}) {
  const vist = [];
  const lukket = [];
  const reg = {
    vist,
    lukket,
    showNotification: async (titel, valg) => {
      if (fejl) throw new TypeError('nej');
      vist.push({ titel, ...valg });
    },
  };
  if (!udenListe) reg.getNotifications = async () => vist.map((v) => ({ close: () => lukket.push(v.tag) }));
  return reg;
}

const lov = (permission, spurgt = []) => ({ permission, requestPermission: async () => { spurgt.push(1); return 'granted'; } });

test('teksterne er korte og på dansk', () => {
  assert.equal(NOTIFIKATIONER.stoppet.tekst, 'Optagelsen er stoppet – åbn appen for at fortsætte');
  assert.equal(NOTIFIKATIONER.ikkeSendtEndnu.tekst, 'Referatet er ikke sendt endnu – åbn appen, så det bliver færdigt');
  assert.equal(NOTIFIKATIONER.sendt.tekst, 'Dit referat er sendt til din mail');
  assert.equal(NOTIFIKATIONER.fejlet.tekst, 'Referatet blev ikke sendt – åbn appen, og tryk Prøv igen');
});

test('vis viser intet uden tilladelse', async () => {
  const reg = lavRegistrering();
  const serviceWorker = { ready: Promise.resolve(reg) };
  for (const notifikation of [lov('denied'), lov('default'), undefined]) {
    assert.equal(await lavNotifikationer({ notifikation, serviceWorker }).vis('stoppet', 'a'), false);
  }
  assert.deepEqual(reg.vist, []);
});

test('vis bruger slagens tag, et mål til tryk og gentager kun lyden ved sendt og fejlet', async () => {
  const reg = lavRegistrering();
  const n = lavNotifikationer({ notifikation: lov('granted'), serviceWorker: { ready: Promise.resolve(reg) } });
  assert.equal(await n.vis('stoppet', 'a'), true);
  await n.vis('ikkeSendtEndnu');
  await n.vis('sendt', 'b');
  await n.vis('fejlet', 'c');
  assert.deepEqual(reg.vist.map((v) => [v.titel, v.body, v.tag, v.data, v.renotify]), [
    ['Transskribering', NOTIFIKATIONER.stoppet.tekst, 'optagelse', { maal: 'navn', id: 'a' }, false],
    ['Transskribering', NOTIFIKATIONER.ikkeSendtEndnu.tekst, 'referat', { maal: 'start', id: null }, false],
    ['Transskribering', NOTIFIKATIONER.sendt.tekst, 'referat', { maal: 'tidligere', id: 'b' }, true],
    ['Transskribering', NOTIFIKATIONER.fejlet.tekst, 'referat', { maal: 'start', id: 'c' }, true],
  ]);
});

test('vis venter ikke på service workeren, når registreringen allerede er kendt', async () => {
  const reg = lavRegistrering();
  let hentet = 0;
  const serviceWorker = { get ready() { hentet++; return Promise.resolve(reg); } };
  const n = lavNotifikationer({ notifikation: lov('granted'), serviceWorker });
  await n.vis('stoppet', 'a');
  await n.vis('stoppet', 'b');
  assert.equal(hentet, 1);
  assert.equal(reg.vist.length, 2);
});

test('vis giver false og kaster aldrig, når telefonen afviser', async () => {
  const n = lavNotifikationer({ notifikation: lov('granted'), serviceWorker: { ready: Promise.resolve(lavRegistrering({ fejl: true })) } });
  assert.equal(await n.vis('stoppet', 'a'), false);
  const udenSW = lavNotifikationer({ notifikation: lov('granted'), serviceWorker: undefined });
  assert.equal(await udenSW.vis('stoppet', 'a'), false);
  const afvist = lavNotifikationer({ notifikation: lov('granted'), serviceWorker: { ready: Promise.reject(new Error('nej')) } });
  assert.equal(await afvist.vis('stoppet', 'a'), false);
  assert.equal(await n.vis('ukendt'), false);
});

test('luk fjerner appens notifikationer og kaster aldrig', async () => {
  const reg = lavRegistrering();
  const n = lavNotifikationer({ notifikation: lov('granted'), serviceWorker: { ready: Promise.resolve(reg) } });
  await n.vis('stoppet', 'a');
  await n.vis('sendt', 'b');
  await n.luk();
  assert.deepEqual(reg.lukket, ['optagelse', 'referat']);
  const udenListe = lavNotifikationer({ notifikation: lov('granted'), serviceWorker: { ready: Promise.resolve(lavRegistrering({ udenListe: true })) } });
  await udenListe.luk();
  await lavNotifikationer({ notifikation: undefined, serviceWorker: undefined }).luk();
});

test('tilstand siger, om notifikationer er slået til', () => {
  const t = (notifikation) => lavNotifikationer({ notifikation, serviceWorker: undefined }).tilstand();
  assert.equal(t(lov('granted')), 'til');
  assert.equal(t(lov('denied')), 'fra');
  assert.equal(t(lov('default')), 'spoerg');
  assert.equal(t(undefined), 'mangler');
});

test('bedOmTilladelse spørger kun, når tilladelsen ikke er afgjort', async () => {
  const spurgt = [];
  const sp = (notifikation) => lavNotifikationer({ notifikation, serviceWorker: undefined }).bedOmTilladelse();
  await sp(lov('granted', spurgt));
  await sp(lov('denied', spurgt));
  await sp(undefined);
  assert.equal(spurgt.length, 0);
  await sp(lov('default', spurgt));
  assert.equal(spurgt.length, 1);
  await sp({ permission: 'default', requestPermission: async () => { throw new TypeError('nej'); } });
});
