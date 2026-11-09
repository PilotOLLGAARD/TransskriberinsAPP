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

const WORD_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('note med Word-dokument får kun Word som bilag, ingen PDF', () => {
  const b = lavBesked({ ...NY, docx: 'UEsDBA==', docxFilnavn: '2026-11-02 Møde om tag.docx' });
  assert.deepEqual(b.attachments, [{
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: '2026-11-02 Møde om tag.docx',
    contentType: WORD_TYPE,
    contentBytes: 'UEsDBA==',
  }]);
});

test('Word uden filnavn får PDF-navnet med .docx', () => {
  const b = lavBesked({ ...NY, docx: 'UEsDBA==' });
  assert.equal(b.attachments[0].name, '2026-11-02 Møde om tag.docx');
});

/** Base64 med præcis så mange bytes. */
const base64Af = (bytes) => 'A'.repeat(Math.ceil(bytes / 3) * 4);

test('Word over 2,9 MB: PDF-filen sendes i stedet, uden fejl', () => {
  const pdf = base64Af(1_500_000);
  const b = lavBesked({ ...NY, pdf, docx: base64Af(3_000_000), docxFilnavn: 'x.docx' });
  assert.equal(b.attachments.length, 1);
  assert.equal(b.attachments[0].contentType, 'application/pdf');
  assert.equal(b.attachments[0].contentBytes, pdf);
});

test('Word lige under 2,9 MB sendes, uanset PDF\'ens størrelse', () => {
  const b = lavBesked({ ...NY, pdf: base64Af(2_000_000), docx: base64Af(2_880_000), docxFilnavn: 'x.docx' });
  assert.deepEqual(b.attachments.map((a) => a.name), ['x.docx']);
});

test('sendMail sender Word med, så Send referat igen også får Word', async () => {
  const { kald, hent } = lavHent();
  await sendMail({ note: { ...NY, docx: 'UEsDBA==', docxFilnavn: 'x.docx' }, til: 'a@ollgaard.dk', bevis: 'b', hent });
  const krop = JSON.parse(kald[0].v.body);
  assert.deepEqual(krop.message.attachments.map((a) => a.name), ['x.docx']);
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

test('lavBesked bruger serverens emne og html', () => {
  const b = lavBesked({ ...NY, emne: 'Møde: Tag – 2. nov. 2026', html: '<p>Fra serveren</p>' });
  assert.equal(b.subject, 'Møde: Tag – 2. nov. 2026');
  assert.deepEqual(b.body, { contentType: 'HTML', content: '<p>Fra serveren</p>' });
  assert.equal(b.attachments[0].contentBytes, 'JVBERi0xLjM=');
});

test('sendMail virker uden AbortSignal.any (iOS 16 og 17.0–17.3)', async () => {
  const any = AbortSignal.any;
  AbortSignal.any = undefined;
  try {
    const { hent } = lavHent(202);
    await sendMail({ note: NY, til: 'a@ollgaard.dk', bevis: 'b', hent });
  } finally {
    AbortSignal.any = any;
  }
});

test('uden net forlader mailen aldrig telefonen: mailFejl, ikke mailUkendt, og intet kald', async () => {
  const { kald, hent } = lavHent();
  await assert.rejects(sendMail({ note: NY, til: 'a@b.dk', bevis: 'b', hent, online: false }), (e) => e.type === 'mailFejl');
  assert.equal(kald.length, 0);
});

test('online som standard: telefonens egen melding om net bruges', async () => {
  const foer = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
  try {
    const { kald, hent } = lavHent();
    await assert.rejects(sendMail({ note: NY, til: 'a@b.dk', bevis: 'b', hent }), (e) => e.type === 'mailFejl');
    assert.equal(kald.length, 0);
  } finally {
    if (foer) Object.defineProperty(globalThis, 'navigator', foer);
    else delete globalThis.navigator;
  }
});

test('en note fra før, hvor serverens tekst nævner PDF\'en, får teksten rettet, når kun Word sendes', () => {
  const html = '<p>Kort.</p>\n<p style="color:#5b6470;font-size:14px">Hele referatet og den fulde transskription ligger i den vedhæftede PDF.</p>';
  const b = lavBesked({ ...NY, emne: 'Møde: Tag', html, docx: 'UEsDBA==', docxFilnavn: 'x.docx' });
  assert.ok(b.body.content.includes('ligger i det vedhæftede Word-dokument.'));
  assert.ok(!b.body.content.includes('PDF'));
});

test('sendes PDF\'en som reserve, står der PDF i mailen', () => {
  const b = lavBesked(NY);
  assert.ok(b.body.content.includes('vedhæftede PDF'));
});

test('nævner serverens tekst Word, men PDF\'en sendes som reserve (for stort Word), rettes teksten til PDF', () => {
  const html = '<p>Hele referatet og den fulde transskription ligger i det vedhæftede Word-dokument.</p>';
  const b = lavBesked({ ...NY, emne: 'Møde: Tag', html, docx: base64Af(3_000_000), docxFilnavn: 'x.docx' });
  assert.equal(b.attachments[0].contentType, 'application/pdf');
  assert.ok(b.body.content.includes('ligger i den vedhæftede PDF.'));
  assert.ok(!b.body.content.includes('Word'));
});
