'use strict';

/**
 * Tjekker det adgangsbevis (access token), appen får fra Microsoft Entra ID.
 *
 * Fejler lukket: alt andet end et gyldigt bevis fra en godkendt medarbejder afvises.
 * Mailadressen indgår ikke, da Microsoft fraråder at bruge den til at afgøre adgang.
 * Microsoft bruger samme signaturnøgler til mange tenants, så udsteder og tenant
 * skal altid tjekkes, selvom signaturen er gyldig.
 */

const NOEGLE_LEVETID_MS = 60 * 60 * 1000;
const MIN_MS_MELLEM_HENTNING = 5 * 60 * 1000; // Falske beviser må ikke kunne hamre løs på Microsoft.
const UR_SKEW_S = 60;
const MAX_BEVIS_LAENGDE = 16 * 1024;
const SCOPE = 'access_as_user';
const ROLLE = 'Transskribering.Bruger';

function afvist(status, grund) {
  return { ok: false, status, grund };
}

function afkodDel(del) {
  return JSON.parse(Buffer.from(del, 'base64url').toString('utf8'));
}

function lavNoegleHenter(tenantId, hent, nu) {
  const url = `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;
  let noegler = new Map();
  let hentet = -Infinity;

  async function opdater() {
    if (nu() - hentet < MIN_MS_MELLEM_HENTNING) return;
    hentet = nu();
    const svar = await hent(url, { signal: AbortSignal.timeout(5000) });
    if (!svar.ok) throw new Error(`JWKS status ${svar.status}`);
    const { keys } = await svar.json();
    const nye = new Map();
    for (const jwk of keys) {
      if (jwk.kty !== 'RSA' || !jwk.kid) continue;
      nye.set(jwk.kid, await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ));
    }
    noegler = nye;
  }

  return async function noegle(kid) {
    if (!noegler.has(kid) || nu() - hentet > NOEGLE_LEVETID_MS) {
      try {
        await opdater();
      } catch {
        // Gamle nøgler må gerne bruges videre, hvis Microsoft ikke svarer. Ukendt nøgle afvises.
      }
    }
    return noegler.get(kid) || null;
  };
}

/**
 * @param {{tenantId: string, clientId: string, hent?: typeof fetch, nu?: () => number}} valg
 * @returns {(autorisation: string|undefined) => Promise<{ok: true} | {ok: false, status: 401|403, grund: string}>}
 */
function lavAdgangsTjek({ tenantId, clientId, hent = (...a) => fetch(...a), nu = Date.now }) {
  const tid = String(tenantId || '').trim().toLowerCase();
  const app = String(clientId || '').trim().toLowerCase();
  if (!tid || !app) return async () => afvist(401, 'mangler-konfiguration');

  const noegle = lavNoegleHenter(tid, hent, nu);
  const udsteder = `https://login.microsoftonline.com/${tid}/v2.0`;

  return async function tjek(autorisation) {
    try {
      const m = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(autorisation || '');
      if (!m || m[0].length > MAX_BEVIS_LAENGDE) return afvist(401, 'ugyldigt-bevis');
      const [, hoved, indhold, signatur] = m;

      // Algoritmen er låst. "none" og HS256 afvises her, før noget andet læses.
      const h = afkodDel(hoved);
      if (h.alg !== 'RS256' || typeof h.kid !== 'string') return afvist(401, 'ugyldigt-bevis');

      const k = await noegle(h.kid);
      if (!k) return afvist(401, 'ukendt-noegle');
      const gyldig = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        k,
        Buffer.from(signatur, 'base64url'),
        Buffer.from(`${hoved}.${indhold}`),
      );
      if (!gyldig) return afvist(401, 'ugyldig-signatur');

      const c = afkodDel(indhold);
      const sekunder = nu() / 1000;
      if (!Number.isFinite(c.exp) || c.exp < sekunder - UR_SKEW_S) return afvist(401, 'udloebet');
      if (Number.isFinite(c.nbf) && c.nbf > sekunder + UR_SKEW_S) return afvist(401, 'ikke-gyldigt-endnu');

      if (c.iss !== udsteder || String(c.tid).toLowerCase() !== tid) return afvist(403, 'forkert-tenant');
      if (String(c.aud).toLowerCase() !== app) return afvist(403, 'forkert-app');
      // Kun beviser på vegne af en bruger. App-til-app-beviser har ikke scp.
      if (!String(c.scp || '').split(' ').includes(SCOPE)) return afvist(403, 'mangler-scope');
      if (!Array.isArray(c.roles) || !c.roles.includes(ROLLE)) return afvist(403, 'mangler-rolle');
      if (c.acct !== 0) return afvist(403, 'ikke-medarbejder');

      return { ok: true };
    } catch {
      return afvist(401, 'ugyldigt-bevis');
    }
  };
}

module.exports = { lavAdgangsTjek };
