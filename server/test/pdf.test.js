'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lavPdf, filnavn, lavAfsnit, lavMeta, formaterVarighed, formaterTidspunkt } = require('../src/pdf.js');

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

test('filnavn deler aldrig en emoji', () => {
  const navn = filnavn({ titel: `${'a'.repeat(99)}🏗️`, tidspunkt: TIDSPUNKT });
  assert.equal(navn, navn.toWellFormed());
});

// Afsnit efter type

const TOM = {
  kort: false, opsummering: 'o', hovedpunkter: [], beslutninger: [], opgaver: [], fejlOgMangler: [],
  maalOgMaengder: [], huskeliste: [], aabneSpoergsmaal: [], renTekst: '',
};

test('byggenotat viser Mål og mængder, ikke Beslutninger', () => {
  const r = { ...TOM, type: 'byggenotat', hovedpunkter: ['h'], beslutninger: ['b'], fejlOgMangler: ['f'], maalOgMaengder: ['12,5 m² gips'], opgaver: [{ hvad: 'o' }] };
  assert.deepEqual(lavAfsnit(r).map((a) => a.overskrift), ['Hovedpunkter', 'Fejl og mangler', 'Mål og mængder', 'Opgaver og aftaler']);
  assert.deepEqual(lavAfsnit(r).find((a) => a.overskrift === 'Mål og mængder').punkter, ['12,5 m² gips']);
});

test('møde viser beslutninger, opgaver og åbne spørgsmål i rækkefølge', () => {
  const r = { ...TOM, type: 'moede', hovedpunkter: ['h'], beslutninger: ['b'], opgaver: [{ hvad: 'o' }], aabneSpoergsmaal: ['?'], fejlOgMangler: ['f'] };
  assert.deepEqual(lavAfsnit(r).map((a) => a.overskrift), ['Hovedpunkter', 'Beslutninger', 'Opgaver og aftaler', 'Åbne spørgsmål']);
});

test('påmindelse viser kun Huskeliste', () => {
  const r = { ...TOM, type: 'paamindelse', huskeliste: ['Ring til VVS'], hovedpunkter: ['h'] };
  assert.deepEqual(lavAfsnit(r), [{ overskrift: 'Huskeliste', punkter: ['Ring til VVS'] }]);
});

test('kort påmindelse viser Huskeliste og Note', () => {
  const r = { ...TOM, type: 'paamindelse', kort: true, renTekst: 'Husk at ringe til VVS.', huskeliste: ['Ring til VVS'] };
  assert.deepEqual(lavAfsnit(r), [{ overskrift: 'Huskeliste', punkter: ['Ring til VVS'] }, { overskrift: 'Note', tekst: 'Husk at ringe til VVS.' }]);
});

test('kort påmindelse uden huskeliste viser kun Note', () => {
  const r = { ...TOM, type: 'paamindelse', kort: true, renTekst: 'Hej.' };
  assert.deepEqual(lavAfsnit(r), [{ overskrift: 'Note', tekst: 'Hej.' }]);
});

test('typen står først i linjen under titlen', () => {
  assert.equal(lavMeta({ type: 'moede', tidspunkt: TIDSPUNKT, varighedSek: 252 }), 'Møde  ·  2. november 2026 kl. 13.05  ·  Varighed 4 min 12 sek');
  assert.equal(lavMeta({ type: 'paamindelse', tidspunkt: TIDSPUNKT, varighedSek: null }), 'Påmindelse  ·  2. november 2026 kl. 13.05');
  assert.equal(lavMeta({ tidspunkt: TIDSPUNKT, varighedSek: 60 }), '2. november 2026 kl. 13.05  ·  Varighed 1 min');
  assert.equal(lavMeta({ type: 'automatisk', tidspunkt: TIDSPUNKT, varighedSek: 60 }), '2. november 2026 kl. 13.05  ·  Varighed 1 min');
});

test('PDF med type og huskeliste laves uden fejl', async () => {
  const r = { ...TOM, type: 'paamindelse', huskeliste: ['Ring til VVS', 'Køb 40 stk. søm'] };
  const pdf = await lavPdf({ titel: 'Påmindelse', tidspunkt: TIDSPUNKT, varighedSek: 40, referat: r, tekst: 'Husk æøå.' });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(sider(pdf), 2);
});

// Bilaget delt i emner med tidspunkter

const PDFDocument = require('pdfkit');
const { laesAfsnit, samletTekst, knytEmner, lavBilag, formaterTid } = require('../src/afsnit.js');

const GRAA = '#5b6470';
const BLAA_DYB = '#0e5aa3';
const BLAEK = '#282828';

/** Laver PDF'en og noterer hvert stykke tekst: indhold, placering, side, skrift og farve. */
async function tegnet(valg) {
  const { text, addPage } = PDFDocument.prototype;
  const ud = [];
  PDFDocument.prototype.addPage = function (...a) {
    this.sideNr = (this.sideNr ?? -1) + 1;
    return addPage.apply(this, a);
  };
  PDFDocument.prototype.text = function (s, x, y, ...rest) {
    const post = {
      s: String(s), x: typeof x === 'number' ? x : this.x, y: typeof y === 'number' ? y : this.y, side: this.sideNr,
      font: this._font.name, farve: this._fillColor?.[0], str: this._fontSize, bund: this.page.maxY(),
    };
    const r = text.call(this, s, x, y, ...rest);
    post.slut = this.y;
    post.slutSide = this.sideNr;
    ud.push(post);
    return r;
  };
  try {
    await lavPdf({ titel: 'Møde', tidspunkt: TIDSPUNKT, varighedSek: 4000, referat: REFERAT, tekst: 'x', ...valg });
  } finally {
    Object.assign(PDFDocument.prototype, { text, addPage });
  }
  return ud.slice(ud.findIndex((p) => p.s === 'Bilag: Fuld transskription') + 2);
}

const ordAf = (t) => t.split(/\s+/).filter(Boolean);
const saetning = (i, n) => Array.from({ length: n }, (_, k) => `ord${i}x${k}`).join(' ');

function langOptagelse(antalEmner = 3, ordPrAfsnit = 30) {
  const linjer = Array.from({ length: antalEmner * 4 }, (_, i) => `[${formaterTid(995 + i * 75)}] ${saetning(i, ordPrAfsnit)}.`);
  const afsnit = laesAfsnit(linjer.join('\n'));
  const emner = knytEmner(afsnit, Array.from({ length: antalEmner }, (_, e) => ({ tid: formaterTid(afsnit[e * 4].sek), undertitel: `Emne ${e}` })));
  return { afsnit, tekst: samletTekst(afsnit), bilag: lavBilag(afsnit, emner) };
}

test('bilag med emner: grå tid til venstre, fed knapblå undertitel ved siden af, teksten under i samme kolonne', async () => {
  const { tekst, bilag } = langOptagelse();
  const p = await tegnet({ tekst, bilag });
  const tid = p.find((x) => x.s === '16:35');
  const undertitel = p.find((x) => x.s === 'Emne 0');
  const forste = p.find((x) => x.s.startsWith('ord0x0'));
  assert.ok(tid && undertitel && forste);
  assert.equal(tid.x, 56);
  assert.equal(tid.farve, GRAA);
  assert.equal(tid.font, 'Lato-Regular');
  assert.equal(undertitel.font, 'Lato-Bold');
  assert.equal(undertitel.farve, BLAA_DYB);
  assert.ok(undertitel.x >= tid.x + 40, 'undertitlen står til højre for tiden');
  assert.ok(Math.abs(undertitel.y - tid.y) < 3, 'tid og undertitel på samme linje');
  assert.equal(forste.x, undertitel.x);
  assert.equal(forste.farve, BLAEK);
  assert.ok(forste.y > undertitel.y);
});

test('tider over en time vises som t:mm:ss', async () => {
  const p = await tegnet({ tekst: 'a\nb', bilag: [{ sek: 600, undertitel: 'Start', afsnit: ['a.'] }, { sek: 3852, undertitel: 'Senere', afsnit: ['b.'] }] });
  assert.ok(p.some((x) => x.s === '1:04:12'));
  assert.ok(p.some((x) => x.s === '10:00'));
});

test('mere luft mellem emner end mellem afsnit i samme emne', async () => {
  const { tekst, bilag } = langOptagelse(2, 8);
  const p = await tegnet({ tekst, bilag });
  const tekster = p.filter((x) => x.farve === BLAEK);
  const iEmne = tekster[1].y - tekster[0].slut;
  const nyTid = p.find((x) => x.s === 'Emne 1');
  const mellemEmner = nyTid.y - tekster[3].slut;
  assert.ok(iEmne > 0 && iEmne < mellemEmner, `${iEmne} < ${mellemEmner}`);
  assert.ok(mellemEmner >= 14, `${mellemEmner}`);
});

test('tid og undertitel står aldrig alene nederst på en side', async () => {
  for (const ordPrAfsnit of [11, 23, 37, 52]) {
    const { tekst, bilag } = langOptagelse(25, ordPrAfsnit);
    const p = await tegnet({ tekst, bilag });
    p.forEach((x, i) => {
      if (x.farve !== BLAA_DYB) return;
      const naeste = p[i + 1];
      assert.equal(naeste.side, x.side, `${x.s} er alene nederst på side ${x.side}`);
      assert.ok(naeste.y + 2 * 14 <= x.bund, `${x.s}: mindre end to linjer tekst under`);
    });
  }
});

test('hele teksten er med i bilaget ord for ord', async () => {
  const { tekst, bilag } = langOptagelse(6, 40);
  const p = await tegnet({ tekst, bilag });
  assert.deepEqual(ordAf(p.filter((x) => x.farve === BLAEK).map((x) => x.s).join(' ')), ordAf(tekst));
});

test('kort optagelse: kun tid til venstre og teksten, ingen undertitler', async () => {
  const afsnit = laesAfsnit('[00:00] Taget er utæt.\n[00:42] Facaden mangler fuger.');
  const p = await tegnet({ tekst: samletTekst(afsnit), bilag: lavBilag(afsnit, []) });
  assert.ok(!p.some((x) => x.farve === BLAA_DYB));
  const tid = p.find((x) => x.s === '00:42');
  const linje = p.find((x) => x.s === 'Facaden mangler fuger.');
  assert.equal(tid.x, 56);
  assert.ok(linje.x > tid.x + 40);
  assert.ok(Math.abs(linje.y - tid.y) < 3);
});

test('tekst uden tidspunkter vises som før: hele teksten i ét stykke ved margenen', async () => {
  const p = await tegnet({ tekst: 'Ingen tider her.\nAnden linje.', bilag: null });
  const tekster = p.filter((x) => x.farve === BLAEK);
  assert.deepEqual(tekster.map((x) => [x.s, x.x]), [['Ingen tider her.\nAnden linje.', 56]]);
});

test('lang optagelse med emner giver en gyldig PDF over flere sider', async () => {
  const { tekst, bilag } = langOptagelse(20, 60);
  const pdf = await lavPdf({ titel: 'Lang', tidspunkt: TIDSPUNKT, varighedSek: 3000, referat: REFERAT, tekst, bilag });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(sider(pdf) >= 4, `kun ${sider(pdf)} sider`);
});
