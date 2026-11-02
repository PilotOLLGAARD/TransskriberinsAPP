'use strict';

/**
 * Laver referatet som PDF i hukommelsen. Intet gemmes på serveren.
 * Lato (ØLLGAARDs skrift, SIL Open Font License) indlejres, så æ, ø og å vises korrekt overalt.
 */

const path = require('node:path');
const fs = require('node:fs');
const PDFDocument = require('pdfkit');
const { AFSNIT, ETIKET, FELTER } = require('./typer.js');

const ASSETS = path.join(__dirname, '..', 'assets');
const LATO = fs.readFileSync(path.join(ASSETS, 'Lato-Regular.ttf'));
const LATO_FED = fs.readFileSync(path.join(ASSETS, 'Lato-Bold.ttf'));
const LOGO = fs.readFileSync(path.join(ASSETS, 'ordmaerke.png'));

const TIDSZONE = 'Europe/Copenhagen';
const BLAEK = '#282828';
const GRAA = '#5b6470';
const BLAA = '#2d89e5';
const BLAA_DYB = '#0e5aa3';
const MARGEN = 56;

function dele(tidspunkt) {
  const d = new Intl.DateTimeFormat('da-DK', {
    timeZone: TIDSZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(tidspunkt));
  return Object.fromEntries(d.map((p) => [p.type, p.value]));
}

function formaterTidspunkt(tidspunkt) {
  const dato = new Date(tidspunkt).toLocaleDateString('da-DK', { timeZone: TIDSZONE, day: 'numeric', month: 'long', year: 'numeric' });
  const { hour, minute } = dele(tidspunkt);
  return `${dato} kl. ${hour}.${minute}`;
}

function formaterVarighed(sek) {
  if (!Number.isFinite(sek)) return null;
  const s = Math.max(0, Math.round(sek));
  const min = Math.floor(s / 60);
  const rest = s % 60;
  if (!min) return `${rest} sek`;
  return rest ? `${min} min ${rest} sek` : `${min} min`;
}

function filnavn({ titel, tidspunkt }) {
  const { year, month, day } = dele(tidspunkt);
  const ren = String(titel || '')
    .replace(/[/\\]/g, '-')
    .replace(/[:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .trim();
  const kort = [...ren].slice(0, 100).join('').trim();
  return `${year}-${month}-${day} ${kort || 'Optagelse'}.pdf`;
}

function formaterOpgave({ hvem, hvad, hvornaar }) {
  return `${hvem ? `${hvem}: ` : ''}${hvad}${hvornaar ? ` (frist: ${hvornaar})` : ''}`;
}

// Uden kendt type vises alle afsnit, der har indhold.
const ALLE_FELTER = ['hovedpunkter', 'beslutninger', 'opgaver', 'fejlOgMangler', 'maalOgMaengder', 'huskeliste', 'aabneSpoergsmaal'];

function punkterAf(referat, felt) {
  const punkter = referat[felt] || [];
  return felt === 'opgaver' ? punkter.map(formaterOpgave) : punkter;
}

/** Afsnittene i den rækkefølge, typen bestemmer. Tomme afsnit udelades. */
function lavAfsnit(referat) {
  const huskeliste = { overskrift: FELTER.huskeliste.overskrift, punkter: referat.huskeliste || [] };
  if (referat.kort) {
    return [huskeliste, { overskrift: 'Note', tekst: referat.renTekst }].filter((a) => a.tekst !== undefined || a.punkter.length);
  }
  const felter = AFSNIT[referat.type]?.map((a) => a.felt) ?? ALLE_FELTER;
  return felter
    .map((felt) => ({ overskrift: FELTER[felt].overskrift, punkter: punkterAf(referat, felt) }))
    .filter((a) => a.punkter.length);
}

/** Linjen under titlen: type, tidspunkt og varighed. */
function lavMeta({ type, tidspunkt, varighedSek }) {
  const varighed = formaterVarighed(varighedSek);
  return [AFSNIT[type] && ETIKET[type], formaterTidspunkt(tidspunkt), varighed && `Varighed ${varighed}`]
    .filter(Boolean)
    .join('  ·  ');
}

function overskrift(doc, tekst) {
  doc.moveDown(0.9).font('fed').fontSize(13).fillColor(BLAA_DYB).text(tekst).moveDown(0.3);
}

function broedtekst(doc, tekst) {
  doc.font('normal').fontSize(11).fillColor(BLAEK).text(tekst, { lineGap: 3 });
}

function lavPdf({ titel, tidspunkt, varighedSek, referat, tekst }) {
  return new Promise((ok, fejl) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGEN, bottom: MARGEN, left: MARGEN, right: MARGEN },
      info: { Title: titel, Author: 'ØLLGAARD', Creator: 'Transskribering' },
    });
    const stykker = [];
    doc.on('data', (d) => stykker.push(d));
    doc.on('end', () => ok(Buffer.concat(stykker)));
    doc.on('error', fejl);

    try {
      doc.registerFont('normal', LATO);
      doc.registerFont('fed', LATO_FED);

      doc.image(LOGO, MARGEN, MARGEN - 8, { width: 150 });
      doc.y = MARGEN + 46;
      doc.font('fed').fontSize(20).fillColor(BLAEK).text(titel, { lineGap: 2 });
      doc.moveDown(0.2).font('normal').fontSize(10.5).fillColor(GRAA).text(lavMeta({ type: referat.type, tidspunkt, varighedSek }));
      const y = doc.y + 10;
      doc.moveTo(MARGEN, y).lineTo(doc.page.width - MARGEN, y).lineWidth(1.5).strokeColor(BLAA).stroke();
      doc.y = y + 4;

      if (!referat.kort && referat.opsummering) {
        overskrift(doc, 'Opsummering');
        broedtekst(doc, referat.opsummering);
      }
      for (const afsnit of lavAfsnit(referat)) {
        overskrift(doc, afsnit.overskrift);
        if (afsnit.tekst !== undefined) broedtekst(doc, afsnit.tekst);
        else {
          doc.font('normal').fontSize(11).fillColor(BLAEK)
            .list(afsnit.punkter, { bulletRadius: 2, textIndent: 14, bulletIndent: 2, lineGap: 3, paragraphGap: 4 });
        }
      }

      // Den fulde transskription følger altid med, fordi et referat kan udelade noget, der senere viser sig vigtigt.
      doc.addPage();
      doc.font('fed').fontSize(15).fillColor(BLAEK).text('Bilag: Fuld transskription');
      doc.moveDown(0.2).font('normal').fontSize(10.5).fillColor(GRAA).text(`${titel}  ·  ${formaterTidspunkt(tidspunkt)}`);
      doc.moveDown(0.8);
      broedtekst(doc, tekst || '(ingen tekst)');
      doc.end();
    } catch (e) {
      fejl(e);
    }
  });
}

module.exports = { lavPdf, filnavn, lavAfsnit, lavMeta, formaterVarighed, formaterTidspunkt };
