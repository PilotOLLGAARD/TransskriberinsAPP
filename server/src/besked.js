'use strict';

/**
 * Mailens emne og tekst. Laves på serveren, så telefonen og serveren altid sender den samme mail.
 * Hele referatet ligger i Word-dokumentet. Mailen viser kun det vigtigste.
 */

const { AFSNIT, ETIKET, FELTER } = require('./typer.js');

const TIDSZONE = 'Europe/Copenhagen';
const STIL = 'font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#282828;font-size:16px;line-height:1.5';

function escape(tekst) {
  return String(tekst)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Fx "Møde: Tagrenovering – 2. nov. 2026". */
function lavEmne({ type, titel, tidspunkt }) {
  const dato = new Date(tidspunkt).toLocaleDateString('da-DK', { timeZone: TIDSZONE, day: 'numeric', month: 'short', year: 'numeric' });
  return `${AFSNIT[type] ? ETIKET[type] : 'Referat'}: ${titel} – ${dato}`;
}

function punktliste(overskrift, punkter) {
  if (!punkter?.length) return [];
  return [
    `<h3 style="color:#0e5aa3;margin:16px 0 4px">${escape(overskrift)}</h3>`,
    `<ul>${punkter.map((p) => `<li>${escape(p)}</li>`).join('')}</ul>`,
  ];
}

/** medWord: false, når Word-dokumentet fejlede. Så sender appen PDF'en i stedet. */
function lavHtml({ titel, referat: r, medWord = true }) {
  const dele = [`<div style="${STIL}">`, `<h2 style="margin:0 0 8px">${escape(titel)}</h2>`];
  // En påmindelse handler om huskelisten. De andre typer viser hovedpunkterne.
  const liste = r.type === 'paamindelse' ? 'huskeliste' : 'hovedpunkter';
  if (r.kort) {
    dele.push(...punktliste(FELTER.huskeliste.overskrift, r.huskeliste));
    dele.push(`<p style="white-space:pre-wrap">${escape(r.renTekst)}</p>`);
  } else {
    if (r.opsummering) dele.push(`<p>${escape(r.opsummering)}</p>`);
    dele.push(...punktliste(FELTER[liste].overskrift, r[liste]));
  }
  dele.push(`<p style="color:#5b6470;font-size:14px">Hele referatet og den fulde transskription ligger i ${medWord ? 'det vedhæftede Word-dokument' : 'den vedhæftede PDF'}.</p>`);
  dele.push('</div>');
  return dele.join('\n');
}

module.exports = { lavEmne, lavHtml };
