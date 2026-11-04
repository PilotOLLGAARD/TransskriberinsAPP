// Login med Microsoft Entra ID via MSAL. Beslutningen om adgang tages på serveren.
// Redirect, ikke popup. Login startes kun, når brugeren trykker, så det aldrig afbryder en optagelse.

const MAIL_SCOPE = 'https://graph.microsoft.com/Mail.Send';
const NET_KODER = new Set([
  'no_network_connectivity',
  'post_request_failed',
  'get_request_failed',
  'endpoints_resolution_error',
  'network_error',
]);

export class LoginKraevet extends Error {
  constructor() {
    super('login');
    this.type = 'login';
  }
}

class NetFejl extends Error {
  constructor() {
    super('net');
    this.type = 'net';
  }
}

const HAR_VAERET_LOGGET_IND = 'harVaeretLoggetInd';
const SIDSTE_BRUGER = 'sidsteBruger';
const SIDST_FORNYET = 'sidstForsoegtFornyelse';
// Sat, når Microsoft svarede uden login, eller efter Log ud. Så fornyes der ikke, før man selv logger ind.
const FORNY_IKKE = 'fornyIkke';
// Efter Log ud skal næste login lade brugeren vælge konto.
const VAELG_KONTO = 'vaelgKonto';
// Fornyelse uden tryk forsøges højst så ofte, så appen aldrig sender brugeren i ring.
const FORNY_MS = 10 * 60 * 1000;
// Så længe må tjekket af nettet tage, før appen opgiver at forny.
const NET_MS = 4000;
// Er siden ikke skiftet til Microsoft efter så lang tid, opgives og stoppes skiftet.
const SKIFT_MS = 10 * 1000;
// Et svar fra Microsoft så kort efter et forsøg på at forny regnes som svaret på det.
const SVAR_MS = 2 * 60 * 1000;

/** Om man kan sende lige nu: 'ja', 'nej' (login kræves) eller 'ukendt' (intet net). */
async function tjek(hentBevis) {
  try {
    await hentBevis('api');
    return 'ja';
  } catch (e) {
    return e?.type === 'net' ? 'ukendt' : 'nej';
  }
}

export function lavLogin({
  msal, entra, redirectUri,
  hukommelse = globalThis.localStorage,
  nu = Date.now,
  hent = (...a) => globalThis.fetch(...a),
  stopSide = () => globalThis.stop?.(),
}) {
  const apiScope = `api://${entra.clientId}/access_as_user`;
  const authority = `https://login.microsoftonline.com/${entra.tenantId}`;
  let app;

  // MSAL krypterer sit lager med en sessions-cookie, så kontoen kan være væk, efter telefonen har lukket appen.
  const konto = () => {
    try {
      return app?.getActiveAccount() ?? app?.getAllAccounts()[0] ?? null;
    } catch {
      return null;
    }
  };

  return {
    async init() {
      app = new msal.PublicClientApplication({
        auth: {
          clientId: entra.clientId,
          authority,
          redirectUri,
          navigateToLoginRequestUrl: false,
        },
        cache: { cacheLocation: 'localStorage' },
        system: { redirectNavigationTimeout: SKIFT_MS },
      });
      await app.initialize();
      let afvist = false;
      try {
        // Efter et nyt login er det den konto, der skal bruges, også hvis en gammel ligger i lageret.
        const svar = await app.handleRedirectPromise();
        if (svar?.account) app.setActiveAccount(svar.account);
      } catch {
        // Et mislykket login må ikke forhindre appen i at starte. Optagelser skal kunne nås.
        afvist = true;
      }
      const k = konto();
      if (k) {
        hukommelse.setItem(HAR_VAERET_LOGGET_IND, '1');
        if (k.username) hukommelse.setItem(SIDSTE_BRUGER, k.username);
        hukommelse.removeItem(FORNY_IKKE);
        hukommelse.removeItem(VAELG_KONTO);
      } else if (afvist && nu() - Number(hukommelse.getItem(SIDST_FORNYET) || 0) < SVAR_MS) {
        // Microsoft kunne ikke forny uden tryk. Så skiftes der ikke igen ved hver åbning.
        hukommelse.setItem(FORNY_IKKE, '1');
      }
    },

    harKonto: () => Boolean(konto()),
    harVaeretLoggetInd: () => Boolean(hukommelse.getItem(HAR_VAERET_LOGGET_IND)),
    // Kontoen kan være væk efter en koldstart. Så vises den sidste bruger.
    brugerMail: () => konto()?.username ?? hukommelse.getItem(SIDSTE_BRUGER) ?? '',

    /** @param {'api'|'mail'} omraade */
    async hentBevis(omraade) {
      const account = konto();
      if (!account) throw new LoginKraevet();
      try {
        const { accessToken } = await app.acquireTokenSilent({
          scopes: [omraade === 'mail' ? MAIL_SCOPE : apiScope],
          account,
          // Ingen skjult login-ramme: den blokeres af Safari og af appens sikkerhedsregler.
          // Kan beviset ikke fornyes, beder appen om login, når brugeren trykker.
          cacheLookupPolicy: msal.CacheLookupPolicy?.AccessTokenAndRefreshToken ?? 2,
        });
        return accessToken;
      } catch (e) {
        if (NET_KODER.has(e?.errorCode)) throw new NetFejl();
        throw new LoginKraevet();
      }
    },

    logInd() {
      const valg = { scopes: [apiScope], extraScopesToConsent: [MAIL_SCOPE] };
      if (hukommelse.getItem(VAELG_KONTO)) valg.prompt = 'select_account';
      return app.loginRedirect(valg);
    },

    tjekLogin() {
      return tjek((o) => this.hentBevis(o));
    },

    /**
     * Fornyer login uden tryk: et hurtigt skift til Microsoft og tilbage (prompt none).
     * Lykkes skiftet, forlades siden, og funktionen vender aldrig tilbage. Vender den tilbage, blev der ikke fornyet.
     * maaNavigere spørges lige før siden skifter. Er appen gået i gang med noget, skifter den ikke.
     */
    async fornyStille(maaNavigere = () => true) {
      if (hukommelse.getItem(FORNY_IKKE)) return;
      if (nu() - Number(hukommelse.getItem(SIDST_FORNYET) || 0) < FORNY_MS) return;
      // Kun med net, der virker. Ellers står appen på en fejlside hos Microsoft i stedet for i appen.
      try {
        const svar = await hent(`${authority}/v2.0/.well-known/openid-configuration`, { cache: 'no-store', signal: AbortSignal.timeout(NET_MS) });
        if (!svar?.ok) return;
      } catch {
        return;
      }
      if (!maaNavigere()) return;
      hukommelse.setItem(SIDST_FORNYET, String(nu()));
      let skifter = false;
      try {
        await app.acquireTokenRedirect({
          scopes: [apiScope],
          prompt: 'none',
          loginHint: hukommelse.getItem(SIDSTE_BRUGER) || undefined,
          onRedirectNavigate: () => (skifter = maaNavigere()),
        });
      } catch {
        // Fx failed_to_redirect, når siden ikke er skiftet efter SKIFT_MS.
      }
      // Er appen her stadig, blev skiftet ikke til noget. Et skift, der stadig venter, stoppes,
      // så det ikke kan afbryde en optagelse senere.
      if (skifter) stopSide();
    },

    /** Logger kun ud af appen. Optagelser på telefonen bliver liggende. Appen logger ikke selv ind igen. */
    async logUd() {
      await app.clearCache();
      hukommelse.removeItem(HAR_VAERET_LOGGET_IND);
      hukommelse.removeItem(SIDSTE_BRUGER);
      hukommelse.setItem(FORNY_IKKE, '1');
      hukommelse.setItem(VAELG_KONTO, '1');
    },
  };
}

/** Falsk login til den lokale server. Bruges kun på localhost. */
export function lavLokalLogin() {
  return {
    async init() {},
    harKonto: () => Boolean(localStorage.getItem('testKonto')),
    harVaeretLoggetInd: () => Boolean(localStorage.getItem('testTidligere')),
    brugerMail: () => 'test@ollgaard.dk',
    async hentBevis(omraade) {
      if (!localStorage.getItem('testKonto')) throw new LoginKraevet();
      if (omraade === 'mail') return 'falsk-graph-bevis';
      try {
        const svar = await fetch(`/test/bevis?type=${localStorage.getItem('testType') || 'medarbejder'}`);
        return (await svar.json()).bevis;
      } catch {
        throw new NetFejl();
      }
    },
    async logInd() {
      localStorage.removeItem('testFornyIkke');
      localStorage.setItem('testKonto', '1');
      localStorage.setItem('testTidligere', '1');
      // Efterligner sessionen hos Microsoft, som fornyelse uden tryk bruger.
      localStorage.setItem('testSession', '1');
      localStorage.setItem('testType', localStorage.getItem('testNaesteType') || 'medarbejder');
      location.reload();
    },
    tjekLogin() {
      return tjek((o) => this.hentBevis(o));
    },
    async fornyStille(maaNavigere = () => true) {
      if (localStorage.getItem('testFornyIkke')) return;
      if (Date.now() - Number(localStorage.getItem('testFornyet') || 0) < FORNY_MS) return;
      // Efterligner tiden, før siden skifter til Microsoft.
      await new Promise((r) => setTimeout(r, Number(localStorage.getItem('testFornyVent') || 0)));
      if (!maaNavigere()) return;
      localStorage.setItem('testFornyet', String(Date.now()));
      localStorage.setItem('testFornyelser', String(Number(localStorage.getItem('testFornyelser') || 0) + 1));
      // Uden session svarer Microsoft uden login, og der fornyes ikke igen før næste login.
      if (!localStorage.getItem('testSession')) {
        localStorage.setItem('testFornyIkke', '1');
        return;
      }
      localStorage.setItem('testKonto', '1');
      location.reload();
      await new Promise(() => {});
    },
    // Som hos Microsoft: sessionen dér bliver, når man logger ud af appen.
    async logUd() {
      localStorage.removeItem('testKonto');
      localStorage.removeItem('testTidligere');
      localStorage.setItem('testFornyIkke', '1');
    },
  };
}
