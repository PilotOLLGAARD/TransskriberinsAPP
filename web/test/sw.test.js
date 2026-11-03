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
