// Intet her er hemmeligt: ID'erne er offentlige, og adgangen afgøres på serveren.

export const LOKAL = ['localhost', '127.0.0.1'].includes(globalThis.location?.hostname);

// Sættes til Cloud Run-adressen ved udrulning. Skal også stå i Content-Security-Policy i index.html.
const SERVER_ADRESSE = 'https://SERVER-ADRESSE-SAETTES-VED-UDRULNING.invalid';

export const API_URL = LOKAL ? '/transskriber' : `${SERVER_ADRESSE}/transskriber`;
export const REFERAT_URL = LOKAL ? '/referat' : `${SERVER_ADRESSE}/referat`;
// Lange optagelser sendes i bidder: 30 min. med 30 s overlap, kun når en del er over 35 min.
// Blokerer Googles filter en bid, prøves den i småbidder på 10 min. Browsertestene kan sætte mindre værdier.
export const BIDDER = {
  bidMs: 30 * 60 * 1000, overlapMs: 30 * 1000, delFraMs: 35 * 60 * 1000, smaaBidMs: 10 * 60 * 1000,
  ...(globalThis.__BIDDER__ ?? {}),
};

export const GRAPH_URL = LOKAL ? '/test/graph/v1.0' : 'https://graph.microsoft.com/v1.0';

export const ENTRA = {
  tenantId: '0aefac4e-4313-4168-9865-27d269eaeff8',
  clientId: '792bac2e-d895-4c24-9a58-7466eb8d03a3',
};
