'use strict';

const STANDARD_MAX_BYTES = 524288000; // 500 MiB. Lyden strømmes til Google og gemmes aldrig i hukommelsen.
const STANDARD_TIMEOUT_MS = 840000; // Under Cloud Runs grænse på 900 s
// Transcribe på Tier 1: 10.000 tokens/min og ca. 25 tokens/s lyd. Længere lyd går direkte til Flash.
const STANDARD_TRANSCRIBE_MAKS_SEK = 400;

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
    // Transskriberer lange optagelser og tager over, når Transcribe svarer 429.
    flashModel: env.FLASH_MODEL || 'gemini-3.8-flash',
    transcribeMaksSek: tal(env.TRANSCRIBE_MAKS_SEK, STANDARD_TRANSCRIBE_MAKS_SEK),
    // Flash som førstevalg: lavere ordfejl og taber ikke sætninger (testbænken 6. nov. 2026). Transcribe er reserve.
    foerst: env.TRANSSKRIPTION_FOERST === 'transcribe' ? 'transcribe' : 'flash',
    sprog: env.SPROG || 'da-DK',
    // Verbatim som standard: smart springer replikker over (testbænken, 4. nov. 2026).
    tilstand: env.TRANSSKRIPTION_TILSTAND === 'smart' ? 'smart' : 'verbatim',
    maxBytes: tal(env.MAX_LYD_BYTES, STANDARD_MAX_BYTES),
    timeoutMs: tal(env.GEMINI_TIMEOUT_MS, STANDARD_TIMEOUT_MS),
  };
}

module.exports = { hentKonfig };
