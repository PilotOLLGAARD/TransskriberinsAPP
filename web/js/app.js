// Kun brugerflade. Logikken ligger i forloeb.js og optager.js.

import { BESKEDER } from './beskeder.js';
import { ENTRA, LOKAL } from './konfig.js';
import { lavForloeb } from './forloeb.js';
import * as lager from './lager.js';
import { lavLogin, lavLokalLogin } from './login.js';
import { sendMail } from './mail.js';
import { browserMedier, lavOptager } from './optager.js';
import { STATUS } from './tilstand.js';
import { sendLyd } from './transskribering.js';

const EFTER_LOGIN = 'efterLogin';
const LAAS = 'optag-';

const login = LOKAL
  ? lavLokalLogin()
  : lavLogin({ msal: window.msal, entra: ENTRA, redirectUri: new URL('./', location.href).href });
const forloeb = lavForloeb({ lager, login, sendLyd, sendMail });
const optager = lavOptager({ lager, medier: browserMedier() });

const app = document.getElementById('app');
const temaFarve = document.querySelector('meta[name="theme-color"]');

const t = {
  visning: 'start', // start | optager | tekst
  noter: [],
  aabenNote: null,
  besked: null, // { tekst, type: 'fejl' | 'ok' }
  igang: new Set(),
  startTid: 0,
  advarsel: false,
  starter: false,
};

let urTimer = null;
const frigivLaas = new Map();

// Ikoner tegnet som streger, i samme stil som telefonens egne.
const IKONER = {
  mikrofon: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/>',
  send: '<path d="M21 3 10.5 13.5"/><path d="M21 3l-6.5 18-4-7.5L3 9.5z"/>',
  igen: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
  slet: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  advarsel: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  tjek: '<path d="M4.5 12.5l5 5L19.5 7"/>',
  tekst: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  ur: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  del: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11v9h12v-9"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  tilbage: '<path d="M15 5l-7 7 7 7"/>',
};

function ikon(navn) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '2');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = IKONER[navn];
  return el;
}

function h(navn, egenskaber = {}, ...boern) {
  const el = document.createElement(navn);
  for (const [k, v] of Object.entries(egenskaber)) {
    if (k === 'vedTryk') el.addEventListener('click', v);
    else if (k === 'klasse') el.className = v;
    else if (v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...boern.filter((b) => b !== null && b !== undefined));
  return el;
}

function formaterTid(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  return `${mm}:${String(s % 60).padStart(2, '0')}`;
}

function formaterDato(ms) {
  const dato = new Date(ms);
  const idag = new Date();
  const klokken = dato.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
  if (dato.toDateString() === idag.toDateString()) return `I dag kl. ${klokken}`;
  return `${dato.toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'short' })} kl. ${klokken}`;
}

// Kort vibration på Android ved start og stop. iPhone understøtter det ikke.
function maerkbar() {
  navigator.vibrate?.(12);
}

async function opdater() {
  t.noter = await lager.alleNoter();
  tegn();
}

function visFejl(noegle) {
  t.besked = { tekst: BESKEDER[noegle], type: 'fejl' };
}

// Handlinger

async function logInd(efterLogin) {
  if (!navigator.onLine) {
    visFejl('loginKraeverNet');
    tegn();
    return;
  }
  if (efterLogin) localStorage.setItem(EFTER_LOGIN, JSON.stringify(efterLogin));
  try {
    await login.logInd();
  } catch {
    localStorage.removeItem(EFTER_LOGIN);
    visFejl('net');
    tegn();
  }
}

function holdLaas(id) {
  // Fortæller andre faner og den installerede app, at optagelsen kører her.
  navigator.locks?.request(LAAS + id, () => new Promise((frigiv) => frigivLaas.set(id, frigiv))).catch(() => {});
}

async function optag() {
  if (t.starter || optager.erAktiv()) return;
  t.starter = true;
  t.besked = null;
  tegn();
  try {
    const id = await optager.start();
    holdLaas(id);
    maerkbar();
    if (optager.erAktiv()) {
      t.visning = 'optager';
      t.startTid = Date.now();
      t.advarsel = false;
      urTimer = setInterval(opdaterUr, 1000);
    }
  } catch (e) {
    visFejl(e?.type || 'kanIkkeOptage');
  } finally {
    t.starter = false;
  }
  await opdater();
}

async function stop() {
  maerkbar();
  await optager.stop();
}

async function behandl(id, { aabnBagefter = false } = {}) {
  t.igang.add(id);
  await opdater().catch(() => {});
  try {
    await forloeb.behandl(id);
  } finally {
    t.igang.delete(id);
  }
  const note = await lager.hentNote(id);
  if (aabnBagefter && note?.status === STATUS.TEKST_KLAR && t.visning === 'start') {
    t.visning = 'tekst';
    t.aabenNote = id;
  }
  await opdater();
}

async function sendTilMig(id) {
  t.igang.add(id);
  t.besked = null;
  await opdater().catch(() => {});
  try {
    await forloeb.sendTilMig(id);
  } finally {
    t.igang.delete(id);
  }
  if (!(await lager.hentNote(id))) {
    t.visning = 'start';
    t.aabenNote = null;
    t.besked = { tekst: `Mailen er sendt til ${login.brugerMail()}.`, type: 'ok' };
  }
  await opdater();
}

async function bekraeftSendt(id) {
  await forloeb.bekraeftSendt(id);
  t.visning = 'start';
  t.aabenNote = null;
  t.besked = null;
  await opdater();
}

async function slet(id) {
  if (!confirm('Slet optagelsen? Den kan ikke hentes igen.')) return;
  await forloeb.slet(id);
  await opdater();
}

function aabnTekst(id) {
  t.besked = null;
  t.visning = 'tekst';
  t.aabenNote = id;
  opdater();
}

function tilbage() {
  t.visning = 'start';
  t.aabenNote = null;
  t.besked = null;
  tegn();
}

// Optagelsens afslutning

const AFSLUT_BESKEDER = {
  afbrudt: 'afbrudt',
  plads: 'pladsMangler',
  pladsTom: 'pladsTom',
  maks: 'maksNaaet',
  tom: 'tomOptagelse',
};

optager.naarAfsluttet(({ id, grund }) => {
  clearInterval(urTimer);
  frigivLaas.get(id)?.();
  frigivLaas.delete(id);
  t.visning = 'start';
  if (AFSLUT_BESKEDER[grund]) visFejl(AFSLUT_BESKEDER[grund]);
  if (grund === 'tom' || grund === 'pladsTom') opdater();
  else behandl(id, { aabnBagefter: true });
});

optager.naarAdvaret(() => {
  t.advarsel = true;
  tegn();
});

function opdaterUr() {
  const ur = document.getElementById('ur');
  if (ur) ur.textContent = formaterTid(Date.now() - t.startTid);
}

// Byggeklodser

function ordmaerke() {
  return h('img', { klasse: 'ordmaerke', src: 'ordmaerke.svg', alt: 'ØLLGAARD' });
}

function beskedElement() {
  if (!t.besked) return null;
  const fejl = t.besked.type === 'fejl';
  return h(
    'p',
    { klasse: `besked ${t.besked.type}`, role: fejl ? 'alert' : 'status' },
    ikon(fejl ? 'advarsel' : 'tjek'),
    h('span', {}, t.besked.tekst),
  );
}

function venter(tekst) {
  return h('p', { klasse: 'venter', role: 'status' }, h('span', { klasse: 'spinner', 'aria-hidden': 'true' }), tekst);
}

function knap(tekst, vedTryk, { klasse, ikonNavn } = {}) {
  return h('button', { klasse, vedTryk }, ikonNavn ? ikon(ikonNavn) : null, tekst);
}

function kortHoved(note, ikonNavn, ikonKlasse, forklaring) {
  return h(
    'div',
    { klasse: 'kort-hoved' },
    h('span', { klasse: `status-ikon ${ikonKlasse}` }, ikonNavn === 'spinner' ? h('span', { klasse: 'spinner' }) : ikon(ikonNavn)),
    h('div', {}, h('p', { klasse: 'dato' }, formaterDato(note.oprettet)), h('p', { klasse: 'forklaring' }, forklaring)),
  );
}

function kort(note) {
  if (t.igang.has(note.id) || note.status === STATUS.SENDER) {
    return h('section', { klasse: 'kort' }, kortHoved(note, 'spinner', 'venter', 'Transskriberer …'));
  }

  if (note.status === STATUS.TEKST_KLAR) {
    return h(
      'section',
      { klasse: 'kort' },
      kortHoved(note, 'tekst', '', 'Teksten er klar.'),
      knap('Læs og send', () => aabnTekst(note.id)),
    );
  }

  const proevIgen = note.fejlType === 'login'
    ? knap('Log ind og prøv igen', () => logInd({ id: note.id, handling: 'behandl' }), { ikonNavn: 'person' })
    : knap('Prøv igen', () => behandl(note.id, { aabnBagefter: true }), { ikonNavn: 'igen' });

  if (note.status === STATUS.GEMT || note.status === STATUS.OPTAGER) {
    const forklaring = note.afbrudt ? BESKEDER.afbrudt : 'Optagelsen er gemt.';
    return h('section', { klasse: 'kort' }, kortHoved(note, 'ur', 'venter', forklaring), proevIgen);
  }

  return h(
    'section',
    { klasse: 'kort fejl' },
    kortHoved(note, 'advarsel', 'fejl', BESKEDER[note.fejlType] || BESKEDER.tjeneste),
    h('div', { klasse: 'knapper' }, proevIgen, knap('Slet', () => slet(note.id), { klasse: 'slet', ikonNavn: 'slet' })),
  );
}

function hjaelpTilHjemmeskaerm() {
  const installeret = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (installeret) return null;
  return h(
    'aside',
    { klasse: 'hjaelp' },
    ikon('del'),
    h(
      'div',
      {},
      h('p', {}, 'Læg appen på hjemmeskærmen, så dine optagelser ikke bliver slettet af browseren.'),
      h('p', {}, 'iPhone: Del, derefter Føj til hjemmeskærm. Android: Menu, derefter Føj til startskærm.'),
    ),
  );
}

// Skærme

function skaermLogin() {
  return [
    h(
      'div',
      { klasse: 'login' },
      h(
        'div',
        { klasse: 'login-midte' },
        ordmaerke(),
        h('h1', {}, 'Transskribering'),
        h('p', { klasse: 'undertitel' }, 'Indtal noter på byggepladsen. Teksten sendes til din egen mail.'),
        beskedElement(),
      ),
      h(
        'div',
        { klasse: 'noegle' },
        knap('Log ind', () => logInd(), { ikonNavn: 'person' }),
        h('p', { klasse: 'lille' }, 'Med din ØLLGAARD-konto'),
        hjaelpTilHjemmeskaerm(),
      ),
    ),
  ];
}

function skaermStart() {
  const afventer = t.noter.filter((n) => n.id !== optager.aktivId());
  return [
    h('header', { klasse: 'top' }, ordmaerke()),
    h('h1', { klasse: 'titel' }, 'Transskribering'),
    beskedElement(),
    h(
      'div',
      { klasse: 'scene' },
      h('button', { klasse: 'optag', vedTryk: optag, disabled: t.starter }, ikon('mikrofon'), 'Optag'),
      h('p', { klasse: 'hjaelpetekst' }, 'Tryk for at indtale en note'),
    ),
    afventer.length ? h('h2', { klasse: 'sektion-titel' }, 'Afventer') : null,
    afventer.length ? h('div', { klasse: 'liste' }, ...afventer.map(kort)) : null,
    hjaelpTilHjemmeskaerm(),
  ];
}

function skaermOptager() {
  return [
    h(
      'div',
      { klasse: 'optager' },
      h('h1', { role: 'status' }, h('span', { klasse: 'prik', 'aria-hidden': 'true' }), 'Optager'),
      h(
        'div',
        { klasse: 'ur-felt' },
        h('div', { klasse: 'ur', id: 'ur' }, formaterTid(Date.now() - t.startTid)),
        t.advarsel ? h('p', { klasse: 'advarsel', role: 'alert' }, BESKEDER.snartSlut) : null,
        h('p', {}, 'Hold skærmen tændt, og bliv i appen, mens du optager.'),
      ),
      h('button', { klasse: 'stop', vedTryk: stop }, h('span', { klasse: 'firkant', 'aria-hidden': 'true' }), 'Stop'),
    ),
  ];
}

function skaermTekst() {
  const note = t.noter.find((n) => n.id === t.aabenNote);
  if (!note) {
    t.visning = 'start';
    return skaermStart();
  }
  const sender = t.igang.has(note.id) || note.status === STATUS.SENDER_MAIL;
  const fejl = note.fejlType === 'login' ? BESKEDER.login : note.fejlType === 'mailFejl' ? BESKEDER.mailFejl : null;
  const send = note.fejlType === 'login'
    ? knap('Log ind og prøv igen', () => logInd({ id: note.id, handling: 'send' }), { ikonNavn: 'person' })
    : knap('Send til mig', () => sendTilMig(note.id), { ikonNavn: 'send' });
  const advarsel = (tekst) => h('p', { klasse: 'besked fejl', role: 'alert' }, ikon('advarsel'), h('span', {}, tekst));
  return [
    h(
      'div',
      { klasse: 'tekst-skaerm' },
      h('header', { klasse: 'top' }, ordmaerke()),
      h('h1', { klasse: 'titel' }, 'Teksten'),
      h('p', { klasse: 'undertitel' }, formaterDato(note.oprettet)),
      beskedElement(),
      fejl ? advarsel(fejl) : null,
      note.maaskeSendt ? advarsel(BESKEDER.maaskeSendt) : null,
      h('div', { klasse: 'tekst' }, note.tekst),
    ),
    h(
      'div',
      { klasse: 'vaerktoej' },
      ...(sender
        ? [venter('Sender mail …')]
        : [
          note.maaskeSendt ? knap('Jeg har fået mailen, slet', () => bekraeftSendt(note.id), { klasse: 'tonet', ikonNavn: 'tjek' }) : null,
          send,
          knap('Tilbage', tilbage, { klasse: 'hvid', ikonNavn: 'tilbage' }),
        ]),
    ),
  ];
}

function tegn() {
  let indhold;
  if (t.visning === 'optager') indhold = skaermOptager();
  else if (t.visning === 'tekst') indhold = skaermTekst();
  // Kontoen kan være væk efter en koldstart. Optagelse skal stadig kunne startes, også uden net.
  else if (!login.harVaeretLoggetInd() && t.noter.length === 0) indhold = skaermLogin();
  else indhold = skaermStart();
  temaFarve?.setAttribute('content', t.visning === 'optager' ? '#0f1a26' : '#f3f5f8');
  app.replaceChildren(...indhold.filter(Boolean));
}

// Start

async function genoptagEfterLogin() {
  const raa = localStorage.getItem(EFTER_LOGIN);
  if (!raa || !login.harKonto()) return;
  localStorage.removeItem(EFTER_LOGIN);
  const { id, handling } = JSON.parse(raa);
  if (handling === 'send') {
    const note = await lager.hentNote(id);
    if (!note) return;
    await lager.opdaterNote(id, { fejlType: undefined });
    t.visning = 'tekst';
    t.aabenNote = id;
    // En mulig dobbelt mail skal brugeren selv tage stilling til.
    if (note.maaskeSendt) await opdater();
    else await sendTilMig(id);
  } else {
    await behandl(id, { aabnBagefter: true });
  }
}

async function optagelserAndetSted() {
  try {
    const { held = [] } = (await navigator.locks?.query()) ?? {};
    return new Set(held.map((l) => l.name).filter((n) => n?.startsWith(LAAS)).map((n) => n.slice(LAAS.length)));
  } catch {
    return new Set();
  }
}

async function start() {
  await login.init().catch(() => {});
  try {
    t.noter = await forloeb.genoptag(await optagelserAndetSted());
  } catch {
    t.noter = [];
  }
  tegn();
  document.body.dataset.klar = '1';
  // Beder telefonen om ikke at slette optagelserne. Afgøres af telefonen.
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  await genoptagEfterLogin();
}

start();
