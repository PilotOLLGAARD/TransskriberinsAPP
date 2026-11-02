'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lavReferat, lavPrompt } = require('../src/referat.js');
const { GeminiFejl } = require('../src/gemini.js');

const NOEGLE = 'hemmelig-testnoegle';
const FULDT = {
  titel: 'Møde om tag',
  opsummering: 'Der blev aftalt nyt tag.',
  hovedpunkter: ['Taget udskiftes'],
  beslutninger: ['Tagpap vælges'],
  opgaver: [{ hvem: 'Peter', hvad: 'bestille tagpap', hvornaar: 'fredag' }],
  fejlOgMangler: [],
  aabneSpoergsmaal: [],
};

function svar(status, krop) {
  return { ok: status >= 200 && status < 300, status, json: async () => krop };
}

function modelSvar(objekt, status = 'completed') {
  return svar(200, { status, steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(objekt) }] }] });
}

function falskHent(svarFn = () => modelSvar(FULDT)) {
  const kald = [];
  const hent = async (url, valg) => {
    kald.push({ url: String(url), valg, krop: JSON.parse(valg.body) });
    return svarFn(valg);
  };
  return { hent, kald };
}

function lav(hent, ekstra = {}) {
  return lavReferat({ noegle: NOEGLE, model: 'gemini-3.8-flash', timeoutMs: 1000, hent, ...ekstra });
}

const INPUT = { tekst: 'Vi skal have nyt tag. Peter bestiller tagpap til fredag.', titel: '', varighedSek: 120 };
const signal = () => new AbortController().signal;

test('sender store false og JSON-skema', async () => {
  const { hent, kald } = falskHent();
  await lav(hent).lav({ ...INPUT, signal: signal() });
  const k = kald[0];
  assert.match(k.url, /\/v1beta\/interactions$/);
  assert.equal(k.krop.store, false);
  assert.equal(k.krop.model, 'gemini-3.8-flash');
  assert.equal(k.krop.response_format.mime_type, 'application/json');
  assert.ok(k.krop.response_format.schema.properties.hovedpunkter);
  assert.equal(k.krop.generation_config.thinking_level, 'low');
  assert.equal(k.valg.headers['x-goog-api-key'], NOEGLE);
  assert.ok(!k.url.includes(NOEGLE));
});

test('prompten indeholder reglerne og transskriptionen', () => {
  const p = lavPrompt({ tekst: 'Hej med dig', titel: '', kort: false });
  for (const del of ['Intet må opfindes', '[uklart]', 'præcist', 'egne vurderinger', 'dansk', 'Hej med dig']) {
    assert.ok(p.includes(del), del);
  }
});

test('kort tilstand under 30 sekunder', async () => {
  const { hent, kald } = falskHent(() => modelSvar({ titel: 'Note', renTekst: 'Husk søm.' }));
  const r = await lav(hent).lav({ tekst: 'øh husk søm', titel: '', varighedSek: 10, signal: signal() });
  assert.ok(kald[0].krop.response_format.schema.properties.renTekst);
  assert.ok(!kald[0].krop.response_format.schema.properties.hovedpunkter);
  assert.equal(r.kort, true);
  assert.equal(r.renTekst, 'Husk søm.');
  assert.deepEqual(r.hovedpunkter, []);
});

test('ukendt varighed giver fuldt referat', async () => {
  const { hent } = falskHent();
  const r = await lav(hent).lav({ ...INPUT, varighedSek: null, signal: signal() });
  assert.equal(r.kort, false);
});

test('brugerens titel vinder', async () => {
  const { hent, kald } = falskHent();
  const r = await lav(hent).lav({ ...INPUT, titel: '  Byggenotat E/F Nørrehus ', signal: signal() });
  assert.equal(r.titel, 'Byggenotat E/F Nørrehus');
  assert.ok(kald[0].krop.input[0].text.includes('Byggenotat E/F Nørrehus'));
});

test('AI-titel bruges ved tom titel', async () => {
  const { hent } = falskHent();
  assert.equal((await lav(hent).lav({ ...INPUT, signal: signal() })).titel, 'Møde om tag');
});

test('ufuldstændigt referat udfyldes', async () => {
  const { hent } = falskHent(() => modelSvar({ opsummering: 42, hovedpunkter: ['a', '', 7, ' b '], opgaver: [{ hvad: 'x' }, { hvem: 'y' }, 'z'] }));
  const r = await lav(hent).lav({ ...INPUT, signal: signal() });
  assert.equal(r.titel, 'Optagelse');
  assert.equal(r.opsummering, '');
  assert.deepEqual(r.hovedpunkter, ['a', 'b']);
  assert.deepEqual(r.opgaver, [{ hvad: 'x' }]);
  assert.deepEqual(r.beslutninger, []);
  assert.deepEqual(r.fejlOgMangler, []);
  assert.deepEqual(r.aabneSpoergsmaal, []);
});

test('fuldt referat bevares', async () => {
  const { hent } = falskHent();
  const r = await lav(hent).lav({ ...INPUT, signal: signal() });
  assert.deepEqual(r.opgaver, [{ hvem: 'Peter', hvad: 'bestille tagpap', hvornaar: 'fredag' }]);
  assert.deepEqual(r.beslutninger, ['Tagpap vælges']);
  assert.equal(r.kort, false);
});

test('status incomplete er fejl', async () => {
  const { hent } = falskHent(() => modelSvar(FULDT, 'incomplete'));
  await assert.rejects(lav(hent).lav({ ...INPUT, signal: signal() }), (e) => e instanceof GeminiFejl && e.kode === 'tjeneste');
});

test('ugyldig JSON er tjeneste-fejl', async () => {
  const { hent } = falskHent(() => svar(200, { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ikke json' }] }] }));
  await assert.rejects(lav(hent).lav({ ...INPUT, signal: signal() }), (e) => e.kode === 'tjeneste');
});

for (const status of [429, 500, 503]) {
  test(`${status} giver tjeneste`, async () => {
    const { hent } = falskHent(() => svar(status, {}));
    await assert.rejects(lav(hent).lav({ ...INPUT, signal: signal() }), (e) => e.kode === 'tjeneste');
  });
}

test('afbrydelse giver tjeneste-fejl', async () => {
  const ctrl = new AbortController();
  const hent = (_u, v) => new Promise((_, afvis) => {
    v.signal.addEventListener('abort', () => afvis(v.signal.reason));
    setTimeout(() => ctrl.abort(), 5);
  });
  await assert.rejects(lav(hent).lav({ ...INPUT, signal: ctrl.signal }), (e) => e.kode === 'tjeneste');
});

test('nøglen indgår aldrig i en fejlbesked', async () => {
  const hent = async () => { throw new Error(`nede ${NOEGLE}`); };
  await assert.rejects(lav(hent).lav({ ...INPUT, signal: signal() }), (e) => {
    assert.ok(!e.message.includes(NOEGLE));
    return e.kode === 'tjeneste';
  });
});
