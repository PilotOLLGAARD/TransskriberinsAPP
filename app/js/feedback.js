// Feedback fra medarbejderen til Rasmus.
//
// Sendes som en almindelig mail fra medarbejderens egen konto via Microsoft Graph, med samme tilladelse som
// referatet (Mail.Send, delegeret). Serveren og AI'en er ikke med: intet sendes til Google, og intet gemmes
// andre steder end på telefonen, til Microsoft har taget imod mailen. Afsenderens navn og mail følger af sig selv.

import { GRAPH_URL } from './konfig.js';
import { SendFejl, kombinerSignaler } from './transskribering.js';

export const FEEDBACK_TIL = 'rw@ollgaard.dk';
export const FEEDBACK_EMNE = 'Feedback på transskriberingsappen';
export const MAKS_TEGN = 2000;

const KOE_NOEGLE = 'feedbackKoe';
const TIDSGRAENSE_MS = 30 * 1000;
const TIDSZONE = 'Europe/Copenhagen';

/** Teksten uden kontroltegn (linjeskift og tab bevares). null, hvis den er tom eller over 2.000 tegn. */
export function renFeedback(tekst) {
  // eslint-disable-next-line no-control-regex
  const ren = String(tekst ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[ \t]+$/gm, '').trim();
  if (!ren || ren.length > MAKS_TEGN) return null;
  return ren;
}

/** Kort telefontype ud fra browserens oplysninger, fx "iPhone (iOS 18.1)" eller "Android 15 (SM-S911B)". */
export function telefonType(ua = globalThis.navigator?.userAgent ?? '') {
  const ios = /\b(iPhone|iPad|iPod)\b.*? OS (\d+)[_.](\d+)/.exec(ua);
  if (ios) return `${ios[1]} (iOS ${ios[2]}.${ios[3]})`;
  const android = /Android (\d+(?:\.\d+)?)(?:; ([^;)]+))?/.exec(ua);
  if (android) {
    const model = android[2]?.trim();
    // Nyere Chrome skjuler modellen og skriver "K".
    return model && model !== 'K' ? `Android ${android[1]} (${model})` : `Android ${android[1]}`;
  }
  if (/Windows/.test(ua)) return 'Computer (Windows)';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Computer (Mac)';
  if (/Linux/.test(ua)) return 'Computer (Linux)';
  return 'Ukendt';
}

/** Mailen som ren tekst: feedbacken først, derefter app-version, telefon og hvornår den blev skrevet. */
export function lavFeedbackMail({ tekst, version, telefon, skrevet }) {
  const dato = new Date(skrevet ?? Date.now()).toLocaleString('da-DK', {
    timeZone: TIDSZONE, day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const content = [
    tekst,
    '',
    '---',
    `App-version: ${version || 'ukendt'}`,
    `Telefon: ${telefon || 'Ukendt'}`,
    `Skrevet: ${dato}`,
  ].join('\n');
  return {
    subject: FEEDBACK_EMNE,
    // Ren tekst: Outlook viser præcis det, der blev skrevet, og intet kan blive til HTML.
    body: { contentType: 'Text', content },
    toRecipients: [{ emailAddress: { address: FEEDBACK_TIL } }],
  };
}

/** Sender feedbacken fra brugerens egen konto. Kun 202 er succes. */
export async function sendFeedback({
  tekst, version, telefon, skrevet, bevis, signal, hent = (...a) => fetch(...a), online = globalThis.navigator?.onLine,
}) {
  if (online === false) throw new SendFejl('net');
  let svar;
  try {
    svar = await hent(`${GRAPH_URL}/me/sendMail`, {
      method: 'POST',
      signal: kombinerSignaler([AbortSignal.timeout(TIDSGRAENSE_MS), signal]),
      headers: { authorization: `Bearer ${bevis}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: lavFeedbackMail({ tekst, version, telefon, skrevet }), saveToSentItems: true }),
    });
  } catch {
    // Feedbacken bliver liggende og prøves igen. I værste fald får Rasmus den to gange.
    throw new SendFejl('net');
  }
  if (svar.status === 401) throw new SendFejl('login');
  if (svar.status !== 202) throw new SendFejl('mailFejl');
}

/**
 * Køen på telefonen. Feedbacken gemmes, før den sendes, og fjernes først, når Microsoft har sagt 202.
 * send(feedback) sender én; sendVentende() giver 'sendt', 'net', 'login' eller 'fejl'.
 */
export function lavFeedbackKoe({ hukommelse = globalThis.localStorage, send, nu = Date.now }) {
  const laes = () => {
    try {
      const v = JSON.parse(hukommelse?.getItem(KOE_NOEGLE) ?? '[]');
      return Array.isArray(v) ? v.filter((f) => f && typeof f.tekst === 'string') : [];
    } catch {
      return [];
    }
  };
  const skriv = (liste) => {
    if (liste.length) hukommelse?.setItem(KOE_NOEGLE, JSON.stringify(liste));
    else hukommelse?.removeItem(KOE_NOEGLE);
  };
  let igang = null;

  return {
    antal: () => laes().length,
    tilfoej(tekst) {
      const liste = laes();
      liste.push({ id: `${nu()}-${Math.random().toString(36).slice(2, 8)}`, tekst, skrevet: nu() });
      skriv(liste);
    },
    /** Sender alt, der venter, én ad gangen. Stopper ved den første fejl, så rækkefølgen bevares. */
    sendVentende() {
      igang ??= (async () => {
        try {
          for (const f of laes()) {
            try {
              await send(f);
            } catch (e) {
              return ['net', 'login'].includes(e?.type) ? e.type : 'fejl';
            }
            skriv(laes().filter((x) => x.id !== f.id));
          }
          return 'sendt';
        } finally {
          igang = null;
        }
      })();
      return igang;
    },
  };
}
