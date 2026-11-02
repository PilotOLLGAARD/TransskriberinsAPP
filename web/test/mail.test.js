import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendMail, lavBesked } from '../js/mail.js';

const GAMMEL = { tekst: 'Min note', oprettet: Date.UTC(2026, 9, 30, 12, 0) };
const REFERAT = {
  titel: 'Møde <om> "tag" & ½',
  kort: false,
  opsummering: 'Taget skal skiftes.',
  hovedpunkter: ['Spær 45x195', '<b>fed</b>'],
  beslutninger: [], opgaver: [], fejlOgMangler: [], aabneSpoergsmaal: [], renTekst: '',
};
const NY = {
  tekst: 'Fuld tekst', oprettet: Date.UTC(2026, 10, 2, 12, 5), titel: REFERAT.titel, referat: REFERAT,
  pdf: 'JVBERi0xLjM=', filnavn: '2026-11-02 Møde om tag.pdf',
};

function lavHent(status = 202) {
  const kald = [];
  return { kald, hent: async (url, v) => { kald.push({ url, v }); return new Response(null, { status }); } };
}

test('sender til brugeren selv og gemmer i Sendt post', async () => {
  const { kald, hent } = lavHent();
  await sendMail({ note: GAMMEL, til: 'a@ollgaard.dk', bevis: 'b', hent });
  const krop = JSON.parse(kald[0].v.body);
  assert.match(String(kald[0].url), /\/me\/sendMail$/);
  assert.equal(kald[0].v.headers.authorization, 'Bearer b');
  assert.deepEqual(krop.message.toRecipients, [{ emailAddress: { address: 'a@ollgaard.dk' } }]);
  assert.equal(krop.saveToSentItems, true);
});

test('gammel note uden pdf sendes som tekst', () => {
  const b = lavBesked(GAMMEL);
  assert.deepEqual(b.body, { contentType: 'Text', content: 'Min note' });
  assert.match(b.subject, /^Transskription /);
  assert.equal(b.attachments, undefined);
});

test('emne og bilag fra referat', () => {
  const b = lavBesked(NY);
  assert.equal(b.subject, 'Referat: Møde <om> "tag" & ½ – 2. november 2026');
  assert.deepEqual(b.attachments, [{
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: '2026-11-02 Møde om tag.pdf',
    contentType: 'application/pdf',
    contentBytes: 'JVBERi0xLjM=',
  }]);
  assert.equal(b.body.contentType, 'HTML');
  assert.ok(b.body.content.includes('Taget skal skiftes.'));
  assert.ok(b.body.content.includes('Spær 45x195'));
});

test('HTML escapes', () => {
  const html = lavBesked(NY).body.content;
  assert.ok(!html.includes('<b>fed</b>'));
  assert.ok(html.includes('&lt;b&gt;fed&lt;/b&gt;'));
  assert.ok(html.includes('Møde &lt;om&gt; &quot;tag&quot; &amp; ½'));
});

test('kort note viser den rensede tekst', () => {
  const kort = { ...NY, referat: { ...REFERAT, kort: true, renTekst: 'Husk søm.', hovedpunkter: [] } };
  const html = lavBesked(kort).body.content;
  assert.ok(html.includes('Husk søm.'));
  assert.ok(!html.includes('Hovedpunkter'));
});

test('kun 202 er succes', async () => {
  for (const status of [200, 204, 400, 403, 500]) {
    const { hent } = lavHent(status);
    await assert.rejects(sendMail({ note: NY, til: 'a@ollgaard.dk', bevis: 'b', hent }), (e) => e.type === 'mailFejl', `status ${status}`);
  }
});

test('401 kræver login', async () => {
  const { hent } = lavHent(401);
  await assert.rejects(sendMail({ note: NY, til: 'a@ollgaard.dk', bevis: 'b', hent }), (e) => e.type === 'login');
});

test('netværksfejl giver mailUkendt, for Microsoft kan have modtaget mailen', async () => {
  const hent = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(sendMail({ note: NY, til: 'a@ollgaard.dk', bevis: 'b', hent }), (e) => e.type === 'mailUkendt');
});

test('kaldet har en tidsgrænse', async () => {
  const { kald, hent } = lavHent();
  await sendMail({ note: NY, til: 'a@ollgaard.dk', bevis: 'b', hent });
  assert.ok(kald[0].v.signal instanceof AbortSignal);
});
