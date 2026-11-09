'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { lavDocx } = require('../src/docx.js');

// 2. november 2026 kl. 13.05 dansk tid
const TIDSPUNKT = Date.UTC(2026, 10, 2, 12, 5);

const REFERAT = {
  titel: 'Møde omkring SAS Lounge',
  type: 'moede',
  kort: false,
  opsummering: 'Gennemgang af loftet i loungen.',
  hovedpunkter: ['Loftet hænger 12 mm for lavt', 'Æbletræet ved indgangen bevares 🌳'],
  beslutninger: ['Vi bruger <gips> & "skruer"'],
  opgaver: [{ hvem: 'Søren', hvad: 'bestille 40 m² gips', hvornaar: 'fredag' }, { hvad: 'måle op igen' }],
  fejlOgMangler: ['Revne i væg ved akse B'],
  aabneSpoergsmaal: ["Hvem betaler for Peter's stillads?"],
  renTekst: '',
};

const TEKST = 'Første linje af mødet.\nAnden linje med æøå ÆØÅ.\n\nTredje afsnit efter en tom linje.';

// En uafhængig CRC-32, så testen ikke stoler på den samme funktion som koden.
const CRC_TABEL = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABEL[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Lille unzip: læser centralkataloget og pakker hver del ud. Tjekker CRC og størrelser undervejs. */
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'mangler slutningen af centralkataloget');
  const antal = buf.readUInt16LE(eocd + 10);
  const katalogStr = buf.readUInt32LE(eocd + 12);
  const katalogStart = buf.readUInt32LE(eocd + 16);
  assert.equal(katalogStart + katalogStr, eocd, 'centralkatalogets størrelse passer ikke');
  const dele = new Map();
  // Rå bytes, fx til billeder. Map'en selv har teksten.
  dele.raa = new Map();
  let p = katalogStart;
  for (let i = 0; i < antal; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'forkert signatur i centralkataloget');
    const metode = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const pakket = buf.readUInt32LE(p + 20);
    const udpakket = buf.readUInt32LE(p + 24);
    const navnLgd = buf.readUInt16LE(p + 28);
    const ekstraLgd = buf.readUInt16LE(p + 30);
    const kommentarLgd = buf.readUInt16LE(p + 32);
    const lokal = buf.readUInt32LE(p + 42);
    const navn = buf.subarray(p + 46, p + 46 + navnLgd).toString('utf8');

    assert.equal(buf.readUInt32LE(lokal), 0x04034b50, `forkert lokal signatur for ${navn}`);
    assert.equal(buf.readUInt32LE(lokal + 14), crc, `lokal CRC for ${navn}`);
    assert.equal(buf.readUInt32LE(lokal + 18), pakket, `lokal pakket størrelse for ${navn}`);
    assert.equal(buf.readUInt32LE(lokal + 22), udpakket, `lokal størrelse for ${navn}`);
    const lokalNavnLgd = buf.readUInt16LE(lokal + 26);
    const lokalEkstraLgd = buf.readUInt16LE(lokal + 28);
    assert.equal(buf.subarray(lokal + 30, lokal + 30 + lokalNavnLgd).toString('utf8'), navn);
    const start = lokal + 30 + lokalNavnLgd + lokalEkstraLgd;
    const data = buf.subarray(start, start + pakket);
    const indhold = metode === 8 ? zlib.inflateRawSync(data) : data;
    assert.ok(metode === 8 || metode === 0, `ukendt metode ${metode}`);
    assert.equal(indhold.length, udpakket, `størrelse for ${navn}`);
    assert.equal(crc32(indhold), crc, `CRC for ${navn}`);
    dele.set(navn, indhold.toString('utf8'));
    dele.raa.set(navn, indhold);
    p += 46 + navnLgd + ekstraLgd + kommentarLgd;
  }
  return dele;
}

/** Simpel kontrol af, at XML'en er velformet: tags går op, og & bruges kun til entiteter. */
function tjekVelformet(xml, navn) {
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'), `${navn} mangler XML-erklæring`);
  const krop = xml.replace(/^<\?xml[^>]*\?>/, '');
  const stak = [];
  for (const [tag, slut, tagNavn, selvLukket] of krop.matchAll(/<(\/?)([\w:]+)(?:\s[^<>]*?)?(\/?)>/g)) {
    if (selvLukket) continue;
    if (slut) assert.equal(stak.pop(), tagNavn, `${navn}: ${tag} lukker forkert tag`);
    else stak.push(tagNavn);
  }
  assert.deepEqual(stak, [], `${navn}: tags er ikke lukket`);
  const udenTags = krop.replace(/<[^<>]*>/g, '');
  assert.ok(!/[<>]/.test(udenTags), `${navn}: rå < eller > i teksten`);
  assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(krop), `${navn}: rå & i teksten`);
}

const lav = (over = {}) => lavDocx({ titel: REFERAT.titel, tidspunkt: TIDSPUNKT, varighedSek: 252, referat: REFERAT, tekst: TEKST, ...over });
const dokument = (over) => unzip(lav(over)).get('word/document.xml');
/** Teksten i document.xml uden tags, med entiteter afkodet. Ét afsnit pr. linje. Logoets afsnit springes over. */
const afsnitAf = (xml) => [...xml.matchAll(/<w:p[ >].*?<\/w:p>/g)].filter(([p]) => !p.includes('<w:drawing>')).map(([p]) => p
  .replace(/<w:tab\/>/g, '\t')
  .replace(/<[^>]*>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));

test('er en ZIP med alle dele, og CRC og størrelser stemmer', () => {
  const buf = lav();
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004');
  const dele = unzip(buf);
  for (const navn of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) {
    assert.ok(dele.has(navn), `mangler ${navn}`);
  }
  assert.equal([...dele.keys()][0], '[Content_Types].xml');
});

test('[Content_Types].xml har den rigtige type for document.xml og styles.xml', () => {
  const typer = unzip(lav()).get('[Content_Types].xml');
  assert.ok(typer.includes('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'));
  assert.ok(typer.includes('<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'));
  assert.ok(typer.includes('<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'));
});

test('relationerne peger på dokumentet og typografierne', () => {
  const dele = unzip(lav());
  assert.ok(dele.get('_rels/.rels').includes('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"'));
  assert.ok(dele.get('word/_rels/document.xml.rels').includes('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"'));
});

test('alle XML-dele er velformede', () => {
  for (const [navn, xml] of unzip(lav())) if (/\.(xml|rels)$/.test(navn)) tjekVelformet(xml, navn);
});

test('titel, linjen med type, dato og varighed, og opsummering kommer først', () => {
  const a = afsnitAf(dokument());
  assert.equal(a[0], 'Møde omkring SAS Lounge');
  assert.equal(a[1], 'Møde  ·  2. november 2026 kl. 13.05  ·  Varighed 4 min 12 sek');
  assert.equal(a[2], 'Opsummering');
  assert.equal(a[3], 'Gennemgang af loftet i loungen.');
});

test('afsnittene følger typens rækkefølge, og opgaver har hvem, hvad og hvornår', () => {
  const a = afsnitAf(dokument());
  const overskrifter = ['Hovedpunkter', 'Beslutninger', 'Opgaver og aftaler', 'Åbne spørgsmål', 'Bilag: Fuld transskription'];
  const pladser = overskrifter.map((o) => a.indexOf(o));
  assert.ok(pladser.every((x) => x > 0), `mangler overskrift: ${pladser}`);
  assert.deepEqual([...pladser].sort((x, y) => x - y), pladser);
  assert.ok(!a.includes('Fejl og mangler'), 'møder har ikke fejl og mangler');
  assert.ok(a.includes('•\tSøren: bestille 40 m² gips (frist: fredag)'));
  assert.ok(a.includes('•\tmåle op igen'));
  assert.ok(a.includes('•\tÆbletræet ved indgangen bevares 🌳'));
});

test('byggenotat har fejl og mangler før opgaver', () => {
  const a = afsnitAf(dokument({ referat: { ...REFERAT, type: 'byggenotat' } }));
  assert.ok(a.indexOf('Fejl og mangler') > 0);
  assert.ok(a.indexOf('Fejl og mangler') < a.indexOf('Opgaver og aftaler'));
  assert.ok(!a.includes('Beslutninger'));
});

test('bilaget har hele transskriptionen, linje for linje som afsnit, på en ny side', () => {
  const xml = dokument();
  const a = afsnitAf(xml);
  const bilag = a.indexOf('Bilag: Fuld transskription');
  assert.equal(a[bilag + 1], 'Møde omkring SAS Lounge  ·  2. november 2026 kl. 13.05');
  assert.deepEqual(a.slice(bilag + 2), ['Første linje af mødet.', 'Anden linje med æøå ÆØÅ.', 'Tredje afsnit efter en tom linje.']);
  assert.match(xml, /<w:pageBreakBefore\/>.*Bilag: Fuld transskription/);
});

test('lang transskription kommer med i sin helhed', () => {
  const linjer = Array.from({ length: 2000 }, (_, i) => `Linje ${i + 1} om facaden.`);
  const a = afsnitAf(dokument({ tekst: linjer.join('\n') }));
  assert.deepEqual(a.slice(-2000), linjer);
});

test('tom transskription skriver (ingen tekst)', () => {
  assert.equal(afsnitAf(dokument({ tekst: '' })).at(-1), '(ingen tekst)');
});

test('specialtegn escapes, og æøå og emoji bevares', () => {
  const xml = dokument({ titel: 'Tag <&> "A" \'B\'', tekst: 'a < b & c > d "e" \'f\' 🙂' });
  tjekVelformet(xml, 'document.xml');
  assert.ok(xml.includes('Tag &lt;&amp;&gt; &quot;A&quot; &apos;B&apos;'));
  assert.ok(xml.includes('a &lt; b &amp; c &gt; d &quot;e&quot; &apos;f&apos; 🙂'));
  assert.ok(xml.includes('Vi bruger &lt;gips&gt; &amp; &quot;skruer&quot;'));
  assert.ok(xml.includes('Æbletræet ved indgangen bevares 🌳'));
  assert.ok(xml.includes('måle op igen'));
});

test('kontroltegn, som XML ikke tillader, fjernes', () => {
  const xml = dokument({ tekst: 'før\u0000\u0007\u000befter￾' });
  assert.ok(xml.includes('førefter'));
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/.test(xml));
});

test('kort note har huskeliste og noten, ingen opsummering', () => {
  const kort = { ...REFERAT, type: 'paamindelse', kort: true, opsummering: 'SKJULT', renTekst: 'Husk søm.\nOg skruer.', huskeliste: ['Søm'] };
  const a = afsnitAf(dokument({ referat: kort }));
  assert.ok(!a.includes('SKJULT'));
  assert.ok(!a.includes('Opsummering'));
  const note = a.indexOf('Note');
  assert.ok(a.indexOf('Huskeliste') > 0 && a.indexOf('Huskeliste') < note);
  assert.deepEqual(a.slice(note + 1, note + 3), ['Husk søm.', 'Og skruer.']);
});

test('typografierne har overskrifter og systemskrift', () => {
  const stil = unzip(lav()).get('word/styles.xml');
  assert.ok(stil.includes('w:styleId="Title"'));
  assert.ok(stil.includes('w:styleId="Heading1"'));
  assert.ok(stil.includes('w:ascii="Calibri"'));
  assert.ok(stil.includes('<w:lang w:val="da-DK"/>'));
});

test('dokumentets egenskaber har titlen', () => {
  const kerne = unzip(lav({ titel: 'Tag & tårn' })).get('docProps/core.xml');
  assert.ok(kerne.includes('<dc:title>Tag &amp; tårn</dc:title>'));
});


// Bilaget delt i emner med tidspunkter

const { laesAfsnit, samletTekst, knytEmner, lavBilag } = require('../src/afsnit.js');

const RAA = [
  '[00:00] Velkommen til mødet om taget.',
  '[04:26] Taget er utæt ved kippen,',
  '[04:31] og der mangler 12 lægter.',
  '[16:35] Facaden mangler fuger mod nord.',
  '[1:04:12] Vi ses fredag.',
].join('\n');
const AFSNIT = laesAfsnit(RAA);
const EMNER = knytEmner(AFSNIT, [{ tid: '00:00', undertitel: 'Tag og kip' }, { tid: '16:35', undertitel: 'Facade & fuger' }]);
const bilagDel = (xml) => {
  const a = afsnitAf(xml);
  return a.slice(a.indexOf('Bilag: Fuld transskription') + 2);
};
const bilagXml = (xml) => xml.slice(xml.indexOf('Bilag: Fuld transskription'));

test('bilag med emner: tid, tabulator og undertitel som ét afsnit, teksten indrykket under', () => {
  const xml = dokument({ tekst: samletTekst(AFSNIT), bilag: lavBilag(AFSNIT, EMNER) });
  tjekVelformet(xml, 'document.xml');
  assert.deepEqual(bilagDel(xml), [
    '00:00\tTag og kip',
    'Velkommen til mødet om taget.',
    'Taget er utæt ved kippen, og der mangler 12 lægter.',
    '16:35\tFacade & fuger',
    'Facaden mangler fuger mod nord.',
    'Vi ses fredag.',
  ]);
  const del = bilagXml(xml);
  assert.match(del, /<w:pStyle w:val="Emne"\/><\/w:pPr><w:r><w:rPr><w:rStyle w:val="Tid"\/><\/w:rPr><w:t xml:space="preserve">16:35<\/w:t><\/w:r><w:r><w:tab\/><w:t xml:space="preserve">Facade &amp; fuger<\/w:t><\/w:r>/);
  assert.equal((del.match(/w:val="Bilagtekst"/g) || []).length, 4);
});

test('bilag over en time viser t:mm:ss', () => {
  const xml = dokument({ tekst: samletTekst(AFSNIT), bilag: lavBilag(AFSNIT, []) });
  assert.ok(bilagDel(xml).includes('1:04:12\tVi ses fredag.'));
});

test('kort optagelse: kun tid og tekst i hvert afsnit, ingen undertitler', () => {
  const kort = laesAfsnit('[00:00] Taget er utæt.\n[00:42] Facaden mangler fuger.');
  const xml = dokument({ tekst: samletTekst(kort), bilag: lavBilag(kort, []) });
  assert.deepEqual(bilagDel(xml), ['00:00\tTaget er utæt.', '00:42\tFacaden mangler fuger.']);
  assert.ok(!bilagXml(xml).includes('w:val="Emne"'));
  assert.equal((bilagXml(xml).match(/w:val="Tidsafsnit"/g) || []).length, 2);
});

test('hele teksten er med i bilaget ord for ord', () => {
  const ord = (t) => t.split(/\s+/).filter(Boolean);
  const xml = dokument({ tekst: samletTekst(AFSNIT), bilag: lavBilag(AFSNIT, EMNER) });
  const tekst = bilagDel(xml).filter((l) => !/^\d{1,2}(:\d{2}){1,2}\t/.test(l)).join(' ');
  assert.deepEqual(ord(tekst), ord(samletTekst(AFSNIT)));
});

test('tekst uden tidspunkter vises som før', () => {
  const xml = dokument({ bilag: null });
  assert.deepEqual(bilagDel(xml), ['Første linje af mødet.', 'Anden linje med æøå ÆØÅ.', 'Tredje afsnit efter en tom linje.']);
});

test('typografierne til bilaget: emnet holdes med teksten, tiden er grå, undertitlen fed og knapblå', () => {
  const stil = unzip(lav()).get('word/styles.xml');
  const emne = stil.match(/<w:style [^>]*w:styleId="Emne".*?<\/w:style>/)[0];
  assert.match(emne, /<w:keepNext\/>/);
  assert.match(emne, /<w:b\/>/);
  assert.match(emne, /w:color w:val="0E5AA3"/);
  assert.match(emne, /<w:tab w:val="left" w:pos="(\d+)"\/>/);
  const tab = emne.match(/w:pos="(\d+)"/)[1];
  const tekst = stil.match(/<w:style [^>]*w:styleId="Bilagtekst".*?<\/w:style>/)[0];
  assert.match(tekst, new RegExp(`<w:ind w:left="${tab}"/>`));
  const tid = stil.match(/<w:style [^>]*w:styleId="Tid".*?<\/w:style>/)[0];
  assert.match(tid, /w:type="character"/);
  assert.match(tid, /w:color w:val="5B6470"/);
  assert.match(tid, /<w:b w:val="0"\/>/);
  const tidsafsnit = stil.match(/<w:style [^>]*w:styleId="Tidsafsnit".*?<\/w:style>/)[0];
  assert.match(tidsafsnit, new RegExp(`<w:ind w:left="${tab}" w:hanging="${tab}"/>`));
});

// ØLLGAARD-logoet øverst på første side, som i PDF'en.

const LOGO = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'assets', 'ordmaerke.png'));

test('logoet ligger i dokumentet som det samme billede som i PDF\'en', () => {
  const dele = unzip(lav());
  assert.ok(dele.raa.has('word/media/ordmaerke.png'), 'mangler billedet');
  assert.ok(dele.raa.get('word/media/ordmaerke.png').equals(LOGO));
  assert.ok(dele.get('[Content_Types].xml').includes('<Default Extension="png" ContentType="image/png"/>'));
});

test('logoet er første afsnit og peger på billedet gennem relationerne', () => {
  const dele = unzip(lav());
  const rel = /<Relationship Id="(rId\d+)" Type="http:\/\/schemas.openxmlformats.org\/officeDocument\/2006\/relationships\/image" Target="media\/ordmaerke.png"\/>/
    .exec(dele.get('word/_rels/document.xml.rels'));
  assert.ok(rel, 'mangler relation til billedet');
  const forste = /<w:p[ >].*?<\/w:p>/.exec(dele.get('word/document.xml').replace(/^.*?<w:body>/, ''))[0];
  assert.ok(forste.includes('<w:drawing>'), 'logoet er ikke første afsnit');
  assert.ok(forste.includes(`r:embed="${rel[1]}"`));
  assert.ok(forste.includes('descr="ØLLGAARD"'), 'mangler alternativ tekst');
});

test('logoet er 150 pt bredt som i PDF\'en og holder sit forhold', () => {
  const xml = unzip(lav()).get('word/document.xml');
  const [, cx, cy] = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(xml);
  assert.equal(Number(cx), 150 * 12700);
  const forhold = LOGO.readUInt32BE(16) / LOGO.readUInt32BE(20);
  assert.ok(Math.abs(Number(cx) / Number(cy) - forhold) < 0.01);
  assert.match(xml, /<w:document [^>]*xmlns:r="http:\/\/schemas.openxmlformats.org\/officeDocument\/2006\/relationships"/);
  assert.match(xml, /<w:document [^>]*xmlns:wp="http:\/\/schemas.openxmlformats.org\/drawingml\/2006\/wordprocessingDrawing"/);
});
