import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lavLogin, lavLokalLogin, LoginKraevet } from '../js/login.js';

const ENTRA = { tenantId: 't', clientId: 'c' };
const KONTO = { username: 'a@ollgaard.dk' };

function falskMsal({ konti = [KONTO], tilstille = async () => ({ accessToken: 'bevis' }), retur = null } = {}) {
  const f = { kald: [], omdirigeret: [], CacheLookupPolicy: { AccessTokenAndRefreshToken: 2 } };
  f.PublicClientApplication = class {
    constructor(opsaetning) { f.opsaetning = opsaetning; }
    async initialize() { f.initialiseret = true; }
    async handleRedirectPromise() { f.haandteret = true; return retur; }
    getAllAccounts() { return konti; }
    setActiveAccount(konto) { f.aktiv = konto; }
    getActiveAccount() { return f.aktiv ?? null; }
    async acquireTokenSilent(valg) { f.kald.push(valg); return tilstille(valg); }
    async loginRedirect(valg) { f.omdirigeret.push(valg); }
  };
  return f;
}

function falskHukommelse() {
  const gemt = {};
  return { getItem: (k) => gemt[k] ?? null, setItem: (k, v) => { gemt[k] = v; } };
}

function lav(f, hukommelse = falskHukommelse()) {
  return lavLogin({ msal: f, entra: ENTRA, redirectUri: 'https://x/app/', hukommelse });
}

test('husker tidligere login, selvom kontoen er væk efter koldstart', async () => {
  const hukommelse = falskHukommelse();
  const foer = lav(falskMsal(), hukommelse);
  assert.equal(foer.harVaeretLoggetInd(), false);
  await foer.init();
  assert.equal(foer.harVaeretLoggetInd(), true);

  const efter = lav(falskMsal({ konti: [] }), hukommelse);
  await efter.init();
  assert.equal(efter.harKonto(), false);
  assert.equal(efter.harVaeretLoggetInd(), true);
});

test('ingen konto er ikke et tidligere login', async () => {
  const l = lav(falskMsal({ konti: [] }));
  await l.init();
  assert.equal(l.harVaeretLoggetInd(), false);
});

test('manglende MSAL vælter ikke appen', async () => {
  const l = lav(undefined);
  await assert.rejects(l.init());
  assert.equal(l.harKonto(), false);
  assert.equal(l.brugerMail(), '');
  await assert.rejects(l.hentBevis('api'), LoginKraevet);
});

test('fejl fra MSALs lager vælter ikke appen', async () => {
  const f = falskMsal();
  f.PublicClientApplication.prototype.getAllAccounts = () => { throw new Error('ikke klar'); };
  const l = lav(f);
  await l.init();
  assert.equal(l.harKonto(), false);
});

test('init færdiggør et login og bruger localStorage og redirect-adressen', async () => {
  const f = falskMsal();
  await lav(f).init();
  assert.ok(f.initialiseret);
  assert.ok(f.haandteret);
  assert.equal(f.opsaetning.cache.cacheLocation, 'localStorage');
  assert.equal(f.opsaetning.auth.redirectUri, 'https://x/app/');
  assert.equal(f.opsaetning.auth.authority, 'https://login.microsoftonline.com/t');
});

test('init må ikke vælte, hvis login fejlede', async () => {
  const f = falskMsal();
  f.PublicClientApplication.prototype.handleRedirectPromise = async () => { throw new Error('fejl'); };
  await lav(f).init();
  assert.ok(f.initialiseret);
});

test('harKonto og brugerMail læser kontoen', async () => {
  const l = lav(falskMsal());
  await l.init();
  assert.equal(l.harKonto(), true);
  assert.equal(l.brugerMail(), 'a@ollgaard.dk');
});

test('ingen konto', async () => {
  const l = lav(falskMsal({ konti: [] }));
  await l.init();
  assert.equal(l.harKonto(), false);
  await assert.rejects(l.hentBevis('api'), LoginKraevet);
});

test('api-bevis bruger appens scope', async () => {
  const f = falskMsal();
  const l = lav(f);
  await l.init();
  assert.equal(await l.hentBevis('api'), 'bevis');
  assert.deepEqual(f.kald[0].scopes, ['api://c/access_as_user']);
  assert.equal(f.kald[0].account, KONTO);
});

test('konto fra et nyt login bruges frem for en gammel', async () => {
  const ny = { username: 'ny@ollgaard.dk' };
  const f = falskMsal({ konti: [KONTO, ny], retur: { account: ny } });
  const l = lav(f);
  await l.init();
  assert.equal(l.brugerMail(), 'ny@ollgaard.dk');
  await l.hentBevis('api');
  assert.equal(f.kald[0].account, ny);
});

test('beviser hentes uden skjult login-vindue', async () => {
  const f = falskMsal();
  const l = lav(f);
  await l.init();
  await l.hentBevis('api');
  assert.equal(f.kald[0].cacheLookupPolicy, 2);
});

test('fejlet netværkskald under fornyelse giver net', async () => {
  for (const errorCode of ['get_request_failed', 'post_request_failed']) {
    const fejl = Object.assign(new Error('x'), { errorCode });
    const l = lav(falskMsal({ tilstille: async () => { throw fejl; } }));
    await l.init();
    await assert.rejects(l.hentBevis('api'), (e) => e.type === 'net', errorCode);
  }
});

test('mail-bevis bruger Mail.Send', async () => {
  const f = falskMsal();
  const l = lav(f);
  await l.init();
  await l.hentBevis('mail');
  assert.deepEqual(f.kald[0].scopes, ['https://graph.microsoft.com/Mail.Send']);
});

test('krav om login giver LoginKraevet', async () => {
  const fejl = Object.assign(new Error('x'), { name: 'InteractionRequiredAuthError', errorCode: 'interaction_required' });
  const l = lav(falskMsal({ tilstille: async () => { throw fejl; } }));
  await l.init();
  await assert.rejects(l.hentBevis('api'), LoginKraevet);
});

test('blokeret fornyelse i Safari giver LoginKraevet', async () => {
  const fejl = Object.assign(new Error('x'), { name: 'BrowserAuthError', errorCode: 'monitor_window_timeout' });
  const l = lav(falskMsal({ tilstille: async () => { throw fejl; } }));
  await l.init();
  await assert.rejects(l.hentBevis('api'), LoginKraevet);
});

test('manglende net giver net, ikke login', async () => {
  const fejl = Object.assign(new Error('x'), { name: 'BrowserAuthError', errorCode: 'no_network_connectivity' });
  const l = lav(falskMsal({ tilstille: async () => { throw fejl; } }));
  await l.init();
  await assert.rejects(l.hentBevis('api'), (e) => e.type === 'net');
});

test('lokal login: manglende net giver net', async () => {
  const gemt = { testKonto: '1' };
  globalThis.localStorage = { getItem: (k) => gemt[k] ?? null, setItem: (k, v) => { gemt[k] = v; } };
  const hentNormal = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    await assert.rejects(lavLokalLogin().hentBevis('api'), (e) => e.type === 'net');
  } finally {
    globalThis.fetch = hentNormal;
    delete globalThis.localStorage;
  }
});

test('logInd beder om begge tilladelser på én gang', async () => {
  const f = falskMsal();
  const l = lav(f);
  await l.init();
  await l.logInd();
  assert.deepEqual(f.omdirigeret[0].scopes, ['api://c/access_as_user']);
  assert.deepEqual(f.omdirigeret[0].extraScopesToConsent, ['https://graph.microsoft.com/Mail.Send']);
});
