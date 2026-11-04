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
    attachments: [{
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: note.filnavn,
      contentType: 'application/pdf',
      contentBytes: note.pdf,
    }],
  };
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
