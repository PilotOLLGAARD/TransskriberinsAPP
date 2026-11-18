'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { kanonisk, wer, talNoejagtighed, nyeEgennavne, pris, overgang } = require('../testbaenk/maal.js');

test('kanonisk: små bogstaver, ingen tegnsætning, og tal skrevet ens', () => {
  assert.deepEqual(kanonisk('Revnen er 60 cm, ikke tres!'), ['revnen', 'er', '60', 'cm', 'ikke', '60']);
  assert.deepEqual(kanonisk('Det koster 1.500 kr. eller femten hundrede.'), ['det', 'koster', '1500', 'kr', 'eller', '1500']);
  assert.deepEqual(kanonisk('Bjælken er 4,2 meter.'), ['bjælken', 'er', '4.2', 'meter']);
  assert.deepEqual(kanonisk('to hundrede og halvtreds'), ['250']);
});

test('wer tæller erstatninger, udeladelser og indsættelser mod facit', () => {
  assert.deepEqual(wer('a b c d', 'a b c d'), { fejl: 0, ord: 4, rate: 0 });
  assert.deepEqual(wer('a b c d', 'a x c'), { fejl: 2, ord: 4, rate: 0.5 });
  assert.deepEqual(wer('a b', 'a b c d'), { fejl: 2, ord: 2, rate: 1 });
  assert.equal(wer('Revnen er tres centimeter.', 'revnen er 60 centimeter').rate, 0);
});

test('talNoejagtighed: korrekte, [uklart] og forkerte tal i referatet mod facit', () => {
  const facit = 'Hullet skal være tre meter, nej fire meter bredt, og bjælken er 4,2 meter. Mødet er halv otte.';
  const referat = {
    titel: 'Hul i væg',
    opsummering: 'Hullet er 4 meter bredt. Bjælken er 4,2 meter.',
    hovedpunkter: ['Møde kl. 7.30', 'Bjælke [uklart] m', 'Hullet er 3 meter', 'Pris 900 kr.'],
    opgaver: [{ hvad: 'Bestil fem bjælker', hvornaar: 'fredag' }],
  };
  const r = talNoejagtighed(referat, facit, [3]);
  assert.equal(r.korrekte, 3); // 4, 4,2, 7.30
  assert.equal(r.uklart, 1);
  assert.equal(r.forkerte, 3); // 3 (rettet), 900 og fem
  assert.deepEqual(r.detaljer.map((d) => d.tal).sort(), ['3', '900', 'fem']);
});

test('nyeEgennavne finder navne i referatet, som ikke blev sagt', () => {
  const facit = 'Mette og Jonas holdt møde om Skovbrynet.';
  const referat = { opsummering: 'Møde mellem Mette, Jonas og Hansen om Skovbrynet. Der blev aftalt nyt tag.', opgaver: [{ hvem: 'Peter', hvad: 'Ring' }] };
  assert.deepEqual(nyeEgennavne(referat, facit).sort(), ['Hansen', 'Peter']);
});

test('pris: transskription pr. minut og referat pr. token', () => {
  // 60 s lyd: 1500 tokens ind (2,00 USD pr. mio.) og 175 tokens ud (12,00 USD pr. mio.) = 0,003 + 0,0021.
  assert.equal(pris({ sek: 60, tekstTokens: 175 }).toFixed(4), '0.0051');
  // Referat: 1000 ind (0,75) og 500 ud (3,75) = 0,00075 + 0,001875.
  assert.equal(pris({ sek: 0, tekstTokens: 0, referat: { ind: 1000, ud: 500 } }).toFixed(6), '0.002625');
});

// Overgange mellem bidder: ord tabt eller gentaget, hvor to bidder er sat sammen

const ord = (n, fra = 0) => Array.from({ length: n }, (_, i) => `ord${fra + i}`).join(' ');

test('overgang: en ren overgang har intet tabt og intet gentaget', () => {
  const facit = ord(300);
  assert.deepEqual(overgang(facit, facit, 150), { fundet: true, tabt: 0, gentaget: 0 });
});

test('overgang: fem ord gentaget ved grænsen tælles', () => {
  const facit = ord(300);
  const hyp = `${ord(150)} ${ord(5, 145)} ${ord(150, 150)}`;
  assert.deepEqual(overgang(facit, hyp, 150), { fundet: true, tabt: 0, gentaget: 5 });
});

test('overgang: fire ord tabt ved grænsen tælles', () => {
  const facit = ord(300);
  const hyp = `${ord(150)} ${ord(146, 154)}`;
  assert.deepEqual(overgang(facit, hyp, 150), { fundet: true, tabt: 4, gentaget: 0 });
});

test('overgang: fejl langt fra grænsen tælles ikke med', () => {
  const facit = ord(300);
  const hyp = `${ord(20)} ekstra ${ord(280, 20)}`;
  assert.deepEqual(overgang(facit, hyp, 150), { fundet: true, tabt: 0, gentaget: 0 });
});

test('overgang: findes stedet ikke i facit, siges det', () => {
  assert.equal(overgang(ord(300), ord(300, 1000), 150).fundet, false);
});
