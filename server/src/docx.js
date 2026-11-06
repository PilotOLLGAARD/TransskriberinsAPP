'use strict';

/**
 * Laver referatet som Word-dokument (.docx) i hukommelsen, så det kan rettes. Intet gemmes på serveren.
 * Samme indhold og rækkefølge som PDF'en (pdf.js). Filen bygges direkte som OOXML i en ZIP,
 * pakket med Nodes egen zlib, så der ikke kommer nye afhængigheder.
 */

const zlib = require('node:zlib');
const { lavAfsnit, lavMeta, formaterTidspunkt } = require('./pdf.js');

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Fjerner tegn, XML ikke tillader (Word nægter at åbne filen), og escaper resten. */
function escape(tekst) {
  return String(tekst ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const koer = (tekst) => `<w:r><w:t xml:space="preserve">${escape(tekst)}</w:t></w:r>`;

function afsnit(tekst, stil, ekstra = '') {
  const pPr = stil || ekstra ? `<w:pPr>${stil ? `<w:pStyle w:val="${stil}"/>` : ''}${ekstra}</w:pPr>` : '';
  return `<w:p>${pPr}${koer(tekst)}</w:p>`;
}

/** Punkt med "•" og tabulator. Det hængende indryk holder ombrudte linjer på linje med teksten. */
const punkt = (tekst) => `<w:p><w:pPr><w:pStyle w:val="Punkt"/></w:pPr><w:r><w:t>•</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">${escape(tekst)}</w:t></w:r></w:p>`;

/** Hver linje bliver sit eget afsnit. Tomme linjer udelades, da afsnittene har luft imellem sig. */
const linjer = (tekst) => String(tekst ?? '').split(/\r?\n/).filter((l) => l.trim());

function lavDokument({ titel, tidspunkt, varighedSek, referat, tekst }) {
  const p = [
    afsnit(titel, 'Title'),
    afsnit(lavMeta({ type: referat.type, tidspunkt, varighedSek }), 'Meta'),
  ];
  if (!referat.kort && referat.opsummering) {
    p.push(afsnit('Opsummering', 'Heading1'), ...linjer(referat.opsummering).map((l) => afsnit(l)));
  }
  for (const a of lavAfsnit(referat)) {
    p.push(afsnit(a.overskrift, 'Heading1'));
    if (a.tekst !== undefined) p.push(...linjer(a.tekst).map((l) => afsnit(l)));
    else p.push(...a.punkter.map(punkt));
  }

  // Den fulde transskription følger altid med, fordi et referat kan udelade noget, der senere viser sig vigtigt.
  p.push(afsnit('Bilag: Fuld transskription', 'Heading1', '<w:pageBreakBefore/>'));
  p.push(afsnit(`${titel}  ·  ${formaterTidspunkt(tidspunkt)}`, 'Meta'));
  const bilag = linjer(tekst);
  p.push(...(bilag.length ? bilag : ['(ingen tekst)']).map((l) => afsnit(l)));

  // A4 med 2 cm margen.
  const sektion = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>';
  return `${XML}<w:document xmlns:w="${W}"><w:body>${p.join('')}${sektion}</w:body></w:document>`;
}

const TYPOGRAFIER = `${XML}<w:styles xmlns:w="${W}">`
  + '<w:docDefaults><w:rPrDefault><w:rPr>'
  + '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>'
  + '<w:color w:val="282828"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="da-DK"/>'
  + '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:spacing w:after="60"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>'
  // Linjen under titlen: grå tekst og en blå streg som i PDF'en.
  + '<w:style w:type="paragraph" w:customStyle="1" w:styleId="Meta"><w:name w:val="Meta"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>'
  + '<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="6" w:color="2D89E5"/></w:pBdr><w:spacing w:after="240"/></w:pPr>'
  + '<w:rPr><w:color w:val="5B6470"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="280" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr>'
  + '<w:rPr><w:b/><w:bCs/><w:color w:val="0E5AA3"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:customStyle="1" w:styleId="Punkt"><w:name w:val="Punkt"/><w:basedOn w:val="Normal"/>'
  + '<w:pPr><w:tabs><w:tab w:val="left" w:pos="360"/></w:tabs><w:spacing w:after="60"/><w:ind w:left="360" w:hanging="360"/></w:pPr></w:style>'
  + '</w:styles>';

const INDHOLDSTYPER = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
  + '</Types>';

const RELATIONER = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>`
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
  + '</Relationships>';

const DOKUMENT_RELATIONER = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + `<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>`
  + '</Relationships>';

function lavEgenskaber({ titel, tidspunkt }) {
  const oprettet = new Date(tidspunkt).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"`
    + ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"'
    + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${escape(titel)}</dc:title><dc:creator>ØLLGAARD</dc:creator>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${oprettet}</dcterms:created></cp:coreProperties>`;
}

/** Minimal ZIP-skriver: deflate, ingen kryptering, ingen ZIP64 (et referat er langt under 4 GB). */
function lavZip(filer) {
  const DOS_DATO = (1 << 5) | 1; // 1. januar 1980. Datoen i ZIP'en bruges ikke til noget.
  const lokale = [];
  const katalog = [];
  let offset = 0;
  for (const [navn, tekst] of filer) {
    const data = Buffer.from(tekst, 'utf8');
    const pakket = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const navnBuf = Buffer.from(navn, 'utf8');

    const lokal = Buffer.alloc(30);
    lokal.writeUInt32LE(0x04034b50, 0);
    lokal.writeUInt16LE(20, 4); // version, der kræves
    lokal.writeUInt16LE(0, 6); // flag
    lokal.writeUInt16LE(8, 8); // deflate
    lokal.writeUInt16LE(0, 10); // tid
    lokal.writeUInt16LE(DOS_DATO, 12);
    lokal.writeUInt32LE(crc, 14);
    lokal.writeUInt32LE(pakket.length, 18);
    lokal.writeUInt32LE(data.length, 22);
    lokal.writeUInt16LE(navnBuf.length, 26);
    lokal.writeUInt16LE(0, 28);
    lokale.push(lokal, navnBuf, pakket);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // lavet af
    central.writeUInt16LE(20, 6); // version, der kræves
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATO, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(pakket.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(navnBuf.length, 28);
    // Ekstra felt, kommentar, disk, interne og eksterne attributter er alle 0.
    central.writeUInt32LE(offset, 42);
    katalog.push(central, navnBuf);

    offset += lokal.length + navnBuf.length + pakket.length;
  }
  const katalogBuf = Buffer.concat(katalog);
  const slut = Buffer.alloc(22);
  slut.writeUInt32LE(0x06054b50, 0);
  slut.writeUInt16LE(filer.length, 8);
  slut.writeUInt16LE(filer.length, 10);
  slut.writeUInt32LE(katalogBuf.length, 12);
  slut.writeUInt32LE(offset, 16);
  return Buffer.concat([...lokale, katalogBuf, slut]);
}

function lavDocx({ titel, tidspunkt, varighedSek, referat, tekst }) {
  return lavZip([
    ['[Content_Types].xml', INDHOLDSTYPER],
    ['_rels/.rels', RELATIONER],
    ['word/document.xml', lavDokument({ titel, tidspunkt, varighedSek, referat, tekst })],
    ['word/_rels/document.xml.rels', DOKUMENT_RELATIONER],
    ['word/styles.xml', TYPOGRAFIER],
    ['docProps/core.xml', lavEgenskaber({ titel, tidspunkt })],
  ]);
}

module.exports = { lavDocx };
