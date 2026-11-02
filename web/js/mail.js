import { GRAPH_URL } from './konfig.js';
import { SendFejl } from './transskribering.js';

const TIDSGRAENSE_MS = 30 * 1000;

function emne(oprettet) {
  const dato = new Date(oprettet).toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'short' });
  return `Transskription ${dato}`;
}

/** Sender teksten fra brugerens egen konto til brugeren selv. Kun 202 er succes. */
export async function sendMail({ tekst, til, oprettet, bevis, hent = (...a) => fetch(...a) }) {
  let svar;
  try {
    svar = await hent(`${GRAPH_URL}/me/sendMail`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIDSGRAENSE_MS),
      headers: { authorization: `Bearer ${bevis}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: emne(oprettet),
          body: { contentType: 'Text', content: tekst },
          toRecipients: [{ emailAddress: { address: til } }],
        },
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
