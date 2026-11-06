import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendLyd, sendReferat, hentMedFremdrift } from '../js/transskribering.js';

const LYD = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' });

function svarMed(status, krop = {}) {
  return async () => new Response(JSON.stringify(krop), { status });
}

test('sender lyden uændret med bevis og format', async () => {
  let kald;
  const hent = async (url, valg) => {
    kald = { url, valg };
    return new Response(JSON.stringify({ tekst: 'Hej' }), { status: 200 });
  };
  const svar = await sendLyd(LYD, 'audio/mp4;codecs=mp4a.40.2', 'beviset', {}, hent);
  assert.deepEqual(svar, { tekst: 'Hej' });
  assert.equal(kald.valg.method, 'POST');
  assert.equal(kald.valg.headers.authorization, 'Bearer beviset');
  assert.equal(kald.valg.headers['content-type'], 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(kald.valg.body, LYD);
  assert.match(String(kald.url), /\/transskriber$/);
});

const TILFAELDE = [
  [401, 'login'],
  [403, 'adgang'],
  [411, 'kanIkkeBehandles'],
  [413, 'kanIkkeBehandles'],
  [415, 'kanIkkeBehandles'],
  [422, 'kanIkkeBehandles'],
  [500, 'tjeneste'],
  [502, 'tjeneste'],
  [503, 'tjeneste'],
  [504, 'tjeneste'],
];

for (const [status, type] of TILFAELDE) {
  test(`${status} giver ${type}`, async () => {
    await assert.rejects(sendLyd(LYD, 'audio/mp4', 'b', {}, svarMed(status)), (e) => e.type === type);
  });
}

test('netværksfejl giver net', async () => {
  const hent = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(sendLyd(LYD, 'audio/mp4', 'b', {}, hent), (e) => e.type === 'net');
});

test('200 uden tekst giver tjeneste', async () => {
  await assert.rejects(sendLyd(LYD, 'audio/mp4', 'b', {}, svarMed(200, {})), (e) => e.type === 'tjeneste');
});

test('200 med vrøvl giver tjeneste', async () => {
  const hent = async () => new Response('ikke json', { status: 200 });
  await assert.rejects(sendLyd(LYD, 'audio/mp4', 'b', {}, hent), (e) => e.type === 'tjeneste');
});

test('tom tekst er et gyldigt svar', async () => {
  assert.deepEqual(await sendLyd(LYD, 'audio/mp4', 'b', {}, svarMed(200, { tekst: '' })), { tekst: '' });
});

test('sender titel, varighed og tidspunkt som headere', async () => {
  let kald;
  const hent = async (url, valg) => { kald = valg; return new Response(JSON.stringify({ tekst: 'Hej' }), { status: 200 }); };
  await sendLyd(LYD, 'audio/mp4', 'b', { titel: 'Byggenotat E/F Nørrehus 🏗️', varighedMs: 12400, oprettet: 1793606700000 }, hent);
  assert.equal(decodeURIComponent(kald.headers['x-titel']), 'Byggenotat E/F Nørrehus 🏗️');
  assert.match(kald.headers['x-titel'], /^[\x20-\x7e]+$/);
  assert.equal(kald.headers['x-varighed'], '12');
  assert.equal(kald.headers['x-optaget'], '1793606700000');
});

test('udelader tomme headere', async () => {
  let kald;
  const hent = async (url, valg) => { kald = valg; return new Response(JSON.stringify({ tekst: 'Hej' }), { status: 200 }); };
  await sendLyd(LYD, 'audio/mp4', 'b', { titel: '  ' }, hent);
  for (const h of ['x-titel', 'x-varighed', 'x-optaget']) assert.equal(h in kald.headers, false, h);
});

test('returnerer referat, pdf og filnavn', async () => {
  const krop = { tekst: 'Hej', titel: 'T', referat: { opsummering: 'O' }, pdf: 'JVBERg==', filnavn: 'f.pdf' };
  assert.deepEqual(await sendLyd(LYD, 'audio/mp4', 'b', {}, svarMed(200, krop)), krop);
});

test('en ødelagt titel stopper ikke afsendelsen', async () => {
  let kald;
  const hent = async (url, valg) => { kald = valg; return new Response(JSON.stringify({ tekst: 'Hej' }), { status: 200 }); };
  assert.deepEqual(await sendLyd(LYD, 'audio/mp4', 'b', { titel: 'Tag \uD83C' }, hent), { tekst: 'Hej' });
  assert.ok(decodeURIComponent(kald.headers['x-titel']).startsWith('Tag'));
});

test('x-type sendes, når typen er kendt', async () => {
  let kald;
  const hent = async (url, valg) => { kald = valg; return new Response(JSON.stringify({ tekst: '' }), { status: 200 }); };
  await sendLyd(LYD, 'audio/mp4', 'b', { type: 'byggenotat' }, hent);
  assert.equal(kald.headers['x-type'], 'byggenotat');
  await sendLyd(LYD, 'audio/mp4', 'b', { type: 'ond\nheader' }, hent);
  assert.equal(kald.headers['x-type'], undefined);
  await sendLyd(LYD, 'audio/mp4', 'b', {}, hent);
  assert.equal(kald.headers['x-type'], undefined);
});

test('x-kun-tekst sendes, når kunTekst er sat', async () => {
  let kald;
  const hent = async (url, valg) => { kald = valg; return new Response(JSON.stringify({ tekst: 'Del' }), { status: 200 }); };
  assert.deepEqual(await sendLyd(LYD, 'audio/mp4', 'b', { kunTekst: true }, hent), { tekst: 'Del' });
  assert.equal(kald.headers['x-kun-tekst'], '1');
  await sendLyd(LYD, 'audio/mp4', 'b', {}, hent);
  assert.equal(kald.headers['x-kun-tekst'], undefined);
});

test('sendReferat sender JSON med tekster, titel, type, varighed og tidspunkt', async () => {
  let kald;
  const hent = async (url, valg) => { kald = { url: String(url), valg }; return new Response(JSON.stringify({ tekst: 'A B', titel: 'T' }), { status: 200 }); };
  const svar = await sendReferat({ tekster: ['A', 'B'], titel: 'Møde', type: 'moede', varighedMs: 90500, oprettet: 7 }, 'beviset', hent);
  assert.equal(svar.titel, 'T');
  assert.match(kald.url, /\/referat$/);
  assert.equal(kald.valg.method, 'POST');
  assert.equal(kald.valg.headers.authorization, 'Bearer beviset');
  assert.equal(kald.valg.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(kald.valg.body), { tekster: ['A', 'B'], titel: 'Møde', type: 'moede', varighedSek: 91, optaget: 7 });
  assert.ok(kald.valg.signal instanceof AbortSignal);
});

test('uden type sender sendReferat intet typefelt, så serveren selv vælger', async () => {
  let kald;
  const hent = async (url, valg) => { kald = valg; return new Response(JSON.stringify({ tekst: 'A', titel: 'T' }), { status: 200 }); };
  await sendReferat({ tekster: ['A'], titel: '', type: undefined }, 'b', hent);
  assert.equal('type' in JSON.parse(kald.body), false);
});

test('sendReferat giver samme fejltyper som sendLyd', async () => {
  for (const [status, type] of [[401, 'login'], [403, 'adgang'], [400, 'tjeneste'], [502, 'tjeneste']]) {
    await assert.rejects(sendReferat({ tekster: ['a'] }, 'b', async () => new Response('{}', { status })), (e) => e.type === type, String(status));
  }
  await assert.rejects(sendReferat({ tekster: ['a'] }, 'b', async () => { throw new TypeError('x'); }), (e) => e.type === 'net');
});

test('vedSendt gives videre og kaldes, når lyden er sendt', async () => {
  let sendt = 0;
  const hent = async (url, valg) => { valg.vedSendt(); return new Response(JSON.stringify({ tekst: 'Hej' }), { status: 200 }); };
  await sendLyd(LYD, 'audio/mp4', 'b', {}, hent, { vedSendt: () => { sendt++; } });
  assert.equal(sendt, 1);
});

test('afbrydelse udefra giver net', async () => {
  const ctrl = new AbortController();
  const hent = (url, valg) => new Promise((_, afvis) => valg.signal.addEventListener('abort', () => afvis(new DOMException('x', 'AbortError'))));
  const loefte = sendLyd(LYD, 'audio/mp4', 'b', {}, hent, { signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(loefte, (e) => e.type === 'net');
});

test('virker uden AbortSignal.any (iOS 16 og 17.0–17.3)', async () => {
  const any = AbortSignal.any;
  AbortSignal.any = undefined;
  try {
    const hent = async (url, valg) => { assert.ok(valg.signal instanceof AbortSignal); return new Response(JSON.stringify({ tekst: 'Hej' }), { status: 200 }); };
    assert.deepEqual(await sendLyd(LYD, 'audio/mp4', 'b', {}, hent), { tekst: 'Hej' });
    const ctrl = new AbortController();
    const venter = (url, valg) => new Promise((_, afvis) => valg.signal.addEventListener('abort', () => afvis(new DOMException('x', 'AbortError'))));
    const loefte = sendLyd(LYD, 'audio/mp4', 'b', {}, venter, { signal: ctrl.signal });
    ctrl.abort();
    await assert.rejects(loefte, (e) => e.type === 'net');
    assert.ok((await sendReferat({ tekster: ['a'] }, 'b', hent)).tekst);
  } finally {
    AbortSignal.any = any;
  }
});

/** Falsk XMLHttpRequest. haendelser styrer, hvad telefonen melder under upload. */
function falskXhr(haendelser) {
  return class {
    constructor() { this.upload = new EventTarget(); this.status = 0; this.responseText = ''; }
    open() {}
    setRequestHeader() {}
    abort() { this.onabort?.(); }
    send() {
      setTimeout(() => {
        for (const h of haendelser) {
          const { type, ...felter } = h;
          const e = new Event(type);
          Object.assign(e, felter);
          this.upload.dispatchEvent(e);
        }
        this.status = 200;
        this.responseText = JSON.stringify({ tekst: 'Hej' });
        this.onload?.();
      }, 1);
    }
  };
}

for (const [navn, haendelser] of [
  ['upload load', [{ type: 'load' }]],
  ['kun progress til 100 %', [{ type: 'progress', lengthComputable: true, loaded: 10, total: 10 }]],
  ['ingen upload-signaler (som måske på iPhone)', []],
]) {
  test(`vedSendt kaldes præcis én gang, før svaret gives: ${navn}`, async () => {
    const raekke = [];
    const svar = await hentMedFremdrift('/x', { method: 'POST', headers: {}, body: 'lyd', vedSendt: () => raekke.push('sendt') }, falskXhr(haendelser));
    raekke.push('svar');
    assert.deepEqual(raekke, ['sendt', 'svar']);
    assert.equal(svar.status, 200);
  });
}

test('progress under 100 % kalder ikke vedSendt før tid', async () => {
  const raekke = [];
  await hentMedFremdrift('/x', { method: 'POST', headers: {}, body: 'lyd', vedSendt: () => raekke.push('sendt') }, falskXhr([{ type: 'progress', lengthComputable: true, loaded: 5, total: 10 }, { type: 'load' }]));
  assert.deepEqual(raekke, ['sendt']);
});

/** Falsk XMLHttpRequest, der melder upload-fremdrift på bestemte tidspunkter og svarer efter svarEfter ms (eller aldrig). */
function tidsstyretXhr({ fremdrift = [], svarEfter = null }) {
  return class {
    constructor() { this.upload = new EventTarget(); this.status = 0; this.responseText = ''; this.timere = []; }
    open() {}
    setRequestHeader() {}
    abort() { for (const t of this.timere) clearTimeout(t); this.onabort?.(); }
    send() {
      for (const [ms, loaded] of fremdrift) {
        this.timere.push(setTimeout(() => {
          const e = new Event('progress');
          Object.assign(e, { lengthComputable: true, loaded, total: 100 });
          this.upload.dispatchEvent(e);
        }, ms));
      }
      if (svarEfter !== null) {
        this.timere.push(setTimeout(() => {
          this.status = 200;
          this.responseText = JSON.stringify({ tekst: 'Hej' });
          this.onload?.();
        }, svarEfter));
      }
    }
  };
}

const VALG = { method: 'POST', headers: {}, body: 'lyd' };

test('upload, der går i stå, afbrydes, så noten kan prøves igen i stedet for at hænge i 16 minutter', { timeout: 2000 }, async () => {
  const start = Date.now();
  await assert.rejects(
    hentMedFremdrift('/x', { ...VALG, stilleMs: 50 }, tidsstyretXhr({ fremdrift: [[5, 10]] })),
    (e) => e.name === 'AbortError',
  );
  assert.ok(Date.now() - start < 1000);
});

test('upload, der går i stå, giver net fra sendLyd', { timeout: 2000 }, async () => {
  const hent = (url, valg) => hentMedFremdrift(url, { ...valg, stilleMs: 50 }, tidsstyretXhr({ fremdrift: [[5, 10]] }));
  await assert.rejects(sendLyd(LYD, 'audio/mp4', 'b', {}, hent), (e) => e.type === 'net');
});

test('langsom upload, der hele tiden kommer videre, afbrydes ikke', async () => {
  const fremdrift = [[10, 10], [40, 20], [70, 30], [100, 40], [130, 50], [160, 100]];
  const svar = await hentMedFremdrift('/x', { ...VALG, stilleMs: 50 }, tidsstyretXhr({ fremdrift, svarEfter: 400 }));
  assert.equal(svar.status, 200);
});

test('når hele lyden er sendt, venter appen på serveren uden at afbryde', async () => {
  const svar = await hentMedFremdrift('/x', { ...VALG, stilleMs: 50 }, tidsstyretXhr({ fremdrift: [[5, 100]], svarEfter: 300 }));
  assert.equal(svar.status, 200);
});

test('melder telefonen aldrig fremdrift (som måske på iPhone), afbrydes der ikke', async () => {
  const svar = await hentMedFremdrift('/x', { ...VALG, stilleMs: 50 }, tidsstyretXhr({ svarEfter: 300 }));
  assert.equal(svar.status, 200);
});

test('Googles dagsgrænse (503 med kvote) giver kvote, også for referatet af flere dele', async () => {
  const kvote = async () => new Response(JSON.stringify({ fejl: 'kvote' }), { status: 503 });
  await assert.rejects(sendLyd(LYD, 'audio/mp4', 'b', {}, kvote), (e) => e.type === 'kvote');
  await assert.rejects(sendReferat({ tekster: ['A'] }, 'b', kvote), (e) => e.type === 'kvote');
});

test('for lang optagelse (413 med for-lang) giver forLang, ikke kanIkkeBehandles', async () => {
  const forLang = async () => new Response(JSON.stringify({ fejl: 'for-lang' }), { status: 413 });
  await assert.rejects(sendLyd(LYD, 'audio/mp4', 'b', {}, forLang), (e) => e.type === 'forLang');
  const forStor = async () => new Response(JSON.stringify({ fejl: 'kan-ikke-behandles' }), { status: 413 });
  await assert.rejects(sendLyd(LYD, 'audio/mp4', 'b', {}, forStor), (e) => e.type === 'kanIkkeBehandles');
});

test('teksten uden referat gives videre med referatMangler', async () => {
  const svar = await sendLyd(LYD, 'audio/mp4', 'b', {}, async () => Response.json({ tekst: 'Hej', referatMangler: true }));
  assert.deepEqual(svar, { tekst: 'Hej', referatMangler: true });
});

test('vedFremdrift får sendte og samlede bytes, mens lyden sendes', async () => {
  const meldt = [];
  await hentMedFremdrift('/x', { ...VALG, vedFremdrift: (sendt, ialt) => meldt.push([sendt, ialt]) }, tidsstyretXhr({ fremdrift: [[5, 30], [10, 60], [15, 100]], svarEfter: 40 }));
  assert.deepEqual(meldt, [[30, 100], [60, 100], [100, 100]]);
});

test('vedFremdrift kaldes ikke uden kendt størrelse, og en fejl i den stopper ikke afsendelsen', async () => {
  const meldt = [];
  await hentMedFremdrift('/x', { ...VALG, vedFremdrift: (...a) => meldt.push(a) }, falskXhr([{ type: 'progress', lengthComputable: false, loaded: 5, total: 0 }, { type: 'load' }]));
  assert.deepEqual(meldt, []);
  const svar = await hentMedFremdrift('/x', { ...VALG, vedFremdrift: () => { throw new Error('ups'); } }, tidsstyretXhr({ fremdrift: [[5, 50]], svarEfter: 30 }));
  assert.equal(svar.status, 200);
});

test('sendLyd giver vedFremdrift videre', async () => {
  let givet;
  const hent = async (url, valg) => { givet = valg.vedFremdrift; return new Response(JSON.stringify({ tekst: 'Hej' }), { status: 200 }); };
  const vedFremdrift = () => {};
  await sendLyd(LYD, 'audio/mpeg', 'b', { varighedMs: 61_000 }, hent, { vedFremdrift });
  assert.equal(givet, vedFremdrift);
});
