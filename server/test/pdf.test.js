'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lavPdf, filnavn, lavAfsnit, formaterVarighed, formaterTidspunkt } = require('../src/pdf.js');

// 2. november 2026 kl. 13.05 dansk tid
const TIDSPUNKT = Date.UTC(2026, 10, 2, 12, 5);

const REFERAT = {
  titel: 'Møde omkring SAS Lounge',
  kort: false,
  opsummering: 'Gennemgang af loftet i loungen.',
  hovedpunkter: ['Loftet hænger 12 mm for lavt', 'Æbletræet ved indgangen bevares'],
  beslutninger: [],
  opgaver: [{ hvem: 'Søren', hvad: 'bestille 40 m² gips', hvornaar: 'fredag' }, { hvad: 'måle op igen' }],
  fejlOgMangler: ['Revne i væg ved akse B'],
  aabneSpoergsmaal: [],
  renTekst: '',
};

const indhold = (buf) => buf.toString('latin1');
const sider = (buf) => (indhold(buf).match(/\/Type \/Page[^s]/g) || []).length;

test('starter med %PDF og slutter korrekt', async () => {
  const pdf = await lavPdf({ titel: REFERAT.titel, tidspunkt: TIDSPUNKT, varighedSek: 252, referat: REFERAT, tekst: 'Fuld tekst.' });
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(indhold(pdf), /%%EOF\s*$/);
});

test('indlejrer Lato', async () => {
  const pdf = await lavPdf({ titel: 'Æøå', tidspunkt: TIDSPUNKT, varighedSek: 60, referat: REFERAT, tekst: 'æøå ÆØÅ' });
  assert.ok(indhold(pdf).includes('/FontFile2'));
  assert.ok(indhold(pdf).includes('Lato-Regular'));
  assert.ok(indhold(pdf).includes('Lato-Bold'));
});

test('udelader tomme afsnit', () => {
  const navne = lavAfsnit(REFERAT).map((a) => a.overskrift);
  assert.deepEqual(navne, ['Hovedpunkter', 'Opgaver og aftaler', 'Fejl og mangler']);
});

test('opgaver skrives med hvem, hvad og hvornår', () => {
  const opgaver = lavAfsnit(REFERAT).find((a) => a.overskrift === 'Opgaver og aftaler').punkter;
  assert.deepEqual(opgaver, ['Søren: bestille 40 m² gips (frist: fredag)', 'måle op igen']);
});

test('kort note har kun noten', () => {
  const kort = { ...REFERAT, kort: true, renTekst: 'Husk søm.', hovedpunkter: [], opgaver: [], fejlOgMangler: [] };
  assert.deepEqual(lavAfsnit(kort), [{ overskrift: 'Note', tekst: 'Husk søm.' }]);
});

test('bilag med transskription giver en ekstra side', async () => {
  const med = await lavPdf({ titel: 'A', tidspunkt: TIDSPUNKT, varighedSek: 60, referat: REFERAT, tekst: 'Kort tekst.' });
  assert.equal(sider(med), 2);
});

test('lang tekst giver flere sider', async () => {
  const tekst = 'Vi gennemgik facaden og målte op. '.repeat(1800);
  const pdf = await lavPdf({ titel: 'Lang', tidspunkt: TIDSPUNKT, varighedSek: 3500, referat: REFERAT, tekst });
  assert.ok(sider(pdf) >= 4, `kun ${sider(pdf)} sider`);
});

test('titel med specialtegn', async () => {
  const pdf = await lavPdf({ titel: 'Byggenotat E/F Nørrehus 🏗️ "tag"', tidspunkt: TIDSPUNKT, varighedSek: null, referat: REFERAT, tekst: 'x' });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('filnavn fjerner ulovlige tegn', () => {
  assert.equal(filnavn({ titel: 'E/F Nørrehus', tidspunkt: TIDSPUNKT }), '2026-11-02 E-F Nørrehus.pdf');
  assert.equal(filnavn({ titel: ' a:b*c?"d<e>f|g\\h ', tidspunkt: TIDSPUNKT }), '2026-11-02 abcdefg-h.pdf');
  assert.equal(filnavn({ titel: '', tidspunkt: TIDSPUNKT }), '2026-11-02 Optagelse.pdf');
  assert.ok(filnavn({ titel: 'x'.repeat(300), tidspunkt: TIDSPUNKT }).length <= 115);
});

test('dato i dansk tid', () => {
  assert.equal(formaterTidspunkt(TIDSPUNKT), '2. november 2026 kl. 13.05');
  assert.equal(filnavn({ titel: 'Nat', tidspunkt: Date.UTC(2026, 10, 2, 23, 30) }), '2026-11-03 Nat.pdf');
});

test('varighed', () => {
  assert.equal(formaterVarighed(252), '4 min 12 sek');
  assert.equal(formaterVarighed(45), '45 sek');
  assert.equal(formaterVarighed(120), '2 min');
  assert.equal(formaterVarighed(null), null);
});
