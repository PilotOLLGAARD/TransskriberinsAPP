import { GRAPH_URL } from './konfig.js';
import { SendFejl } from './transskribering.js';

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
    throw new SendFejl('mailFejl');
  }
  if (svar.status === 401) throw new SendFejl('login');
  if (svar.status !== 202) throw new SendFejl('mailFejl');
}
