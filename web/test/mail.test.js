import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendMail } from '../js/mail.js';

const VALG = { tekst: 'Min note', til: 'a@ollgaard.dk', oprettet: Date.UTC(2026, 9, 30, 12, 0), bevis: 'b' };

test('sender til brugeren selv og gemmer i Sendt post', async () => {
  let kald;
  const hent = async (url, v) => {
    kald = { url, v };
    return new Response(null, { status: 202 });
  };
  await sendMail({ ...VALG, hent });
  const krop = JSON.parse(kald.v.body);
  assert.match(String(kald.url), /\/me\/sendMail$/);
  assert.equal(kald.v.headers.authorization, 'Bearer b');
  assert.deepEqual(krop.message.toRecipients, [{ emailAddress: { address: 'a@ollgaard.dk' } }]);
  assert.deepEqual(krop.message.body, { contentType: 'Text', content: 'Min note' });
  assert.match(krop.message.subject, /^Transskription /);
  assert.equal(krop.saveToSentItems, true);
});

test('kun 202 er succes', async () => {
  for (const status of [200, 204, 400, 403, 500]) {
    const hent = async () => new Response(null, { status });
    await assert.rejects(sendMail({ ...VALG, hent }), (e) => e.type === 'mailFejl', `status ${status}`);
  }
});

test('401 kræver login', async () => {
  const hent = async () => new Response(null, { status: 401 });
  await assert.rejects(sendMail({ ...VALG, hent }), (e) => e.type === 'login');
});

test('netværksfejl giver mailUkendt, for Microsoft kan have modtaget mailen', async () => {
  const hent = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(sendMail({ ...VALG, hent }), (e) => e.type === 'mailUkendt');
});

test('kaldet har en tidsgrænse', async () => {
  let signal;
  const hent = async (_url, v) => { signal = v.signal; return new Response(null, { status: 202 }); };
  await sendMail({ ...VALG, hent });
  assert.ok(signal instanceof AbortSignal);
});
