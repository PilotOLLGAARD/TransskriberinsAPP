'use strict';

/**
 * Genforsøg ved midlertidige fejl fra Google: 429 (fx Tier 1's udgiftsgrænse pr. 10 minutter),
 * 500, 502, 503, 504 og netværksfejl. Andre 4xx genforsøges aldrig.
 *
 * Bruges kun til kald, der er sikre at sende igen, fordi kroppen er en færdig tekst:
 * upload-start, transskription af en allerede uploadet fil og referatet.
 * Selve lyden genforsøges ikke: den strømmes direkte fra telefonen og kan ikke spoles tilbage,
 * og den må ikke gemmes i hukommelsen (op til 150 MiB). Fejler den, beholder telefonen lyden.
 */

const { setTimeout: sov } = require('node:timers/promises');

const MIDLERTIDIGE = new Set([429, 500, 502, 503, 504]);
const GENFORSOEG = 3; // Højst 3 genforsøg, altså 4 kald i alt.
const GRUND_MS = 2000; // 2, 4 og 8 s, spredt tilfældigt mellem halvdelen og halvanden gang.

/** Retry-After i sekunder eller som dato. null, hvis den mangler eller ikke kan læses. */
function laesRetryAfter(vaerdi, nuMs) {
  if (vaerdi === null || vaerdi === undefined) return null;
  const s = String(vaerdi).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const tid = Date.parse(s);
  return Number.isFinite(tid) ? Math.max(0, tid - nuMs) : null;
}

const fejlKroppe = new WeakMap();
const GOOGLE_KODE = /^[A-Z][A-Z_]{1,39}$/;

/** "37s" eller "1.5s" fra google.rpc.RetryInfo. */
function laesVarighed(v) {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(v || '').trim());
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

/**
 * Læser Googles fejlsvar én gang: den faste fejlkode (fx RESOURCE_EXHAUSTED) og evt. retryDelay.
 * Beskeden læses aldrig videre, da den kan indeholde detaljer fra kaldet. Kun en kode i Googles
 * faste form (store bogstaver og _) godtages, så intet andet kan slippe ud i loggen.
 */
function laesGoogleFejl(svar) {
  if (!svar || typeof svar !== 'object') return Promise.resolve({});
  if (!fejlKroppe.has(svar)) {
    fejlKroppe.set(svar, (async () => {
      try {
        const fejl = (await svar.json())?.error;
        if (!fejl || typeof fejl !== 'object') return {};
        const ud = {};
        if (typeof fejl.status === 'string' && GOOGLE_KODE.test(fejl.status)) ud.googleKode = fejl.status;
        for (const d of Array.isArray(fejl.details) ? fejl.details : []) {
          const ms = d && String(d['@type'] || '').endsWith('google.rpc.RetryInfo') ? laesVarighed(d.retryDelay) : null;
          if (ms !== null) ud.retryMs = ms;
        }
        return ud;
      } catch {
        return {};
      }
    })());
  }
  return fejlKroppe.get(svar);
}

function standardVent(ms, signal) {
  return sov(ms, undefined, { signal });
}

/**
 * Kalder kald() og genforsøger ved midlertidige fejl, så længe ventetiden slutter før frist (ms).
 * Giver det sidste svar, også en fejlstatus, så kalderen selv oversætter den. En netværksfejl
 * kastes videre, når der ikke genforsøges mere. Et afbrudt signal stopper alt med det samme.
 * vedGenforsoeg får kun tal: forsøgets nummer, status (0 ved netværksfejl) og ventetiden.
 */
async function medGenforsoeg(kald, {
  signal, frist, nu = Date.now, vent = standardVent, tilfaeldig = Math.random, vedGenforsoeg = () => {},
}) {
  for (let forsoeg = 1; ; forsoeg++) {
    let svar = null;
    let fejl = null;
    try {
      svar = await kald();
    } catch (e) {
      fejl = e;
    }
    const opgiv = () => {
      if (fejl) throw fejl;
      return svar;
    };
    if (svar && !MIDLERTIDIGE.has(svar.status)) return svar;
    if ((signal && signal.aborted) || forsoeg > GENFORSOEG) return opgiv();

    const stigende = Math.round(GRUND_MS * 2 ** (forsoeg - 1) * (0.5 + tilfaeldig()));
    const google = svar ? await laesGoogleFejl(svar) : {};
    const header = svar ? laesRetryAfter(svar.headers?.get?.('retry-after'), nu()) : null;
    // Aldrig kortere end Google beder om (header eller RetryInfo), og aldrig ud over tidsgrænsen.
    const ventMs = Math.max(stigende, header ?? 0, google.retryMs ?? 0);
    if (nu() + ventMs >= frist) return opgiv();

    const info = { forsoeg, status: svar ? svar.status : 0, ventMs };
    if (google.googleKode) info.googleKode = google.googleKode;
    vedGenforsoeg(info);
    await vent(ventMs, signal);
  }
}

module.exports = { medGenforsoeg, laesRetryAfter, laesGoogleFejl, MIDLERTIDIGE };
