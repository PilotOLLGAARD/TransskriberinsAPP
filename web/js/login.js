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
// Fornyelse uden tryk forsøges højst så ofte, så appen aldrig sender brugeren i ring.
const FORNY_MS = 10 * 60 * 1000;

/** Om man kan sende lige nu: 'ja', 'nej' (login kræves) eller 'ukendt' (intet net). */
async function tjek(hentBevis) {
  try {
    await hentBevis('api');
    return 'ja';
  } catch (e) {
    return e?.type === 'net' ? 'ukendt' : 'nej';
  }
}

export function lavLogin({ msal, entra, redirectUri, hukommelse = globalThis.localStorage, nu = Date.now }) {
  const apiScope = `api://${entra.clientId}/access_as_user`;
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
          authority: `https://login.microsoftonline.com/${entra.tenantId}`,
          redirectUri,
          navigateToLoginRequestUrl: false,
        },
        cache: { cacheLocation: 'localStorage' },
      });
      await app.initialize();
      try {
        // Efter et nyt login er det den konto, der skal bruges, også hvis en gammel ligger i lageret.
        const svar = await app.handleRedirectPromise();
        if (svar?.account) app.setActiveAccount(svar.account);
      } catch {
        // Et mislykket login må ikke forhindre appen i at starte. Optagelser skal kunne nås.
      }
      const k = konto();
      if (k) {
        hukommelse.setItem(HAR_VAERET_LOGGET_IND, '1');
        if (k.username) hukommelse.setItem(SIDSTE_BRUGER, k.username);
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
      return app.loginRedirect({ scopes: [apiScope], extraScopesToConsent: [MAIL_SCOPE] });
    },

    tjekLogin() {
      return tjek((o) => this.hentBevis(o));
    },

    /**
     * Fornyer login uden tryk: et hurtigt skift til Microsoft og tilbage (prompt none).
     * Lykkes det ikke (ingen session hos Microsoft), kommer appen tilbage uden login.
     * Højst én gang pr. FORNY_MS. Giver false, hvis der ikke blev forsøgt.
     */
    async fornyStille() {
      if (nu() - Number(hukommelse.getItem(SIDST_FORNYET) || 0) < FORNY_MS) return false;
      hukommelse.setItem(SIDST_FORNYET, String(nu()));
      try {
        await app.acquireTokenRedirect({ scopes: [apiScope], prompt: 'none', loginHint: hukommelse.getItem(SIDSTE_BRUGER) || undefined });
        return true;
      } catch {
        return false;
      }
    },

    /** Logger kun ud af appen. Optagelser på telefonen bliver liggende. */
    async logUd() {
      await app.clearCache();
      hukommelse.removeItem(HAR_VAERET_LOGGET_IND);
      hukommelse.removeItem(SIDSTE_BRUGER);
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
    async fornyStille() {
      if (Date.now() - Number(localStorage.getItem('testFornyet') || 0) < FORNY_MS) return false;
      localStorage.setItem('testFornyet', String(Date.now()));
      localStorage.setItem('testFornyelser', String(Number(localStorage.getItem('testFornyelser') || 0) + 1));
      if (!localStorage.getItem('testSession')) return false;
      localStorage.setItem('testKonto', '1');
      location.reload();
      return true;
    },
    async logUd() {
      localStorage.removeItem('testKonto');
      localStorage.removeItem('testTidligere');
      localStorage.removeItem('testSession');
    },
  };
}
