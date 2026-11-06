'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { kanonisk, wer, talNoejagtighed, nyeEgennavne, pris } = require('../testbaenk/maal.js');

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
