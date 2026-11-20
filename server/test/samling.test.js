'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fjernOverlap, samlDele, hulTekst, HUL_TEKST, AFBRUDT_TEKST } = require('../src/samling.js');
const { samletTekst } = require('../src/afsnit.js');

const tael = (tekst, s) => tekst.split(s).length - 1;
const alt = (r) => samletTekst([...r.forrige, ...r.naeste]);

// Overlap mellem to bidder (globale tider)

test('fjernOverlap: en fælles ordrække står kun én gang', () => {
  const forrige = [
    { sek: 1740, tekst: 'Så kigger vi på tidsplanen.' },
    { sek: 1775, tekst: 'Vi støber dækket på onsdag, og så tager vi' },
  ];
  const naeste = [
    { sek: 1771, tekst: 'dækket på onsdag, og så tager vi resten af stilladset ned.' },
    { sek: 1790, tekst: 'Er der spørgsmål?' },
  ];
  const r = fjernOverlap(forrige, naeste, { naesteStartSek: 1770, overlapSek: 30 });
  const tekst = alt(r);
  assert.equal(tael(tekst, 'dækket på onsdag, og så tager vi'), 1);
  assert.match(tekst, /Vi støber dækket på onsdag, og så tager vi resten af stilladset ned\./);
  assert.match(tekst, /Så kigger vi på tidsplanen\./);
  assert.match(tekst, /Er der spørgsmål\?/);
});

test('fjernOverlap: uden fælles ord klippes ved overlappets midte efter tid', () => {
  const forrige = [{ sek: 1760, tekst: 'Første.' }, { sek: 1785, tekst: 'Før midten.' }, { sek: 1795, tekst: 'Efter midten A.' }];
  const naeste = [{ sek: 1780, tekst: 'Før midten B.' }, { sek: 1790, tekst: 'Efter midten.' }, { sek: 1810, tekst: 'Sidste.' }];
  const r = fjernOverlap(forrige, naeste, { naesteStartSek: 1770, overlapSek: 30 });
  assert.deepEqual(r.forrige.map((a) => a.tekst), ['Første.', 'Før midten.']);
  assert.deepEqual(r.naeste.map((a) => a.tekst), ['Efter midten.', 'Sidste.']);
});

test('fjernOverlap: ved en gentaget sætning vælges rækken nær overlappets midte', () => {
  const s = 'vi tager den op på næste møde';
  const forrige = [
    { sek: 1741, tekst: `Det er aftalt, ${s}.` },
    { sek: 1784, tekst: `Og prisen, ${s}. Godt.` },
  ];
  const naeste = [
    { sek: 1782, tekst: `prisen, ${s}. Godt.` },
    { sek: 1795, tekst: 'Så er vi færdige.' },
  ];
  const r = fjernOverlap(forrige, naeste, { naesteStartSek: 1770, overlapSek: 30 });
  const tekst = alt(r);
  assert.equal(tael(tekst, s), 2, 'den tidlige forekomst bevares, overlappet står én gang');
  assert.match(tekst, /Det er aftalt/);
  assert.match(tekst, /Så er vi færdige/);
});

test('fjernOverlap: uden tider og uden fælles ord beholdes alt', () => {
  const forrige = [{ sek: null, tekst: 'Alt fra den første bid.' }];
  const naeste = [{ sek: null, tekst: 'Helt andre ord her.' }];
  const r = fjernOverlap(forrige, naeste, { naesteStartSek: 1770, overlapSek: 30 });
  assert.deepEqual(r, { forrige, naeste });
});

test('fjernOverlap: uden tider bruges en fælles ordrække', () => {
  const forrige = [{ sek: null, tekst: 'Start. Nu måler vi højden på væggen til to meter og ti' }];
  const naeste = [{ sek: null, tekst: 'højden på væggen til to meter og ti centimeter. Slut.' }];
  const tekst = alt(fjernOverlap(forrige, naeste, { naesteStartSek: 1770, overlapSek: 30 }));
  assert.equal(tekst, 'Start. Nu måler vi højden på væggen til to meter og ti centimeter. Slut.');
});

test('fjernOverlap: et ord delt over grænsen står én gang', () => {
  const forrige = [{ sek: 1780, tekst: 'Og så hælder vi betonen i formen nu og venter til i morgen be' }];
  const naeste = [{ sek: 1771, tekst: 'tonen i formen nu og venter til i morgen tidlig.' }, { sek: 1800, tekst: 'Næste punkt.' }];
  const tekst = alt(fjernOverlap(forrige, naeste, { naesteStartSek: 1770, overlapSek: 30 }));
  assert.equal(tael(tekst, 'formen nu og venter til i morgen'), 1);
  assert.match(tekst, /tidlig\./);
  assert.match(tekst, /Og så hælder vi/);
});

// Samling af dele og bidder

const bid = (startSek, afsnit, ekstra = {}) => ({ startSek, overlapSek: startSek ? 30 : 0, varighedSek: 1800, afsnit, tekst: samletTekst(afsnit), ...ekstra });

test('samlDele: bidernes tider lægges til deres start', () => {
  const r = samlDele([{ bidder: [
    bid(0, [{ sek: 0, tekst: 'A.' }, { sek: 100, tekst: 'B.' }]),
    bid(1770, [{ sek: 40, tekst: 'C.' }]),
  ] }]);
  assert.deepEqual(r.afsnit, [{ sek: 0, tekst: 'A.' }, { sek: 100, tekst: 'B.' }, { sek: 1810, tekst: 'C.' }]);
  assert.equal(r.tekst, 'A.\nB.\nC.');
  assert.deepEqual(r.dele, [{ fra: 0, startSek: 0, overskrift: null }]);
  assert.equal(r.huller, 0);
});

test('samlDele: dele efter hinanden får forskydning, og en afbrudt del starter med markøren', () => {
  const r = samlDele([
    { varighedSek: 600, bidder: [bid(0, [{ sek: 5, tekst: 'Første del.' }], { varighedSek: 600 })] },
    { afbrudt: true, varighedSek: 300, bidder: [bid(0, [{ sek: 10, tekst: 'Anden del.' }], { varighedSek: 300 })] },
  ]);
  assert.deepEqual(r.afsnit, [{ sek: 5, tekst: 'Første del.' }, { sek: 600, tekst: AFBRUDT_TEKST }, { sek: 610, tekst: 'Anden del.' }]);
  assert.deepEqual(r.dele.map((d) => d.startSek), [0, 600]);
  assert.equal(r.varighedSek, 900);
});

test('samlDele: filer får overskriften Del n: filnavn', () => {
  const r = samlDele([
    { filnavn: 'Møde_del1.m4a', varighedSek: 60, bidder: [bid(0, [{ sek: 0, tekst: 'En.' }], { varighedSek: 60 })] },
    { filnavn: 'Møde_del2.m4a', varighedSek: 60, bidder: [bid(0, [{ sek: 1, tekst: 'To.' }], { varighedSek: 60 })] },
  ]);
  assert.deepEqual(r.dele, [
    { fra: 0, startSek: 0, overskrift: 'Del 1: Møde_del1.m4a' },
    { fra: 1, startSek: 60, overskrift: 'Del 2: Møde_del2.m4a' },
  ]);
});

test('samlDele: en bid, der mangler, bliver til hul-teksten', () => {
  const r = samlDele([{ bidder: [
    bid(0, [{ sek: 0, tekst: 'Før.' }]),
    { startSek: 1770, overlapSek: 30, varighedSek: 1800, tekst: '', mangler: true },
    bid(3570, [{ sek: 60, tekst: 'Efter.' }]),
  ] }]);
  assert.deepEqual(r.afsnit.map((a) => a.tekst), ['Før.', HUL_TEKST, 'Efter.']);
  assert.equal(r.afsnit[1].sek, 1770);
  assert.equal(r.huller, 1);
  assert.deepEqual(r.mangler, ['29:30-59:30']);
});

test('hulTekst: tidsrum i minutter og over en time med timer', () => {
  assert.equal(hulTekst(1800, 3600), '[Dette afsnit (30:00-1:00:00) kunne ikke transskriberes]');
  assert.equal(hulTekst(3600, 5400), '[Dette afsnit (1:00:00-1:30:00) kunne ikke transskriberes]');
  assert.equal(hulTekst(600, null), '[Dette afsnit (fra 10:00) kunne ikke transskriberes]');
});

test('samlDele: en tom bid med længde godtages aldrig som stilhed, men markeres', () => {
  const r = samlDele([{ bidder: [
    bid(0, [{ sek: 0, tekst: 'Før.' }]),
    { startSek: 1770, overlapSek: 30, varighedSek: 1830, tekst: '' },
    { startSek: 3570, overlapSek: 30, varighedSek: 600, tekst: '  ', afsnit: [] },
  ] }]);
  assert.deepEqual(r.afsnit.map((a) => a.tekst), ['Før.', HUL_TEKST, HUL_TEKST]);
  assert.equal(r.huller, 2);
  assert.deepEqual(r.mangler, ['29:30-1:00:00', '59:30-1:09:30']);
});

test('samlDele: en hel del uden klip, der mangler, får delens tidsrum', () => {
  const r = samlDele([
    { varighedSek: 600, bidder: [{ startSek: 0, overlapSek: 0, varighedSek: 0, tekst: 'Første fil.' }] },
    { filnavn: 'b.m4a', varighedSek: 1200, bidder: [{ startSek: 0, overlapSek: 0, varighedSek: 0, tekst: '' }] },
  ]);
  assert.deepEqual(r.afsnit.map((a) => a.tekst), ['Første fil.', HUL_TEKST]);
  assert.deepEqual(r.mangler, ['10:00-30:00']);
});

test('samlDele: en del uden lyd (længde 0) er ikke et hul', () => {
  const r = samlDele([
    { varighedSek: 600, bidder: [{ startSek: 0, overlapSek: 0, varighedSek: 0, tekst: 'Lyd.' }] },
    { afbrudt: true, varighedSek: 0, bidder: [{ startSek: 0, overlapSek: 0, varighedSek: 0, tekst: '' }] },
  ]);
  assert.equal(r.huller, 0);
  assert.deepEqual(r.mangler, []);
});

test('samlDele: en bid uden tider (Transcribe) placeres ved sin start', () => {
  const r = samlDele([{ bidder: [
    bid(0, [{ sek: 0, tekst: 'Med tid.' }]),
    { startSek: 1770, overlapSek: 30, varighedSek: 1800, tekst: 'Uden tid.' },
  ] }]);
  assert.deepEqual(r.afsnit.at(-1), { sek: 1770, tekst: 'Uden tid.' });
});

test('HUL_TEKST og AFBRUDT_TEKST har ingen cifre', () => {
  assert.doesNotMatch(HUL_TEKST + AFBRUDT_TEKST, /\d/);
});

// Rettelser fra gennemgangen: ingen ord må tabes ved overgangen

test('fjernOverlap ved midten beholder det afsnit i næste bid, der dækker slutningen af den forrige', () => {
  const forrige = [{ sek: 1760, tekst: 'A et.' }, { sek: 1790, tekst: 'A to.' }];
  const naeste = [{ sek: 1775, tekst: 'B et går forbi slutningen af A.' }, { sek: 1805, tekst: 'B to fra 1805.' }];
  const r = fjernOverlap(forrige, naeste, { naesteStartSek: 1770, overlapSek: 30 });
  assert.deepEqual(r.naeste.map((a) => a.tekst), ['B et går forbi slutningen af A.', 'B to fra 1805.']);
});

test('samlDele: en bid uden tider (Transcribe) før en bid med tider bruger stadig fælles ord', () => {
  const r = samlDele([{ bidder: [
    { startSek: 0, overlapSek: 0, varighedSek: 1800, tekst: 'Start af mødet. Til sidst taler vi om tagrenderne på nordsiden af huset' },
    bid(1770, [{ sek: 2, tekst: 'om tagrenderne på nordsiden af huset og ord efter bid A slut.' }, { sek: 40, tekst: 'Mere.' }]),
  ] }]);
  assert.match(r.tekst, /ord efter bid A slut/);
  assert.equal(r.tekst.split('tagrenderne på nordsiden').length - 1, 1);
  assert.equal(r.afsnit[0].sek, 0, 'teksten uden tider står ved bidens start');
});

// Bidder uden tider (Transcribe) skriver overlappet lidt forskelligt: en omtrentlig ordrække fjerner det alligevel

test('fjernOverlap uden tider: et overlap, der er skrevet lidt forskelligt, står kun én gang', () => {
  const forrige = [{ sek: null, tekst: 'Start af mødet. Vi skal bestille de nye vinduer til den tredje sal inden fredag, og så tager vi taget bagefter med tømreren' }];
  const naeste = [{ sek: null, tekst: 'skal bestille nye vinduer til tredje sal inden på fredag så tager vi taget efter med tømreren. Næste punkt er stilladset.' }];
  const r = fjernOverlap(forrige, naeste, { naesteStartSek: 1770, overlapSek: 30 });
  const tekst = samletTekst([...r.forrige, ...r.naeste]);
  assert.equal(tekst.split('vinduer').length - 1, 1, tekst);
  assert.match(tekst, /^Start af mødet\. Vi/);
  assert.match(tekst, /Næste punkt er stilladset\.$/);
});

test('fjernOverlap uden tider: helt forskellige tekster beholdes stadig begge', () => {
  const forrige = [{ sek: null, tekst: 'Vi taler om betonen og armeringen i kælderen i dag.' }];
  const naeste = [{ sek: null, tekst: 'Tagrenderne skal skiftes på nordsiden af bygningen snart.' }];
  const r = fjernOverlap(forrige, naeste, { naesteStartSek: 1770, overlapSek: 30 });
  assert.deepEqual(r, { forrige, naeste });
});

test('fjernOverlap: et langt afsnit, der starter før overlappet og går ind i det, bruges i søgningen', () => {
  const forrige = [{ sek: 0, tekst: `${'fyld '.repeat(50)}og så tager vi stilladset ned på fredag efter frokost` }];
  const naeste = [{ sek: null, tekst: 'tager vi stilladset ned på fredag efter frokost. Næste punkt.' }];
  const r = fjernOverlap(forrige, naeste, { naesteStartSek: 1770, overlapSek: 30 });
  const tekst = samletTekst([...r.forrige, ...r.naeste]);
  assert.equal(tekst.split('stilladset').length - 1, 1, tekst);
  assert.match(tekst, /Næste punkt\.$/);
});
