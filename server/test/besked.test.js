'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lavEmne, lavHtml } = require('../src/besked.js');

const TOM = {
  kort: false, opsummering: '', hovedpunkter: [], beslutninger: [], opgaver: [], fejlOgMangler: [],
  maalOgMaengder: [], huskeliste: [], aabneSpoergsmaal: [], renTekst: '',
};

test('emnet har type, titel og kort dansk dato', () => {
  assert.equal(lavEmne({ type: 'moede', titel: 'Tagrenovering', tidspunkt: Date.UTC(2026, 10, 2, 9) }), 'Møde: Tagrenovering – 2. nov. 2026');
  assert.equal(lavEmne({ type: 'byggenotat', titel: 'Gåtur', tidspunkt: Date.UTC(2026, 4, 12, 9) }), 'Byggenotat: Gåtur – 12. maj 2026');
});

test('emnet bruger dansk dato efter midnat', () => {
  assert.equal(lavEmne({ type: 'paamindelse', titel: 'Ring til VVS', tidspunkt: Date.UTC(2026, 4, 31, 23, 30) }), 'Påmindelse: Ring til VVS – 1. jun. 2026');
});

test('ukendt type giver Referat i emnet', () => {
  assert.equal(lavEmne({ type: 'automatisk', titel: 'X', tidspunkt: Date.UTC(2026, 10, 2, 9) }), 'Referat: X – 2. nov. 2026');
  assert.equal(lavEmne({ titel: 'X', tidspunkt: Date.UTC(2026, 10, 2, 9) }), 'Referat: X – 2. nov. 2026');
});

test('html har titel, opsummering, hovedpunkter og henvisning til Word-dokumentet', () => {
  const html = lavHtml({ titel: 'Møde om tag', referat: { ...TOM, type: 'moede', opsummering: 'Nyt tag.', hovedpunkter: ['Tagpap'], beslutninger: ['B'] } });
  assert.ok(html.includes('<h2 style="margin:0 0 8px">Møde om tag</h2>'));
  assert.ok(html.includes('<p>Nyt tag.</p>'));
  assert.ok(html.includes('<li>Tagpap</li>'));
  assert.ok(!html.includes('<li>B</li>'));
  assert.ok(html.includes('Hele referatet og den fulde transskription ligger i det vedhæftede Word-dokument.'));
  assert.ok(!html.includes('PDF'));
});

test('påmindelse viser huskelisten', () => {
  const html = lavHtml({ titel: 'P', referat: { ...TOM, type: 'paamindelse', opsummering: 'o', huskeliste: ['Ring til VVS'] } });
  assert.ok(html.includes('Huskeliste'));
  assert.ok(html.includes('<li>Ring til VVS</li>'));
  assert.ok(!html.includes('Hovedpunkter'));
});

test('kort note viser den rensede tekst, og en kort påmindelse også huskelisten', () => {
  const kort = lavHtml({ titel: 'N', referat: { ...TOM, type: 'andet', kort: true, renTekst: 'Husk søm.' } });
  assert.ok(kort.includes('white-space:pre-wrap">Husk søm.</p>'));
  const paa = lavHtml({ titel: 'N', referat: { ...TOM, type: 'paamindelse', kort: true, renTekst: 'Ring.', huskeliste: ['Ring til VVS'] } });
  assert.ok(paa.includes('<li>Ring til VVS</li>'));
  assert.ok(paa.includes('Ring.'));
});

test('html escaper titel og punkter', () => {
  const html = lavHtml({ titel: '<script>"x"</script>', referat: { ...TOM, type: 'andet', opsummering: 'a & b', hovedpunkter: ["<img src=x onerror='y'>"] } });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;&quot;x&quot;'));
  assert.ok(html.includes('a &amp; b'));
});

test('uden Word-dokument (fejlet på serveren) henviser mailen til PDF\'en, som så sendes i stedet', () => {
  const html = lavHtml({ titel: 'Møde om tag', referat: { ...TOM, type: 'moede', opsummering: 'Nyt tag.' }, medWord: false });
  assert.ok(html.includes('Hele referatet og den fulde transskription ligger i den vedhæftede PDF.'));
  assert.ok(!html.includes('Word'));
});
