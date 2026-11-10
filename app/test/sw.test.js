import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const KILDE = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const RODEN = 'https://pilotollgaard.github.io/TransskriberinsAPP/';

/** Kører sw.js som i drift (ikke localhost) og giver dens fetch-lytter. */
function lavServiceWorker() {
  const lyttere = {};
  const cache = { match: async (noegle) => (noegle === './' ? 'forsiden fra cachen' : null) };
  const aabnet = [];
  const self = {
    location: new URL('https://pilotollgaard.github.io/TransskriberinsAPP/sw.js'),
    registration: { scope: RODEN },
    addEventListener: (navn, fn) => { lyttere[navn] = fn; },
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => aabnet.vinduer || [],
      openWindow: async (url) => { aabnet.push(url); },
    },
  };
  vm.runInNewContext(KILDE, { self, location: self.location, caches: { open: async () => cache }, fetch: async () => 'fra nettet', URL, Request, Response });
  const hent = (url, mode = 'navigate') => {
    let svar = null;
    lyttere.fetch({ request: { url, method: 'GET', mode }, respondWith: (p) => { svar = p; } });
    return svar;
  };
  hent.lyttere = lyttere;
  hent.aabnet = aabnet;
  return hent;
}

test('appens forside hentes fra cachen, også uden net', async () => {
  const hent = lavServiceWorker();
  assert.equal(await hent(RODEN), 'forsiden fra cachen');
  assert.equal(await hent(`${RODEN}index.html`), 'forsiden fra cachen');
  assert.equal(await hent(`${RODEN}?x=1`), 'forsiden fra cachen');
});

test('andre sider på samme adresse får aldrig appens forside', () => {
  const hent = lavServiceWorker();
  assert.equal(hent(`${RODEN}notifikationstest.html`), null);
  assert.equal(hent(`${RODEN}noget-andet.html`), null);
});

test('tryk på notifikationen åbner appen eller viser den, der allerede er åben', async () => {
  const sw = lavServiceWorker();
  let lukket = false;
  let venter;
  sw.lyttere.notificationclick({ notification: { close: () => { lukket = true; } }, waitUntil: (p) => { venter = p; } });
  await venter;
  assert.equal(lukket, true);
  assert.deepEqual([...sw.aabnet], ['./']);
  let fokus = false;
  sw.aabnet.vinduer = [{ focus: async () => { fokus = true; } }];
  sw.lyttere.notificationclick({ notification: { close: () => {} }, waitUntil: (p) => { venter = p; } });
  await venter;
  assert.equal(fokus, true);
  assert.deepEqual([...sw.aabnet], ['./']);
});

// Del-menuen på Android (Web Share Target): filen lægges midlertidigt i Cache Storage, og appen åbnes.

function lavDelSW({ putFejl = null } = {}) {
  const lyttere = {};
  const lagre = new Map();
  const slettet = [];
  const caches = {
    open: async (navn) => {
      if (!lagre.has(navn)) lagre.set(navn, new Map());
      const l = lagre.get(navn);
      return {
        match: async (n) => l.get(String(n)) ?? null,
        put: async (n, svar) => { if (putFejl) throw putFejl; l.set(String(n), svar); },
        addAll: async () => {},
      };
    },
    keys: async () => [...lagre.keys()],
    delete: async (navn) => { slettet.push(navn); return lagre.delete(navn); },
  };
  const self = {
    location: new URL(`${RODEN}sw.js`),
    registration: { scope: RODEN },
    addEventListener: (navn, fn) => { lyttere[navn] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  vm.runInNewContext(KILDE, { self, location: self.location, caches, fetch: async () => 'fra nettet', URL, Request, Response, FormData, File, Blob, encodeURIComponent });
  async function post(sti, krop) {
    let svar = null;
    lyttere.fetch({ request: new Request(RODEN + sti, { method: 'POST', body: krop }), respondWith: (p) => { svar = p; } });
    return svar && svar;
  }
  return { lyttere, lagre, slettet, post, caches };
}

test('en lydfil fra del-menuen lægges midlertidigt, og appen åbnes med 303', async () => {
  const sw = lavDelSW();
  const krop = new FormData();
  krop.append('lyd', new File([new Uint8Array([1, 2, 3, 250])], 'Møde på pladsen.m4a', { type: 'audio/x-m4a' }));
  const svar = await sw.post('del', krop);
  assert.equal(svar.status, 303);
  assert.equal(svar.headers.get('location'), `${RODEN}?delt=1`);
  const [navn] = [...sw.lagre.keys()].filter((n) => n !== 'udvikling');
  const gemt = sw.lagre.get(navn).get(`${RODEN}delt-fil`);
  assert.ok(gemt, 'filen blev ikke lagt');
  assert.deepEqual([...new Uint8Array(await gemt.clone().arrayBuffer())], [1, 2, 3, 250]);
  assert.equal(gemt.headers.get('content-type'), 'audio/x-m4a');
  assert.equal(decodeURIComponent(gemt.headers.get('x-filnavn')), 'Møde på pladsen.m4a');
});

test('del uden fil eller med fuldt lager åbner appen med en besked i stedet for at fejle', async () => {
  const uden = await lavDelSW().post('del', new FormData());
  assert.equal(uden.status, 303);
  assert.equal(uden.headers.get('location'), `${RODEN}?delt=0`);
  const krop = new FormData();
  krop.append('lyd', new File([new Uint8Array([1])], 'x.m4a', { type: 'audio/mp4' }));
  const fuld = await lavDelSW({ putFejl: new DOMException('fuld', 'QuotaExceededError') }).post('del', krop);
  assert.equal(fuld.headers.get('location'), `${RODEN}?delt=plads`);
});

test('andre POST-kald røres ikke af service workeren', async () => {
  const sw = lavDelSW();
  assert.equal(await sw.post('transskriber', 'x'), null);
  assert.equal(await sw.post('del/andet', 'x'), null);
});

test('den delte fil overlever, når en ny udgave af appen rydder gamle caches', async () => {
  const sw = lavDelSW();
  const krop = new FormData();
  krop.append('lyd', new File([new Uint8Array([1])], 'x.m4a', { type: 'audio/mp4' }));
  await sw.post('del', krop);
  await sw.caches.open('gammel-udgave');
  let venter;
  sw.lyttere.activate({ waitUntil: (p) => { venter = p; } });
  await venter;
  assert.deepEqual(sw.slettet, ['gammel-udgave']);
});

test('manifestet har del-menuen til lydfiler, som POST med multipart til ./del', () => {
  const m = JSON.parse(readFileSync(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(m.share_target.action, './del');
  assert.equal(m.share_target.method, 'POST');
  assert.equal(m.share_target.enctype, 'multipart/form-data');
  const [filer] = m.share_target.params.files;
  assert.equal(filer.name, 'lyd');
  for (const t of ['audio/*', '.m4a', '.mp3', '.wav']) assert.ok(filer.accept.includes(t), t);
});
