import { GRAPH_URL } from './konfig.js';
import { SendFejl, kombinerSignaler } from './transskribering.js';

const TIDSGRAENSE_MS = 30 * 1000;
const TIDSZONE = 'Europe/Copenhagen';

function escape(tekst) {
  return String(tekst)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function langDato(tidspunkt) {
  return new Date(tidspunkt).toLocaleDateString('da-DK', { timeZone: TIDSZONE, day: 'numeric', month: 'long', year: 'numeric' });
}

function kortDato(tidspunkt) {
  return new Date(tidspunkt).toLocaleString('da-DK', { timeZone: TIDSZONE, dateStyle: 'short', timeStyle: 'short' });
}

function html(note) {
  const r = note.referat;
  const stil = 'font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#282828;font-size:16px;line-height:1.5';
  const dele = [`<div style="${stil}">`, `<h2 style="margin:0 0 8px">${escape(note.titel || r.titel)}</h2>`];
  if (r.kort) {
    dele.push(`<p style="white-space:pre-wrap">${escape(r.renTekst)}</p>`);
  } else {
    if (r.opsummering) dele.push(`<p>${escape(r.opsummering)}</p>`);
    if (r.hovedpunkter?.length) {
      dele.push('<h3 style="color:#0e5aa3;margin:16px 0 4px">Hovedpunkter</h3>');
      dele.push(`<ul>${r.hovedpunkter.map((p) => `<li>${escape(p)}</li>`).join('')}</ul>`);
    }
  }
  dele.push('<p style="color:#5b6470;font-size:14px">Hele referatet og den fulde transskription ligger i den vedhæftede PDF.</p>');
  dele.push('</div>');
  return dele.join('\n');
}

/**
 * Mailens emne, tekst og bilag. Emne og tekst laves af serveren (server/src/besked.js).
 * Noter fra før det bruger den gamle opbygning, og noter fra før referaterne sendes som ren tekst.
 */
export function lavBesked(note) {
  if (!note.referat || !note.pdf) {
    return { subject: `Transskription ${kortDato(note.oprettet)}`, body: { contentType: 'Text', content: note.tekst } };
  }
  const fraServeren = typeof note.emne === 'string' && typeof note.html === 'string';
  return {
    subject: fraServeren ? note.emne : `Referat: ${note.titel || note.referat.titel} – ${langDato(note.oprettet)}`,
    body: { contentType: 'HTML', content: fraServeren ? note.html : html(note) },
    attachments: bilag(note),
  };
}

const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// Microsoft Graph tager kun ca. 3 MB bilag i én sendMail. Under det er der lidt luft.
const MAX_BILAG_BYTES = 2_900_000;

/** Antal bytes i en base64-tekst. */
function bytesAf(base64) {
  return Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
}

const fil = (name, contentType, contentBytes) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name, contentType, contentBytes });

/**
 * PDF og, når noten har det, Word-dokumentet, så referatet kan rettes. Noter fra før Word sendes med PDF alene.
 * Bliver de to tilsammen for store til én mail, sendes kun PDF'en, aldrig en fejl.
 */
function bilag(note) {
  const pdf = fil(note.filnavn, 'application/pdf', note.pdf);
  if (typeof note.docx !== 'string' || !note.docx) return [pdf];
  if (bytesAf(note.pdf) + bytesAf(note.docx) > MAX_BILAG_BYTES) return [pdf];
  const navn = note.docxFilnavn || `${String(note.filnavn || 'Referat').replace(/\.pdf$/i, '')}.docx`;
  return [pdf, fil(navn, WORD, note.docx)];
}

/**
 * Sender noten fra brugerens egen konto til brugeren selv. Kun 202 er succes.
 * online er telefonens egen melding om net. Uden net forlader mailen aldrig telefonen, så den kan sendes igen.
 */
export async function sendMail({ note, til, bevis, signal, hent = (...a) => fetch(...a), online = globalThis.navigator?.onLine }) {
  if (online === false) throw new SendFejl('mailFejl');
  let svar;
  try {
    svar = await hent(`${GRAPH_URL}/me/sendMail`, {
      method: 'POST',
      signal: kombinerSignaler([AbortSignal.timeout(TIDSGRAENSE_MS), signal]),
      headers: { authorization: `Bearer ${bevis}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: { ...lavBesked(note), toRecipients: [{ emailAddress: { address: til } }] },
        saveToSentItems: true,
      }),
    });
  } catch {
    // Forbindelsen kan være tabt, efter Microsoft har modtaget mailen. Udfaldet er ukendt.
    throw new SendFejl('mailUkendt');
  }
  if (svar.status === 401) throw new SendFejl('login');
  if (svar.status !== 202) throw new SendFejl('mailFejl');
}
