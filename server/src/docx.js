'use strict';

/**
 * Laver referatet som Word-dokument (.docx) i hukommelsen, så det kan rettes. Intet gemmes på serveren.
 * Samme indhold og rækkefølge som PDF'en (pdf.js). Filen bygges direkte som OOXML i en ZIP,
 * pakket med Nodes egen zlib, så der ikke kommer nye afhængigheder.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { lavAfsnit, lavMeta, formaterTidspunkt } = require('./pdf.js');
const { formaterTid } = require('./afsnit.js');

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';

// Samme ordmærke som i PDF'en, 150 pt bredt. 1 pt = 12.700 EMU. Højden følger billedets forhold.
const LOGO = fs.readFileSync(path.join(__dirname, '..', 'assets', 'ordmaerke.png'));
const LOGO_CX = 150 * 12700;
const LOGO_CY = Math.round((LOGO_CX * LOGO.readUInt32BE(20)) / LOGO.readUInt32BE(16));
const LOGO_REL = 'rId2';

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

/** Tiden i grå, en tabulator og resten. Det hængende indryk holder ombrudte linjer i kolonnen efter tiden. */
const medTid = (sek, tekst, stil) => `<w:p><w:pPr><w:pStyle w:val="${stil}"/></w:pPr>`
  + `<w:r><w:rPr><w:rStyle w:val="Tid"/></w:rPr><w:t xml:space="preserve">${formaterTid(sek)}</w:t></w:r>`
  + `<w:r><w:tab/><w:t xml:space="preserve">${escape(tekst)}</w:t></w:r></w:p>`;

/**
 * Bilaget som i PDF'en: et emne er tid + tabulator + undertitel med teksten indrykket under.
 * Uden undertitel (korte optagelser) står tiden foran hvert afsnit.
 */
function bilagAfsnit(bilag) {
  return bilag.flatMap((emne) => (emne.undertitel
    ? [medTid(emne.sek, emne.undertitel, 'Emne'), ...emne.afsnit.map((a) => afsnit(a, 'Bilagtekst'))]
    : emne.afsnit.map((a, i) => (i ? afsnit(a, 'Bilagtekst') : medTid(emne.sek, a, 'Tidsafsnit')))));
}

/** ØLLGAARD-logoet som billede i sit eget afsnit, låst til sit forhold. */
const logo = '<w:p><w:pPr><w:spacing w:after="240"/></w:pPr><w:r><w:drawing>'
  + `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${LOGO_CX}" cy="${LOGO_CY}"/>`
  + '<wp:docPr id="1" name="ØLLGAARD" descr="ØLLGAARD"/>'
  + '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
  + `<a:graphic><a:graphicData uri="${PIC}"><pic:pic>`
  + '<pic:nvPicPr><pic:cNvPr id="1" name="ordmaerke.png"/><pic:cNvPicPr/></pic:nvPicPr>'
  + `<pic:blipFill><a:blip r:embed="${LOGO_REL}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
  + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${LOGO_CX}" cy="${LOGO_CY}"/></a:xfrm>`
  + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
  + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';

function lavDokument({
  titel, tidspunkt, varighedSek, referat, tekst, bilag,
}) {
  const p = [
    logo,
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
  if (bilag?.length) p.push(...bilagAfsnit(bilag));
  else {
    const alle = linjer(tekst);
    p.push(...(alle.length ? alle : ['(ingen tekst)']).map((l) => afsnit(l)));
  }

  // A4 med 2 cm margen.
  const sektion = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>';
  return `${XML}<w:document xmlns:w="${W}" xmlns:r="${REL}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}"><w:body>${p.join('')}${sektion}</w:body></w:document>`;
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
  // Bilaget: tiden i en kolonne på 960 twips (48 pt som i PDF'en), undertitel og tekst ved siden af.
  // Emnet holdes sammen med teksten, og tekstens afsnit deles aldrig med én linje alene.
  + '<w:style w:type="paragraph" w:customStyle="1" w:styleId="Emne"><w:name w:val="Emne"/><w:basedOn w:val="Normal"/><w:next w:val="Bilagtekst"/>'
  + '<w:pPr><w:keepNext/><w:tabs><w:tab w:val="left" w:pos="960"/></w:tabs><w:spacing w:before="320" w:after="60"/><w:ind w:left="960" w:hanging="960"/></w:pPr>'
  + '<w:rPr><w:b/><w:bCs/><w:color w:val="0E5AA3"/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:customStyle="1" w:styleId="Bilagtekst"><w:name w:val="Bilagtekst"/><w:basedOn w:val="Normal"/>'
  + '<w:pPr><w:widowControl/><w:spacing w:after="100"/><w:ind w:left="960"/></w:pPr></w:style>'
  + '<w:style w:type="paragraph" w:customStyle="1" w:styleId="Tidsafsnit"><w:name w:val="Tidsafsnit"/><w:basedOn w:val="Normal"/>'
  + '<w:pPr><w:widowControl/><w:tabs><w:tab w:val="left" w:pos="960"/></w:tabs><w:spacing w:after="160"/><w:ind w:left="960" w:hanging="960"/></w:pPr></w:style>'
  + '<w:style w:type="character" w:customStyle="1" w:styleId="Tid"><w:name w:val="Tid"/>'
  + '<w:rPr><w:b w:val="0"/><w:bCs w:val="0"/><w:color w:val="5B6470"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>'
  + '</w:styles>';

const INDHOLDSTYPER = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Default Extension="png" ContentType="image/png"/>'
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
  + `<Relationship Id="${LOGO_REL}" Type="${REL}/image" Target="media/ordmaerke.png"/>`
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
    const data = Buffer.isBuffer(tekst) ? tekst : Buffer.from(tekst, 'utf8');
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

function lavDocx({
  titel, tidspunkt, varighedSek, referat, tekst, bilag,
}) {
  return lavZip([
    ['[Content_Types].xml', INDHOLDSTYPER],
    ['_rels/.rels', RELATIONER],
    ['word/document.xml', lavDokument({
      titel, tidspunkt, varighedSek, referat, tekst, bilag,
    })],
    ['word/_rels/document.xml.rels', DOKUMENT_RELATIONER],
    ['word/styles.xml', TYPOGRAFIER],
    ['word/media/ordmaerke.png', LOGO],
    ['docProps/core.xml', lavEgenskaber({ titel, tidspunkt })],
  ]);
}

module.exports = { lavDocx };
