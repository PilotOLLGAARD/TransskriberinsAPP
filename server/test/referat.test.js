'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lavReferat, lavPrompt } = require('../src/referat.js');
const { GeminiFejl } = require('../src/gemini.js');

const NOEGLE = 'hemmelig-testnoegle';
const FULDT = {
  titel: 'Møde om tag',
  type: 'moede',
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
  return lavReferat({ noegle: NOEGLE, model: 'gemini-3.8-flash', timeoutMs: 1000, hent, vent: async () => {}, tilfaeldig: () => 0.5, ...ekstra });
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
  const r = await lav(hent).lav({ ...INPUT, type: 'moede', signal: signal() });
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

test('400 fra referat-modellen er tjeneste-fejl, ikke en ødelagt optagelse', async () => {
  const { hent } = falskHent(() => svar(400, {}));
  await assert.rejects(lav(hent).lav({ ...INPUT, signal: signal() }), (e) => e.kode === 'tjeneste');
});

// Referat efter type

const skema = (k) => k.krop.response_format.schema;
const prompt = (k) => k.krop.input[0].text;

test('fast type: skemaet har kun typens felter og ingen type', async () => {
  const { hent, kald } = falskHent(() => modelSvar({ titel: 'x', opsummering: 'y', hovedpunkter: [], fejlOgMangler: [], maalOgMaengder: [], opgaver: [] }));
  await lav(hent).lav({ ...INPUT, type: 'byggenotat', signal: signal() });
  const felter = Object.keys(skema(kald[0]).properties).sort();
  assert.deepEqual(felter, ['fejlOgMangler', 'hovedpunkter', 'maalOgMaengder', 'opgaver', 'opsummering', 'titel']);
  assert.deepEqual([...skema(kald[0]).required].sort(), felter);
  assert.ok(prompt(kald[0]).includes('Byggenotat'));
  assert.ok(prompt(kald[0]).includes('maalOgMaengder'));
  assert.ok(!prompt(kald[0]).includes('beslutninger'));
});

test('automatisk: skemaet kræver en type blandt de fire', async () => {
  const { hent, kald } = falskHent();
  const r = await lav(hent).lav({ ...INPUT, type: 'automatisk', signal: signal() });
  const s = skema(kald[0]);
  assert.deepEqual(s.properties.type.enum, ['byggenotat', 'moede', 'paamindelse', 'andet']);
  assert.ok(s.required.includes('type'));
  for (const f of ['hovedpunkter', 'beslutninger', 'opgaver', 'fejlOgMangler', 'maalOgMaengder', 'huskeliste', 'aabneSpoergsmaal']) {
    assert.ok(s.properties[f], f);
  }
  assert.equal(r.type, 'moede');
});

test('uden type er det automatisk', async () => {
  const { hent, kald } = falskHent();
  await lav(hent).lav({ ...INPUT, signal: signal() });
  assert.ok(skema(kald[0]).properties.type);
});

test('automatisk: ugyldig type fra modellen bliver andet', async () => {
  const { hent } = falskHent(() => modelSvar({ ...FULDT, type: 'referat' }));
  const r = await lav(hent).lav({ ...INPUT, signal: signal() });
  assert.equal(r.type, 'andet');
  assert.deepEqual(r.hovedpunkter, ['Taget udskiftes']);
  assert.deepEqual(r.beslutninger, []);
  assert.deepEqual(r.opgaver, []);
});

test('fast type vinder over modellens type', async () => {
  const { hent } = falskHent(() => modelSvar({ ...FULDT, type: 'andet' }));
  const r = await lav(hent).lav({ ...INPUT, type: 'moede', signal: signal() });
  assert.equal(r.type, 'moede');
});

test('felter uden for typen tømmes, selvom modellen udfylder dem', async () => {
  const { hent } = falskHent(() => modelSvar({ ...FULDT, fejlOgMangler: ['Revne'], maalOgMaengder: ['12 m²'], huskeliste: ['søm'] }));
  const r = await lav(hent).lav({ ...INPUT, type: 'moede', signal: signal() });
  assert.deepEqual(r.fejlOgMangler, []);
  assert.deepEqual(r.maalOgMaengder, []);
  assert.deepEqual(r.huskeliste, []);
  assert.deepEqual(r.beslutninger, ['Tagpap vælges']);
});

test('byggenotat beholder mål og mængder præcis som sagt', async () => {
  const { hent } = falskHent(() => modelSvar({ titel: 'Gåtur', opsummering: 'o', hovedpunkter: [], fejlOgMangler: ['Revne i væg'], maalOgMaengder: ['12,5 m² gips', '40 stk. søm'], opgaver: [] }));
  const r = await lav(hent).lav({ ...INPUT, tekst: 'Vi skal bruge 12,5 kvadratmeter gips og fyrre søm. Der er en revne i væggen.', type: 'byggenotat', signal: signal() });
  assert.deepEqual(r.maalOgMaengder, ['12,5 m² gips', '40 stk. søm']);
  assert.deepEqual(r.fejlOgMangler, ['Revne i væg']);
});

test('referatet har altid alle felter', async () => {
  const { hent } = falskHent(() => modelSvar({ titel: 'P', opsummering: 'o', huskeliste: ['Ring til VVS'] }));
  const r = await lav(hent).lav({ ...INPUT, type: 'paamindelse', signal: signal() });
  assert.deepEqual(Object.keys(r).sort(), ['aabneSpoergsmaal', 'beslutninger', 'fejlOgMangler', 'hovedpunkter', 'huskeliste', 'kort', 'maalOgMaengder', 'opgaver', 'opsummering', 'renTekst', 'titel', 'type']);
  assert.deepEqual(r.huskeliste, ['Ring til VVS']);
  assert.deepEqual(r.hovedpunkter, []);
});

test('kort påmindelse får huskeliste og renTekst', async () => {
  const { hent, kald } = falskHent(() => modelSvar({ titel: 'VVS', renTekst: 'Husk at ringe til VVS.', huskeliste: ['Ring til VVS'] }));
  const r = await lav(hent).lav({ tekst: 'øh husk at ringe til vvs', titel: '', type: 'paamindelse', varighedSek: 10, signal: signal() });
  assert.deepEqual(Object.keys(skema(kald[0]).properties).sort(), ['huskeliste', 'renTekst', 'titel']);
  assert.equal(r.kort, true);
  assert.equal(r.type, 'paamindelse');
  assert.equal(r.renTekst, 'Husk at ringe til VVS.');
  assert.deepEqual(r.huskeliste, ['Ring til VVS']);
});

test('kort note af anden type er uændret: kun renTekst', async () => {
  const { hent, kald } = falskHent(() => modelSvar({ titel: 'Note', renTekst: 'Husk søm.', huskeliste: ['søm'] }));
  const r = await lav(hent).lav({ tekst: 'øh husk søm', titel: '', type: 'byggenotat', varighedSek: 10, signal: signal() });
  assert.deepEqual(Object.keys(skema(kald[0]).properties).sort(), ['renTekst', 'titel']);
  assert.equal(r.type, 'byggenotat');
  assert.deepEqual(r.huskeliste, []);
});

test('kort automatisk note: modellen vælger type, og kun påmindelse beholder huskeliste', async () => {
  const { hent, kald } = falskHent(() => modelSvar({ titel: 'VVS', type: 'paamindelse', renTekst: 'Ring til VVS.', huskeliste: ['Ring til VVS'] }));
  const r = await lav(hent).lav({ tekst: 'ring til vvs', titel: '', varighedSek: 8, signal: signal() });
  assert.ok(skema(kald[0]).properties.type);
  assert.ok(skema(kald[0]).properties.huskeliste);
  assert.equal(r.type, 'paamindelse');
  assert.deepEqual(r.huskeliste, ['Ring til VVS']);

  const anden = falskHent(() => modelSvar({ titel: 'N', type: 'andet', renTekst: 'Tekst.', huskeliste: ['x'] }));
  const r2 = await lav(anden.hent).lav({ tekst: 'tekst', titel: '', varighedSek: 8, signal: signal() });
  assert.equal(r2.type, 'andet');
  assert.deepEqual(r2.huskeliste, []);
});

test('prompten bevarer reglerne mod opfundne roller og Mig for alle typer med opgaver', () => {
  for (const type of ['moede', 'byggenotat', 'automatisk']) {
    const p = lavPrompt({ tekst: 'x', titel: '', kort: false, type });
    assert.ok(p.includes('Tilføj ikke roller'), type);
    assert.ok(p.includes('"Mig"'), type);
  }
});

// Tal må aldrig gættes

test('prompten kræver [uklart] ved usikre tal, kun det rettede tal og ingen omregning eller sum', () => {
  const p = lavPrompt({ tekst: 'x', titel: '', kort: false });
  for (const del of [
    'Er du i tvivl om et tal',
    'skriv "[uklart]" i stedet for tallet',
    'Retter taleren sig selv',
    'Omregn ikke enheder',
    'læg ikke tal sammen',
    'årstal',
    'ikke er et gyldigt dansk tal',
  ]) assert.ok(p.includes(del), del);
});

test('tal i referatet, der ikke står i transskriptionen, bliver [uklart]', async () => {
  const { hent } = falskHent(() => modelSvar({ ...FULDT, opsummering: 'Peter bestiller 12 ruller tagpap til fredag.', hovedpunkter: ['Taget er 89 år gammelt'] }));
  const r = await lav(hent).lav({ ...INPUT, signal: signal() });
  assert.equal(r.opsummering, 'Peter bestiller [uklart] ruller tagpap til fredag.');
  assert.deepEqual(r.hovedpunkter, ['Taget er [uklart] år gammelt']);
});

test('tal fra brugerens titel og fra transskriptionen bliver stående', async () => {
  const { hent } = falskHent(() => modelSvar({ ...FULDT, opsummering: 'Byggemøde 7: Peter bestiller 4 ruller.' }));
  const r = await lav(hent).lav({ ...INPUT, tekst: 'Peter bestiller fire ruller tagpap.', titel: 'Byggemøde 7', signal: signal() });
  assert.equal(r.titel, 'Byggemøde 7');
  assert.equal(r.opsummering, 'Byggemøde 7: Peter bestiller 4 ruller.');
});

test('en kort note kontrolleres også', async () => {
  const { hent } = falskHent(() => modelSvar({ titel: 'Ring til Kim', type: 'paamindelse', renTekst: 'Ring til Kim kl. 9.', huskeliste: ['Ring til Kim kl. 9'] }));
  const r = await lav(hent).lav({ tekst: 'Øh, husk at ringe til Kim klokken otte.', titel: '', varighedSek: 10, signal: signal() });
  assert.equal(r.renTekst, 'Ring til Kim kl. [uklart].');
  assert.deepEqual(r.huskeliste, ['Ring til Kim kl. [uklart]']);
});

// Genforsøg ved midlertidige fejl fra Google. Ingen rigtige pauser i tests.

function svarMedHeader(status, krop, headers) {
  return { ...svar(status, krop), headers: { get: (n) => headers[String(n).toLowerCase()] ?? null } };
}

function raekke(...liste) {
  let i = 0;
  return () => {
    const s = liste[Math.min(i++, liste.length - 1)];
    if (typeof s === 'function') return s();
    return s === 200 ? modelSvar(FULDT) : svar(s, {});
  };
}

function genLav(hent, ekstra = {}) {
  const ventet = [];
  const r = lav(hent, { timeoutMs: 50000, vent: async (ms) => { ventet.push(ms); }, tilfaeldig: () => 0.5, ...ekstra });
  return { r, ventet };
}

test('referatet genforsøges ved 429, 500 og 503 med 2, 4 og 8 s', async () => {
  const { hent, kald } = falskHent(raekke(429, 500, 503, 200));
  const { r, ventet } = genLav(hent);
  const ud = await r.lav({ ...INPUT, signal: signal() });
  assert.equal(ud.opsummering, FULDT.opsummering);
  assert.deepEqual(ventet, [2000, 4000, 8000]);
  assert.equal(kald.length, 4);
});

test('referatet opgiver efter 3 genforsøg med status og trin', async () => {
  const { hent, kald } = falskHent(raekke(503));
  const { r, ventet } = genLav(hent);
  await assert.rejects(r.lav({ ...INPUT, signal: signal() }), (e) => e.kode === 'tjeneste' && e.status === 503 && e.trin === 'referat');
  assert.equal(kald.length, 4);
  assert.equal(ventet.length, 3);
});

test('referatet medtager Googles fejlkode, men aldrig beskeden', async () => {
  const krop = { error: { status: 'RESOURCE_EXHAUSTED', message: 'HEMMELIG kvote' } };
  const { hent } = falskHent(() => svar(429, krop));
  const { r } = genLav(hent, { timeoutMs: 1000 });
  await assert.rejects(r.lav({ ...INPUT, signal: signal() }), (e) => {
    assert.equal(e.googleKode, 'RESOURCE_EXHAUSTED');
    assert.ok(!e.message.includes('HEMMELIG') && !JSON.stringify(e).includes('HEMMELIG'));
    return true;
  });
});

for (const status of [400, 401, 403, 404]) {
  test(`referatet genforsøges aldrig ved ${status}`, async () => {
    const { hent, kald } = falskHent(raekke(status, 200));
    const { r, ventet } = genLav(hent);
    await assert.rejects(r.lav({ ...INPUT, signal: signal() }), GeminiFejl);
    assert.equal(kald.length, 1);
    assert.deepEqual(ventet, []);
  });
}

test('referatet respekterer Retry-After', async () => {
  const { hent } = falskHent(raekke(() => svarMedHeader(429, {}, { 'retry-after': '9' }), 200));
  const { r, ventet } = genLav(hent);
  await r.lav({ ...INPUT, signal: signal() });
  assert.deepEqual(ventet, [9000]);
});

test('referatets genforsøg holder sig inden for 50 s', async () => {
  let tid = Date.UTC(2026, 10, 3, 12);
  const { hent, kald } = falskHent(raekke(() => svarMedHeader(503, {}, { 'retry-after': '30' })));
  const ventet = [];
  const r = lav(hent, { timeoutMs: 50000, nu: () => tid, vent: async (ms) => { ventet.push(ms); tid += ms; }, tilfaeldig: () => 0.5 });
  await assert.rejects(r.lav({ ...INPUT, signal: signal() }), (e) => e.status === 503);
  // 30 s når inden for 50 s. 30 s mere ville ikke.
  assert.deepEqual(ventet, [30000]);
  assert.equal(kald.length, 2);
});

test('netværksfejl ved referatet genforsøges', async () => {
  let n = 0;
  const { hent, kald } = falskHent(() => {
    if (n++ === 0) throw new TypeError('other side closed');
    return modelSvar(FULDT);
  });
  const { r, ventet } = genLav(hent);
  assert.equal((await r.lav({ ...INPUT, signal: signal() })).opsummering, FULDT.opsummering);
  assert.equal(kald.length, 2);
  assert.deepEqual(ventet, [2000]);
});

test('et afbrudt referat genforsøges ikke', async () => {
  const ctrl = new AbortController();
  let n = 0;
  const hent = (_u, v) => new Promise((_, afvis) => {
    n++;
    v.signal.addEventListener('abort', () => afvis(v.signal.reason));
    setTimeout(() => ctrl.abort(), 5);
  });
  const { r, ventet } = genLav(hent);
  await assert.rejects(r.lav({ ...INPUT, signal: ctrl.signal }), (e) => e.kode === 'tjeneste' && e.trin === 'referat');
  assert.equal(n, 1);
  assert.deepEqual(ventet, []);
});

test('referatets genforsøg logges kun med koder og tal', async () => {
  const { hent } = falskHent(raekke(503, 200));
  const logs = [];
  const { r } = genLav(hent, { log: (o) => logs.push(o) });
  await r.lav({ ...INPUT, signal: signal() });
  assert.deepEqual(logs, [{ haendelse: 'gemini-genforsoeg', hvor: 'referat', status: 503, forsoeg: 1, ventMs: 2000 }]);
});

test('prompten forbyder steder, lande, personer og firmaer, der ikke blev sagt', () => {
  const p = lavPrompt({ tekst: 'x', titel: '', kort: false });
  assert.ok(p.includes('Nævn ikke steder, lande, personer, firmaer eller årstal, der ikke står i transskriptionen, heller ikke når de virker indlysende.'));
});

// Emner og undertitler til bilaget

const AFSNIT = [
  { sek: 0, tekst: 'Velkommen til mødet om taget.' },
  { sek: 266, tekst: 'Taget er utæt ved kippen.' },
  { sek: 400, tekst: 'Facaden mangler fuger mod nord.' },
  { sek: 590, tekst: 'Vi ses fredag.' },
];
const LANG = { tekst: AFSNIT.map((a) => a.tekst).join('\n'), afsnit: AFSNIT, titel: '', varighedSek: 600 };
const EMNER = [{ tid: '00:00', undertitel: 'Tag og kip' }, { tid: '06:40', undertitel: 'Facade mod nord' }];

test('lang optagelse med tidspunkter: skemaet har emner, og prompten har [mm:ss] foran hvert afsnit', async () => {
  const { hent, kald } = falskHent(() => modelSvar({ ...FULDT, emner: EMNER }));
  await lav(hent).lav({ ...LANG, signal: signal() });
  const skema = kald[0].krop.response_format.schema;
  assert.deepEqual(skema.properties.emner.items.properties, { tid: { type: 'string' }, undertitel: { type: 'string' } });
  assert.ok(skema.required.includes('emner'));
  const prompt = kald[0].krop.input[0].text;
  assert.ok(prompt.includes('[00:00] Velkommen til mødet om taget.\n[04:26] Taget er utæt ved kippen.\n[06:40] Facaden'));
});

test('prompten om emner: 2-20 emner, tid som i transskriptionen, undertitel kun om det sagte', () => {
  const p = lavPrompt({ tekst: '[00:00] Hej', titel: '', kort: false, emner: true });
  for (const del of ['emner', 'mindst 2', 'højst 20', '3-5 minutter', 'præcis som det står', '2-6 ord', 'faktisk bliver sagt', 'ingen vurdering']) {
    assert.ok(p.includes(del), del);
  }
  assert.ok(p.includes('Skriv ikke tidspunkterne i referatet'));
  assert.ok(!lavPrompt({ tekst: 'Hej', titel: '', kort: false }).includes('undertitel'));
});

test('emner knyttes til afsnittene og kommer med i referatet', async () => {
  const { hent } = falskHent(() => modelSvar({ ...FULDT, emner: [...EMNER, { tid: '06:40', undertitel: 'Dublet' }] }));
  const r = await lav(hent).lav({ ...LANG, signal: signal() });
  assert.deepEqual(r.emner, [{ fra: 0, undertitel: 'Tag og kip' }, { fra: 2, undertitel: 'Facade mod nord' }]);
});

test('undertitler går gennem kontrollen af tal', async () => {
  const { hent } = falskHent(() => modelSvar({ ...FULDT, emner: [{ tid: '00:00', undertitel: 'Tag med 12 huller' }] }));
  const r = await lav(hent).lav({ ...LANG, signal: signal() });
  assert.deepEqual(r.emner, [{ fra: 0, undertitel: 'Tag med [uklart] huller' }]);
});

test('tidspunkterne tæller aldrig som sagte tal', async () => {
  const { hent } = falskHent(() => modelSvar({
    ...FULDT, opsummering: 'Ved 04:26 blev taget nævnt.', hovedpunkter: ['Punkt 26 om taget', 'Det skete 40 sekunder inde'], emner: [{ tid: '04:26', undertitel: 'Taget efter 266 sekunder' }],
  }));
  const r = await lav(hent).lav({ ...LANG, signal: signal() });
  assert.equal(r.opsummering, 'Ved [uklart] blev taget nævnt.');
  assert.deepEqual(r.hovedpunkter, ['Punkt [uklart] om taget', 'Det skete [uklart] sekunder inde']);
  assert.deepEqual(r.emner, [{ fra: 0, undertitel: 'Taget efter [uklart] sekunder' }]);
});

test('kort optagelse under 120 s: ingen emner i skemaet og ingen tidspunkter i prompten', async () => {
  const { hent, kald } = falskHent();
  const r = await lav(hent).lav({ ...LANG, varighedSek: 110, signal: signal() });
  assert.ok(!kald[0].krop.response_format.schema.properties.emner);
  assert.ok(!kald[0].krop.input[0].text.includes('[04:26]'));
  assert.equal(r.emner, undefined);
});

test('ukendt varighed: emner kun ved mindst ca. 300 ord', async () => {
  const kort = falskHent();
  await lav(kort.hent).lav({ ...LANG, varighedSek: null, signal: signal() });
  assert.ok(!kort.kald[0].krop.response_format.schema.properties.emner);
  const mange = AFSNIT.map((a) => ({ ...a, tekst: `${a.tekst} ${'ord '.repeat(80)}`.trim() }));
  const lang = falskHent(() => modelSvar({ ...FULDT, emner: EMNER }));
  await lav(lang.hent).lav({ tekst: mange.map((a) => a.tekst).join('\n'), afsnit: mange, titel: '', varighedSek: null, signal: signal() });
  assert.ok(lang.kald[0].krop.response_format.schema.properties.emner);
});

test('uden tidspunkter (Transcribe eller flere dele): ingen emner', async () => {
  const { hent, kald } = falskHent();
  const r = await lav(hent).lav({ ...INPUT, varighedSek: 900, afsnit: [{ sek: null, tekst: INPUT.tekst }], signal: signal() });
  assert.ok(!kald[0].krop.response_format.schema.properties.emner);
  assert.equal(r.emner, undefined);
  const uden = falskHent();
  await lav(uden.hent).lav({ ...INPUT, varighedSek: 900, signal: signal() });
  assert.ok(!uden.kald[0].krop.response_format.schema.properties.emner);
});

test('modellen svarer uden emner: tom liste', async () => {
  const { hent } = falskHent();
  const r = await lav(hent).lav({ ...LANG, signal: signal() });
  assert.deepEqual(r.emner, []);
});
