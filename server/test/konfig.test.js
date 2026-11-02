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
  assert.equal(k.tilstand, 'smart');
  assert.equal(k.maxBytes, 157286400);
  assert.equal(k.timeoutMs, 840000);
});

test('ukendt tilstand bliver smart', () => {
  assert.equal(hentKonfig({ ...FULD, TRANSSKRIPTION_TILSTAND: 'x' }).tilstand, 'smart');
  assert.equal(hentKonfig({ ...FULD, TRANSSKRIPTION_TILSTAND: 'verbatim' }).tilstand, 'verbatim');
});

test('referatets model har standard og kan ændres', () => {
  assert.equal(hentKonfig(FULD).referatModel, 'gemini-3.8-flash');
  assert.equal(hentKonfig({ ...FULD, REFERAT_MODEL: 'gemini-3.5-flash-lite' }).referatModel, 'gemini-3.5-flash-lite');
});
