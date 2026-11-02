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

export function lavLogin({ msal, entra, redirectUri, hukommelse = globalThis.localStorage }) {
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
      if (konto()) hukommelse.setItem(HAR_VAERET_LOGGET_IND, '1');
    },

    harKonto: () => Boolean(konto()),
    harVaeretLoggetInd: () => Boolean(hukommelse.getItem(HAR_VAERET_LOGGET_IND)),
    brugerMail: () => konto()?.username ?? '',

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
      localStorage.setItem('testType', localStorage.getItem('testNaesteType') || 'medarbejder');
      location.reload();
    },
  };
}
