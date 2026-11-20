import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEEDBACK_TIL, FEEDBACK_EMNE, MAKS_TEGN, lavFeedbackMail, sendFeedback, telefonType, lavFeedbackKoe, renFeedback,
} from '../js/feedback.js';

function lavHent(status = 202) {
  const kald = [];
  return { kald, hent: async (url, v) => { kald.push({ url, v }); return new Response(null, { status }); } };
}

function hukommelse() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

const SKREVET = Date.UTC(2026, 10, 20, 9, 30);

test('feedback går til Rasmus med fast emne', () => {
  assert.equal(FEEDBACK_TIL, 'rw@ollgaard.dk');
  assert.equal(FEEDBACK_EMNE, 'Feedback på transskriberingsappen');
  assert.equal(MAKS_TEGN, 2000);
});

test('mailen er ren tekst med feedbacken, appens version, telefontype og dato', () => {
  const m = lavFeedbackMail({ tekst: 'Knappen <b>Send</b> er svær at ramme.', version: 'abc1234', telefon: 'iPhone (iOS 18.1)', skrevet: SKREVET });
  assert.equal(m.subject, FEEDBACK_EMNE);
  assert.equal(m.body.contentType, 'Text', 'ren tekst, aldrig HTML');
  assert.match(m.body.content, /^Knappen <b>Send<\/b> er svær at ramme\./);
  assert.match(m.body.content, /App-version: abc1234/);
  assert.match(m.body.content, /Telefon: iPhone \(iOS 18\.1\)/);
  assert.match(m.body.content, /Skrevet: .*20\. november 2026/);
  assert.deepEqual(m.toRecipients, [{ emailAddress: { address: 'rw@ollgaard.dk' } }]);
});

test('renFeedback fjerner kontroltegn, beholder linjeskift og afviser tom eller for lang tekst', () => {
  assert.equal(renFeedback('  Hej\u0000 med\ndig \u0007 '), 'Hej med\ndig');
  assert.equal(renFeedback('   \n '), null);
  assert.equal(renFeedback('x'.repeat(2000)).length, 2000);
  assert.equal(renFeedback('x'.repeat(2001)), null);
});

test('sendFeedback sender fra brugerens egen konto via Graph og gemmer i Sendt post', async () => {
  const { kald, hent } = lavHent();
  await sendFeedback({ tekst: 'God app', version: 'v', telefon: 't', skrevet: SKREVET, bevis: 'b', hent, online: true });
  assert.match(String(kald[0].url), /\/me\/sendMail$/);
  assert.equal(kald[0].v.headers.authorization, 'Bearer b');
  const krop = JSON.parse(kald[0].v.body);
  assert.equal(krop.saveToSentItems, true);
  assert.equal(krop.message.subject, FEEDBACK_EMNE);
});

test('sendFeedback: uden net, 401 og andre fejl giver hver deres type', async () => {
  await assert.rejects(sendFeedback({ tekst: 'a', bevis: 'b', hent: lavHent().hent, online: false }), { type: 'net' });
  await assert.rejects(sendFeedback({ tekst: 'a', bevis: 'b', hent: lavHent(401).hent, online: true }), { type: 'login' });
  await assert.rejects(sendFeedback({ tekst: 'a', bevis: 'b', hent: lavHent(500).hent, online: true }), { type: 'mailFejl' });
  await assert.rejects(sendFeedback({ tekst: 'a', bevis: 'b', hent: async () => { throw new TypeError('net'); }, online: true }), { type: 'net' });
});

test('telefonType giver en kort tekst', () => {
  assert.equal(telefonType('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15'), 'iPhone (iOS 18.1)');
  assert.equal(telefonType('Mozilla/5.0 (Linux; Android 15; SM-S911B) AppleWebKit/537.36 Chrome/131 Mobile'), 'Android 15 (SM-S911B)');
  assert.equal(telefonType('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/131 Mobile'), 'Android 10');
  assert.equal(telefonType('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131'), 'Computer (Windows)');
  assert.equal(telefonType(''), 'Ukendt');
});

test('køen gemmer feedbacken først, sender den og fjerner den først ved 202', async () => {
  const mem = hukommelse();
  const sendt = [];
  const koe = lavFeedbackKoe({ hukommelse: mem, send: async (f) => { sendt.push(f.tekst); } , nu: () => SKREVET });
  koe.tilfoej('Første');
  assert.equal(koe.antal(), 1, 'gemt, før noget sendes');
  assert.equal(await koe.sendVentende(), 'sendt');
  assert.deepEqual(sendt, ['Første']);
  assert.equal(koe.antal(), 0);
});

test('uden net bliver feedbacken liggende og sendes næste gang, uden at noget sendes to gange', async () => {
  const mem = hukommelse();
  let net = false;
  const sendt = [];
  const koe = lavFeedbackKoe({
    hukommelse: mem, nu: () => SKREVET,
    send: async (f) => { if (!net) throw Object.assign(new Error(), { type: 'net' }); sendt.push(f.tekst); },
  });
  koe.tilfoej('A');
  koe.tilfoej('B');
  assert.equal(await koe.sendVentende(), 'net');
  assert.equal(koe.antal(), 2);
  // En ny kø på samme lager (appen genstartet) ser stadig begge.
  net = true;
  const igen = lavFeedbackKoe({ hukommelse: mem, nu: () => SKREVET, send: async (f) => { sendt.push(f.tekst); } });
  assert.equal(igen.antal(), 2);
  assert.equal(await igen.sendVentende(), 'sendt');
  assert.deepEqual(sendt, ['A', 'B']);
  assert.equal(igen.antal(), 0);
});

test('login kræves: feedbacken bliver liggende, og køen siger login', async () => {
  const koe = lavFeedbackKoe({ hukommelse: hukommelse(), send: async () => { throw Object.assign(new Error(), { type: 'login' }); } });
  koe.tilfoej('X');
  assert.equal(await koe.sendVentende(), 'login');
  assert.equal(koe.antal(), 1);
});

test('et ødelagt lager giver en tom kø i stedet for en fejl', async () => {
  const mem = hukommelse();
  mem.setItem('feedbackKoe', '{ikke json');
  const koe = lavFeedbackKoe({ hukommelse: mem, send: async () => {} });
  assert.equal(koe.antal(), 0);
});

test('feedback, der lægges i køen, mens køen allerede sendes, kommer med i samme kørsel', async () => {
  const mem = hukommelse();
  const sendt = [];
  let slip;
  const venter = new Promise((ok) => { slip = ok; });
  const koe = lavFeedbackKoe({ hukommelse: mem, send: async (f) => { if (f.tekst === 'A') await venter; sendt.push(f.tekst); } });
  koe.tilfoej('A');
  const foerste = koe.sendVentende();
  koe.tilfoej('B');
  const anden = koe.sendVentende();
  slip();
  assert.equal(await foerste, 'sendt');
  assert.equal(await anden, 'sendt');
  assert.deepEqual(sendt, ['A', 'B']);
  assert.equal(koe.antal(), 0);
});

test('fuldt lager: tilfoej kaster, så appen kan sige det, og et lager, der ikke kan skrives, sender aldrig i ring', async () => {
  const fuld = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} };
  assert.throws(() => lavFeedbackKoe({ hukommelse: fuld, send: async () => {} }).tilfoej('X'));
  // Et lager, der kan læses, men ikke skrives: hver feedback sendes højst én gang pr. kørsel.
  const fast = { getItem: () => JSON.stringify([{ id: '1', tekst: 'X', skrevet: 0 }]), setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
  let antal = 0;
  const koe = lavFeedbackKoe({ hukommelse: fast, send: async () => { antal++; } });
  assert.equal(await koe.sendVentende(), 'sendt');
  assert.equal(antal, 1);
});
