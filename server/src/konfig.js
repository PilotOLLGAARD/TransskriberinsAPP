'use strict';

const STANDARD_MAX_BYTES = 157286400; // 150 MiB
const STANDARD_TIMEOUT_MS = 840000; // Under Cloud Runs grænse på 900 s

function tal(vaerdi, standard) {
  const n = Number(vaerdi);
  return Number.isFinite(n) && n > 0 ? n : standard;
}

/**
 * Læser serverens indstillinger. Mangler en påkrævet værdi, gives null,
 * og handleren afviser så alle kald.
 */
function hentKonfig(env) {
  const noegle = String(env.GEMINI_API_KEY || '').trim();
  const tenantId = String(env.ENTRA_TENANT_ID || '').trim();
  const clientId = String(env.ENTRA_CLIENT_ID || '').trim();
  const tilladtOprindelse = String(env.TILLADT_OPRINDELSE || '').trim();
  if (!noegle || !tenantId || !clientId || !tilladtOprindelse) return null;

  return {
    noegle,
    tenantId,
    clientId,
    tilladtOprindelse,
    model: env.GEMINI_MODEL || 'gemini-3.5-transcribe',
    referatModel: env.REFERAT_MODEL || 'gemini-3.8-flash',
    sprog: env.SPROG || 'da-DK',
    tilstand: env.TRANSSKRIPTION_TILSTAND === 'verbatim' ? 'verbatim' : 'smart',
    maxBytes: tal(env.MAX_LYD_BYTES, STANDARD_MAX_BYTES),
    timeoutMs: tal(env.GEMINI_TIMEOUT_MS, STANDARD_TIMEOUT_MS),
  };
}

module.exports = { hentKonfig };
