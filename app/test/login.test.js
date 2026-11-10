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
  return { getItem: (k) => gemt[k] ?? null, setItem: (k, v) => { gemt[k] = v; }, removeItem: (k) => { delete gemt[k]; } };
}

const NET_OK = async () => ({ ok: true });

function lav(f, hukommelse = falskHukommelse(), ekstra = {}) {
  return lavLogin({ msal: f, entra: ENTRA, redirectUri: 'https://x/app/', hukommelse, hent: NET_OK, stopSide: () => {}, ...ekstra });
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
  // Et skift til Microsoft, der ikke bliver til noget, opgives efter 10 s i stedet for 30.
  assert.equal(f.opsaetning.system.redirectNavigationTimeout, 10000);
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

// Login, der fornyes af sig selv

function falskMsalMed(ekstra = {}) {
  const f = falskMsal(ekstra);
  f.redirects = [];
  f.ryddet = 0;
  const Klasse = f.PublicClientApplication;
  f.PublicClientApplication = class extends Klasse {
    // Som MSAL: spørger onRedirectNavigate. Skifter siden, men forlades den ikke, fejler kaldet efter tidsgrænsen.
    async acquireTokenRedirect(valg) {
      f.redirects.push(valg);
      if (valg.onRedirectNavigate?.('https://login.microsoftonline.com/t') === false) return;
      throw Object.assign(new Error('failed_to_redirect'), { errorCode: 'failed_to_redirect' });
    }
    async clearCache() { f.ryddet++; }
  };
  return f;
}

test('tjekLogin giver ja, nej og ukendt', async () => {
  const ja = lav(falskMsalMed());
  await ja.init();
  assert.equal(await ja.tjekLogin(), 'ja');
  const nej = lav(falskMsalMed({ konti: [] }));
  await nej.init();
  assert.equal(await nej.tjekLogin(), 'nej');
  const udloebet = lav(falskMsalMed({ tilstille: async () => { throw Object.assign(new Error(), { errorCode: 'interaction_required' }); } }));
  await udloebet.init();
  assert.equal(await udloebet.tjekLogin(), 'nej');
  const udenNet = lav(falskMsalMed({ tilstille: async () => { throw Object.assign(new Error(), { errorCode: 'no_network_connectivity' }); } }));
  await udenNet.init();
  assert.equal(await udenNet.tjekLogin(), 'ukendt');
});

test('fornyStille omdirigerer med prompt none og sidste bruger', async () => {
  const hukommelse = falskHukommelse();
  await lav(falskMsalMed(), hukommelse).init();
  const f = falskMsalMed({ konti: [] });
  const l = lav(f, hukommelse);
  await l.init();
  await l.fornyStille();
  assert.equal(f.redirects.length, 1);
  assert.equal(f.redirects[0].prompt, 'none');
  assert.equal(f.redirects[0].loginHint, 'a@ollgaard.dk');
  assert.deepEqual(f.redirects[0].scopes, ['api://c/access_as_user']);
});

test('fornyStille højst én gang pr. 10 minutter', async () => {
  const hukommelse = falskHukommelse();
  let tid = 1_000_000;
  const f = falskMsalMed({ konti: [] });
  const l = lav(f, hukommelse, { nu: () => tid });
  await l.init();
  await l.fornyStille();
  tid += 5 * 60 * 1000;
  await l.fornyStille();
  assert.equal(f.redirects.length, 1);
  tid += 6 * 60 * 1000;
  await l.fornyStille();
  assert.equal(f.redirects.length, 2);
});

test('fornyStille skifter ikke til Microsoft uden net, der virker', async () => {
  let svar = async () => { throw new Error('timeout'); };
  const f = falskMsalMed({ konti: [] });
  const l = lav(f, falskHukommelse(), { hent: (...a) => svar(...a) });
  await l.init();
  await l.fornyStille();
  svar = async () => ({ ok: false });
  await l.fornyStille();
  assert.equal(f.redirects.length, 0);
  // Et forsøg uden net tæller ikke med i de 10 minutter.
  let adresse;
  svar = async (url, valg) => { adresse = url; assert.ok(valg.signal); return { ok: true }; };
  await l.fornyStille();
  assert.equal(f.redirects.length, 1);
  assert.equal(adresse, 'https://login.microsoftonline.com/t/v2.0/.well-known/openid-configuration');
});

test('fornyStille skifter ikke, når appen er gået i gang med noget', async () => {
  const f = falskMsalMed({ konti: [] });
  let stoppet = 0;
  const l = lav(f, falskHukommelse(), { stopSide: () => { stoppet++; } });
  await l.init();
  await l.fornyStille(() => false);
  assert.equal(f.redirects.length, 0);
  // Går appen i gang, lige før siden skifter, skifter den ikke.
  let svar = true;
  const l2 = lav(f, falskHukommelse(), { stopSide: () => { stoppet++; } });
  await l2.init();
  await l2.fornyStille(() => { const s = svar; svar = false; return s; });
  assert.equal(f.redirects.length, 1);
  assert.equal(stoppet, 0);
});

test('et skift til Microsoft, der ikke bliver til noget, stoppes, så det ikke kan afbryde senere', async () => {
  const f = falskMsalMed({ konti: [] });
  let stoppet = 0;
  const l = lav(f, falskHukommelse(), { stopSide: () => { stoppet++; } });
  await l.init();
  await l.fornyStille();
  assert.equal(f.redirects.length, 1);
  assert.equal(stoppet, 1);
});

test('kommer appen tilbage fra Microsoft uden login, fornyes der ikke igen før næste login', async () => {
  const hukommelse = falskHukommelse();
  let tid = 1_000_000;
  const forsoeg = lav(falskMsalMed({ konti: [] }), hukommelse, { nu: () => tid });
  await forsoeg.init();
  await forsoeg.fornyStille();
  // Microsoft svarer interaction_required, og appen starter igen.
  tid += 5000;
  const f = falskMsalMed({ konti: [] });
  f.PublicClientApplication.prototype.handleRedirectPromise = async () => { throw Object.assign(new Error(), { errorCode: 'interaction_required' }); };
  const tilbage = lav(f, hukommelse, { nu: () => tid });
  await tilbage.init();
  tid += 60 * 60 * 1000;
  await tilbage.fornyStille();
  assert.equal(f.redirects.length, 0);
  // Efter et login med tryk virker fornyelsen igen.
  await lav(falskMsalMed(), hukommelse, { nu: () => tid }).init();
  const igen = falskMsalMed({ konti: [] });
  const senere = lav(igen, hukommelse, { nu: () => tid });
  await senere.init();
  await senere.fornyStille();
  assert.equal(igen.redirects.length, 1);
});

test('brugerMail husker sidste bruger, også når kontoen er væk', async () => {
  const hukommelse = falskHukommelse();
  await lav(falskMsalMed(), hukommelse).init();
  const efter = lav(falskMsalMed({ konti: [] }), hukommelse);
  await efter.init();
  assert.equal(efter.brugerMail(), 'a@ollgaard.dk');
});

test('logUd rydder login og glemmer brugeren', async () => {
  const hukommelse = falskHukommelse();
  hukommelse.removeItem = (k) => { hukommelse.setItem(k, null); };
  const f = falskMsalMed();
  const l = lav(f, hukommelse);
  await l.init();
  await l.logUd();
  assert.equal(f.ryddet, 1);
  assert.equal(l.harVaeretLoggetInd(), false);
  assert.equal(hukommelse.getItem('sidsteBruger'), null);
});

test('efter Log ud fornyes der ikke, og næste login lader brugeren vælge konto', async () => {
  const hukommelse = falskHukommelse();
  hukommelse.removeItem = (k) => { hukommelse.setItem(k, null); };
  const f = falskMsalMed();
  const l = lav(f, hukommelse);
  await l.init();
  await l.logUd();
  const efter = falskMsalMed({ konti: [] });
  const ny = lav(efter, hukommelse);
  await ny.init();
  await ny.fornyStille();
  assert.equal(efter.redirects.length, 0);
  await ny.logInd();
  assert.equal(efter.omdirigeret[0].prompt, 'select_account');
  // Når man er logget ind igen, spørges der ikke længere om konto.
  await lav(falskMsalMed(), hukommelse).init();
  const igen = falskMsalMed();
  const tredje = lav(igen, hukommelse);
  await tredje.init();
  await tredje.logInd();
  assert.equal(igen.omdirigeret[0].prompt, undefined);
});
