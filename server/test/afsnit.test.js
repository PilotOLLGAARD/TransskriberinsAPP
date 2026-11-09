'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  laesAfsnit, skalerTider, samletTekst, harTider, formaterTid, laesTid, medTider, knytEmner, trimUndertitel, lavBilag,
} = require('../src/afsnit.js');

const ord = (t) => String(t).split(/\s+/).filter(Boolean);

// Indlæsning af Flashs tidspunkter

test('laesAfsnit: hvert [mm:ss] starter et afsnit, og markøren fjernes fra teksten', () => {
  const a = laesAfsnit('[00:02] Vi starter ved taget.\n[00:14] Så går vi til facaden.');
  assert.deepEqual(a, [{ sek: 2, tekst: 'Vi starter ved taget.' }, { sek: 14, tekst: 'Så går vi til facaden.' }]);
});

test('laesAfsnit: [t:mm:ss] efter en time', () => {
  const a = laesAfsnit('[59:58] Lige før.\n[1:04:12] Efter en time.');
  assert.deepEqual(a.map((x) => x.sek), [3598, 3852]);
});

test('laesAfsnit: tekst uden tidspunkter er ét afsnit uden tid og uændret', () => {
  const tekst = 'Første linje.\n\nAnden linje med 12 mm.';
  assert.deepEqual(laesAfsnit(tekst), [{ sek: null, tekst }]);
  assert.equal(harTider(laesAfsnit(tekst)), false);
  assert.equal(samletTekst(laesAfsnit(tekst)), tekst);
});

test('laesAfsnit: tom tekst giver ingen afsnit', () => {
  assert.deepEqual(laesAfsnit(''), []);
  assert.deepEqual(laesAfsnit(null), []);
  assert.equal(samletTekst([]), '');
});

test('laesAfsnit: tomme linjer og tomme afsnit udelades', () => {
  const a = laesAfsnit('\n[00:01] Et.\n\n\n[00:05]\n[00:09] To.\n\n');
  assert.deepEqual(a, [{ sek: 1, tekst: 'Et.' }, { sek: 9, tekst: 'To.' }]);
});

test('laesAfsnit: linjer uden markør hører til afsnittet før', () => {
  const a = laesAfsnit('[00:01] Et.\nfortsat her.\n[00:09] To.');
  assert.deepEqual(a, [{ sek: 1, tekst: 'Et.\nfortsat her.' }, { sek: 9, tekst: 'To.' }]);
});

test('laesAfsnit: tekst før første markør får tiden 0', () => {
  const a = laesAfsnit('Indledning.\n[00:07] Resten.');
  assert.deepEqual(a, [{ sek: 0, tekst: 'Indledning.' }, { sek: 7, tekst: 'Resten.' }]);
});

test('laesAfsnit: tider i forkert rækkefølge falder aldrig', () => {
  const a = laesAfsnit('[00:10] A.\n[00:05] B.\n[00:20] C.');
  assert.deepEqual(a.map((x) => x.sek), [10, 10, 20]);
});

test('laesAfsnit: kun markører i starten af en linje tæller; et tidspunkt i teksten bliver stående', () => {
  const a = laesAfsnit('[00:01] Vi mødes kl. [14:30] på pladsen.\n[00:04] To.');
  assert.deepEqual(a, [{ sek: 1, tekst: 'Vi mødes kl. [14:30] på pladsen.' }, { sek: 4, tekst: 'To.' }]);
});

test('laesAfsnit: ugyldige sekunder er ikke en markør', () => {
  const a = laesAfsnit('[00:01] Målestok [1:75] står.');
  assert.deepEqual(a, [{ sek: 1, tekst: 'Målestok [1:75] står.' }]);
});

test('samletTekst: teksten uden markører, ét afsnit pr. linje', () => {
  const tekst = '[00:02] Vi starter ved taget.\n[00:14] Så går vi\n[00:20] til facaden.';
  assert.equal(samletTekst(laesAfsnit(tekst)), 'Vi starter ved taget.\nSå går vi\ntil facaden.');
  assert.ok(!/\[\d/.test(samletTekst(laesAfsnit(tekst))));
});

// Rettelse af Flashs sammenpressede tidslinje

test('skalerTider: strækker tiderne lineært til den kendte længde', () => {
  // Sidste afsnit har lige så mange ord som resten tilsammen: Flashs slut anslås til 2 × 400 = 800 s.
  const a = [{ sek: 0, tekst: 'en to tre fire' }, { sek: 200, tekst: 'fem seks' }, { sek: 400, tekst: 'syv otte ni ti tolv tretten' }];
  const s = skalerTider(a, 880);
  assert.deepEqual(s.map((x) => x.sek), [0, 220, 440]);
  assert.deepEqual(s.map((x) => x.tekst), a.map((x) => x.tekst));
});

test('skalerTider: runder til hele sekunder og går aldrig over varigheden', () => {
  const a = [{ sek: 0, tekst: 'a b c d' }, { sek: 101, tekst: 'e f g h' }, { sek: 200, tekst: 'i j' }];
  const s = skalerTider(a, 270);
  for (const x of s) {
    assert.ok(Number.isInteger(x.sek));
    assert.ok(x.sek <= 270);
  }
  // Slut anslås til 200 × (1 + 2/8) = 250 s, faktor 270/250 = 1,08, så 101 s bliver 109,08 → 109 s.
  assert.equal(s[1].sek, 109);
});

test('skalerTider: aldrig over varigheden, når Flash har tider efter slutningen', () => {
  const a = [{ sek: 0, tekst: 'a b' }, { sek: 500, tekst: 'c' }];
  assert.ok(skalerTider(a, 60).every((x) => x.sek <= 60));
});

test('skalerTider: ukendt varighed giver uændrede tider', () => {
  const a = [{ sek: 0, tekst: 'a' }, { sek: 266, tekst: 'b' }];
  assert.deepEqual(skalerTider(a, null), a);
  assert.deepEqual(skalerTider(a, undefined), a);
  assert.deepEqual(skalerTider(a, 0), a);
});

test('skalerTider: tekst uden tidspunkter røres ikke', () => {
  const a = [{ sek: null, tekst: 'Ingen tider.' }];
  assert.deepEqual(skalerTider(a, 300), a);
});

test('skalerTider: ét afsnit kan ikke anslå slutningen og bliver stående', () => {
  assert.deepEqual(skalerTider([{ sek: 0, tekst: 'Kun ét.' }], 40), [{ sek: 0, tekst: 'Kun ét.' }]);
});

test('skalerTider: tiderne falder aldrig', () => {
  const a = [{ sek: 0, tekst: 'a b c' }, { sek: 100, tekst: 'd e' }, { sek: 100, tekst: 'f' }, { sek: 150, tekst: 'g h' }];
  const s = skalerTider(a, 300).map((x) => x.sek);
  assert.deepEqual([...s].sort((x, y) => x - y), s);
});

test('skalerTider: 4:26 hos Flash bliver ca. 4:50 i en optagelse på 5 min', () => {
  const a = [{ sek: 0, tekst: ord('x '.repeat(600)).join(' ') }, { sek: 266, tekst: ord('y '.repeat(20)).join(' ') }];
  const s = skalerTider(a, 300);
  assert.equal(s[1].sek, Math.round(266 * (300 / (266 * (1 + 20 / 600)))));
});

// Tidspunkter som tekst

test('formaterTid: mm:ss og t:mm:ss over en time', () => {
  assert.equal(formaterTid(0), '00:00');
  assert.equal(formaterTid(266), '04:26');
  assert.equal(formaterTid(995), '16:35');
  assert.equal(formaterTid(3599), '59:59');
  assert.equal(formaterTid(3852), '1:04:12');
});

test('laesTid: læser mm:ss, t:mm:ss og [mm:ss], ellers null', () => {
  assert.equal(laesTid('04:26'), 266);
  assert.equal(laesTid('[04:26]'), 266);
  assert.equal(laesTid('1:04:12'), 3852);
  assert.equal(laesTid(' 4:26 '), 266);
  assert.equal(laesTid('4:75'), null);
  assert.equal(laesTid('fire'), null);
  assert.equal(laesTid(42), null);
});

test('medTider: [mm:ss] foran hvert afsnit til referatet', () => {
  const a = [{ sek: 0, tekst: 'Et.' }, { sek: 3852, tekst: 'To.' }];
  assert.equal(medTider(a), '[00:00] Et.\n[1:04:12] To.');
});

// Emner fra referatet

const AFSNIT = [
  { sek: 0, tekst: 'Velkommen.' },
  { sek: 30, tekst: 'Taget er utæt.' },
  { sek: 200, tekst: 'Facaden mangler fuger.' },
  { sek: 260, tekst: 'Vi ses fredag.' },
];

test('knytEmner: hvert emne knyttes til afsnittet med samme tidspunkt', () => {
  const e = knytEmner(AFSNIT, [{ tid: '00:00', undertitel: 'Velkomst og tag' }, { tid: '03:20', undertitel: 'Facaden' }]);
  assert.deepEqual(e, [{ fra: 0, undertitel: 'Velkomst og tag' }, { fra: 2, undertitel: 'Facaden' }]);
});

test('knytEmner: findes tidspunktet ikke, bruges det nærmeste efterfølgende afsnit', () => {
  const e = knytEmner(AFSNIT, [{ tid: '00:00', undertitel: 'A' }, { tid: '03:00', undertitel: 'B' }]);
  assert.deepEqual(e.map((x) => x.fra), [0, 2]);
});

test('knytEmner: emner efter sidste afsnit, uden undertitel eller med ugyldig tid udelades', () => {
  const e = knytEmner(AFSNIT, [
    { tid: '00:00', undertitel: 'A' }, { tid: '09:00', undertitel: 'Efter' }, { tid: '00:30', undertitel: '  ' }, { tid: 'snart', undertitel: 'X' }, null,
  ]);
  assert.deepEqual(e, [{ fra: 0, undertitel: 'A' }]);
});

test('knytEmner: dubletter og forkert rækkefølge ryddes', () => {
  const e = knytEmner(AFSNIT, [
    { tid: '03:20', undertitel: 'Facaden' }, { tid: '00:00', undertitel: 'Start' }, { tid: '03:20', undertitel: 'Igen facaden' }, { tid: '00:30', undertitel: 'Taget' },
  ]);
  assert.deepEqual(e, [{ fra: 0, undertitel: 'Start' }, { fra: 1, undertitel: 'Taget' }, { fra: 2, undertitel: 'Facaden' }]);
});

test('knytEmner: første emne starter altid ved første afsnit', () => {
  const e = knytEmner(AFSNIT, [{ tid: '00:30', undertitel: 'Taget' }, { tid: '04:20', undertitel: 'Afslutning' }]);
  assert.deepEqual(e, [{ fra: 0, undertitel: 'Taget' }, { fra: 3, undertitel: 'Afslutning' }]);
});

test('knytEmner: intet svar giver ingen emner', () => {
  assert.deepEqual(knytEmner(AFSNIT, undefined), []);
  assert.deepEqual(knytEmner(AFSNIT, 'x'), []);
  assert.deepEqual(knytEmner([], [{ tid: '00:00', undertitel: 'A' }]), []);
});

test('trimUndertitel: højst 6 ord og 60 tegn', () => {
  assert.equal(trimUndertitel('  Taget  og   facaden '), 'Taget og facaden');
  assert.equal(trimUndertitel('en to tre fire fem seks syv otte'), 'en to tre fire fem seks');
  const lang = trimUndertitel('Tagkonstruktionsgennemgangen vedrørende ventilationsanlæggets placering');
  assert.ok(lang.length <= 60, lang);
  assert.ok(trimUndertitel('x'.repeat(80)).length <= 60);
  assert.equal(trimUndertitel(7), '');
});

// Bilaget til PDF og Word

test('lavBilag: uden tidspunkter er der intet opdelt bilag', () => {
  assert.equal(lavBilag([{ sek: null, tekst: 'Ingen tider.' }], []), null);
  assert.equal(lavBilag([], []), null);
});

test('lavBilag: emner med deres afsnit', () => {
  const b = lavBilag(AFSNIT, [{ fra: 0, undertitel: 'Tag' }, { fra: 2, undertitel: 'Facade' }]);
  assert.deepEqual(b, [
    { sek: 0, undertitel: 'Tag', afsnit: ['Velkommen.', 'Taget er utæt.'] },
    { sek: 200, undertitel: 'Facade', afsnit: ['Facaden mangler fuger.', 'Vi ses fredag.'] },
  ]);
});

test('lavBilag: uden emner får hvert afsnit sin egen tid', () => {
  const b = lavBilag(AFSNIT.slice(0, 2), []);
  assert.deepEqual(b, [{ sek: 0, afsnit: ['Velkommen.'] }, { sek: 30, afsnit: ['Taget er utæt.'] }]);
});

test('lavBilag: et afsnit, der fortsætter en sætning, sættes sammen med det før', () => {
  const a = [{ sek: 56, tekst: 'Det består af en række retter,' }, { sek: 64, tekst: 'hvor de mest populære er chili.' }, { sek: 74, tekst: 'Næste.' }];
  assert.deepEqual(lavBilag(a, []), [{ sek: 56, afsnit: ['Det består af en række retter, hvor de mest populære er chili.'] }, { sek: 74, afsnit: ['Næste.'] }]);
  assert.deepEqual(lavBilag(a, [{ fra: 0, undertitel: 'Mad' }])[0].afsnit, ['Det består af en række retter, hvor de mest populære er chili.', 'Næste.']);
});

test('lavBilag: hele teksten er med ord for ord', () => {
  const raa = Array.from({ length: 60 }, (_, i) => `[${formaterTid(i * 13)}] Sætning ${i} om taget${i % 4 ? ',' : '.'}`).join('\n');
  const afsnit = laesAfsnit(raa);
  const emner = knytEmner(afsnit, [{ tid: '00:00', undertitel: 'A' }, { tid: '04:20', undertitel: 'B' }, { tid: '09:00', undertitel: 'C' }]);
  const bilag = lavBilag(afsnit, emner);
  assert.equal(bilag.length, 3);
  assert.deepEqual(ord(bilag.flatMap((e) => e.afsnit).join(' ')), ord(samletTekst(afsnit)));
});

// Fund fra gennemgangen

test('skalerTider: en urimelig faktor (fx lang stilhed til sidst) giver uændrede tider', () => {
  // 10 min. tale i en optagelse på 30 min.: faktoren ville være ca. 3.
  const afsnit = [{ sek: 0, tekst: 'en to tre fire' }, { sek: 300, tekst: 'fem seks syv otte' }, { sek: 590, tekst: 'ni ti' }];
  assert.deepEqual(skalerTider(afsnit, 1800).map((a) => a.sek), [0, 300, 590]);
  // En normal faktor (ca. 1,08) skaleres stadig.
  const normal = [{ sek: 0, tekst: 'en to tre fire fem seks syv otte' }, { sek: 130, tekst: 'ni ti elleve tolv tretten fjorten femten seksten' }, { sek: 266, tekst: 'sytten atten' }];
  assert.equal(skalerTider(normal, 323).at(-1).sek, 287);
});

test('lavBilag: afsnit uden punktum lægges højst sammen i 60 s, så tiderne ikke forsvinder', () => {
  const afsnit = Array.from({ length: 200 }, (_, i) => ({ sek: i * 10, tekst: `del ${i} uden punktum` }));
  const bilag = lavBilag(afsnit);
  assert.ok(bilag.length >= 30, `kun ${bilag.length} blokke`);
  for (let i = 1; i < bilag.length; i++) assert.ok(bilag[i].sek - bilag[i - 1].sek <= 70);
  assert.deepEqual(bilag.flatMap((b) => b.afsnit).join(' ').split(' '), afsnit.map((a) => a.tekst).join(' ').split(' '));
});

// Lange afsnit: i en samtale uden lange pauser kan Flash skrive alt som ét afsnit med kun [00:00].

const { delLangeAfsnit } = require('../src/afsnit.js');
// En sætning på 10 ord.
const saetning = (n) => `Sætning nummer ${n} handler om noget helt andet end den før.`;
const langTekst = (antal, skille = ' ') => Array.from({ length: antal }, (_, i) => saetning(i + 1)).join(skille);

test('delLangeAfsnit: ét afsnit over 10 minutter deles ved punktum med anslåede, stigende tider', () => {
  const ud = delLangeAfsnit([{ sek: 0, tekst: langTekst(150) }], 600);
  assert.ok(ud.length >= 10, `kun ${ud.length} afsnit`);
  assert.equal(ud[0].sek, 0);
  for (let i = 1; i < ud.length; i += 1) assert.ok(ud[i].sek > ud[i - 1].sek, `tid ${i} stiger ikke`);
  assert.ok(ud.at(-1).sek < 600);
  // Hvert stykke slutter ved et punktum og er højst ca. 45 s.
  for (const a of ud) assert.match(a.tekst, /\.$/);
  for (let i = 1; i < ud.length; i += 1) assert.ok(ud[i].sek - ud[i - 1].sek <= 60);
});

test('delLangeAfsnit: tiderne fordeles efter antal ord mellem de kendte tidspunkter', () => {
  // 100 sætninger på 400 s: sætning 51 begynder efter halvdelen af ordene, altså ca. 200 s.
  const ud = delLangeAfsnit([{ sek: 0, tekst: langTekst(100) }, { sek: 400, tekst: 'Slut.' }], 410);
  const midt = ud.find((a) => a.tekst.startsWith(saetning(51)));
  if (midt) assert.ok(Math.abs(midt.sek - 200) <= 2, `fik ${midt.sek}`);
  assert.deepEqual(ud.at(-1), { sek: 400, tekst: 'Slut.' });
  assert.ok(ud.filter((a) => a.sek < 400).length >= 8);
});

test('delLangeAfsnit: hele teksten er med ord for ord, og linjeskift bevares som skel', () => {
  const kilde = [{ sek: 0, tekst: langTekst(40, '\n') }, { sek: 300, tekst: langTekst(30) }];
  const ud = delLangeAfsnit(kilde, 500);
  assert.deepEqual(ord(samletTekst(ud)), ord(samletTekst(kilde)));
  assert.ok(ud.length > kilde.length);
});

test('delLangeAfsnit: korte afsnit og afsnit uden punktum røres ikke', () => {
  const kort = [{ sek: 0, tekst: langTekst(5) }, { sek: 40, tekst: langTekst(5) }];
  assert.deepEqual(delLangeAfsnit(kort, 80), kort);
  const udenPunktum = [{ sek: 0, tekst: 'og så videre '.repeat(300).trim() }];
  assert.deepEqual(delLangeAfsnit(udenPunktum, 600), udenPunktum);
});

test('delLangeAfsnit: uden tider eller ukendt slutning af sidste afsnit deles ikke', () => {
  const udenTider = [{ sek: null, tekst: langTekst(150) }];
  assert.deepEqual(delLangeAfsnit(udenTider, 600), udenTider);
  const sidste = [{ sek: 0, tekst: langTekst(150) }];
  assert.deepEqual(delLangeAfsnit(sidste, null), sidste);
});

test('delLangeAfsnit: mange ord på kort tid deles også (Flash har presset tiderne)', () => {
  const ud = delLangeAfsnit([{ sek: 0, tekst: langTekst(60) }, { sek: 60, tekst: 'Slut.' }], 70);
  assert.ok(ud.length >= 4, `kun ${ud.length} afsnit`);
  for (let i = 1; i < ud.length; i += 1) assert.ok(ud[i].sek >= ud[i - 1].sek);
});

test('delLangeAfsnit: så kan referatets emner knyttes til hele optagelsen', () => {
  const ud = delLangeAfsnit([{ sek: 0, tekst: langTekst(150) }], 600);
  const emner = knytEmner(ud, [{ tid: '00:00', undertitel: 'Start' }, { tid: '05:00', undertitel: 'Midt' }]);
  assert.equal(emner.length, 2);
  assert.ok(emner[1].fra > 0);
});

test('lavBilag: med emner lægges linjer uden punktum højst sammen til ca. 150 ord', () => {
  // Flash skal skrive en ny linje mindst hvert 30. sekund, også midt i en sætning.
  const linjer = Array.from({ length: 40 }, (_, i) => ({ sek: i * 15, tekst: 'og så går vi videre med det næste punkt på listen og' }));
  const bilag = lavBilag(linjer, [{ fra: 0, undertitel: 'Hele mødet' }]);
  assert.equal(bilag.length, 1);
  assert.ok(bilag[0].afsnit.length >= 3, `kun ${bilag[0].afsnit.length} afsnit`);
  for (const a of bilag[0].afsnit) assert.ok(ord(a).length <= 160);
  assert.deepEqual(ord(bilag[0].afsnit.join(' ')), ord(samletTekst(linjer)));
});
