'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hentKonfig } = require('../src/konfig.js');

const FULD = {
  GEMINI_API_KEY: 'n',
  ENTRA_TENANT_ID: 't',
  ENTRA_CLIENT_ID: 'c',
  TILLADT_OPRINDELSE: 'https://x.github.io',
};

for (const navn of Object.keys(FULD)) {
  test(`hentKonfig giver null, når ${navn} mangler`, () => {
    assert.equal(hentKonfig({ ...FULD, [navn]: '' }), null);
  });
}

test('hentKonfig bruger standardværdier', () => {
  const k = hentKonfig(FULD);
  assert.equal(k.model, 'gemini-3.5-transcribe');
  assert.equal(k.sprog, 'da-DK');
  // Smart springer replikker over (testbænken 4. nov. 2026: samme fire sætninger manglede hver gang). Verbatim tager alt med.
  assert.equal(k.tilstand, 'verbatim');
  // 500 MiB: uploadede filer (fx WAV) kan være store. Lyden strømmes og gemmes aldrig i hukommelsen.
  assert.equal(k.maxBytes, 524288000);
  assert.equal(k.timeoutMs, 840000);
});

test('ukendt tilstand bliver verbatim, og smart kun når den vælges', () => {
  assert.equal(hentKonfig({ ...FULD, TRANSSKRIPTION_TILSTAND: 'x' }).tilstand, 'verbatim');
  assert.equal(hentKonfig({ ...FULD, TRANSSKRIPTION_TILSTAND: 'smart' }).tilstand, 'smart');
});

test('referatets model har standard og kan ændres', () => {
  assert.equal(hentKonfig(FULD).referatModel, 'gemini-3.8-flash');
  assert.equal(hentKonfig({ ...FULD, REFERAT_MODEL: 'gemini-3.5-flash-lite' }).referatModel, 'gemini-3.5-flash-lite');
});

test('Flash-model og grænsen for Transcribe har standard og kan ændres', () => {
  const k = hentKonfig(FULD);
  assert.equal(k.flashModel, 'gemini-3.8-flash');
  // 10.000 tokens/min på Tier 1 og ca. 25 tokens/s lyd: højst ca. 6 min. 40 s til Transcribe.
  assert.equal(k.transcribeMaksSek, 400);
  const a = hentKonfig({ ...FULD, FLASH_MODEL: 'gemini-x-flash', TRANSCRIBE_MAKS_SEK: '1200' });
  assert.equal(a.flashModel, 'gemini-x-flash');
  assert.equal(a.transcribeMaksSek, 1200);
  assert.equal(hentKonfig({ ...FULD, TRANSCRIBE_MAKS_SEK: 'x' }).transcribeMaksSek, 400);
});
