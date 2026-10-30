// Login med Microsoft Entra ID via MSAL. Beslutningen om adgang tages på serveren.
// Redirect, ikke popup. Login startes kun, når brugeren trykker, så det aldrig afbryder en optagelse.

const MAIL_SCOPE = 'https://graph.microsoft.com/Mail.Send';
const NET_KODER = new Set(['no_network_connectivity', 'post_request_failed', 'endpoints_resolution_error', 'network_error']);

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

export function lavLogin({ msal, entra, redirectUri }) {
  const apiScope = `api://${entra.clientId}/access_as_user`;
  let app;

  const konto = () => app.getAllAccounts()[0] ?? null;

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
        await app.handleRedirectPromise();
      } catch {
        // Et mislykket login må ikke forhindre appen i at starte. Optagelser skal kunne nås.
      }
    },

    harKonto: () => Boolean(konto()),
    brugerMail: () => konto()?.username ?? '',

    /** @param {'api'|'mail'} omraade */
    async hentBevis(omraade) {
      const account = konto();
      if (!account) throw new LoginKraevet();
      try {
        const { accessToken } = await app.acquireTokenSilent({
          scopes: [omraade === 'mail' ? MAIL_SCOPE : apiScope],
          account,
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
      localStorage.setItem('testType', localStorage.getItem('testNaesteType') || 'medarbejder');
      location.reload();
    },
  };
}
