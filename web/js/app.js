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

const login = LOKAL
  ? lavLokalLogin()
  : lavLogin({ msal: window.msal, entra: ENTRA, redirectUri: new URL('./', location.href).href });
const forloeb = lavForloeb({ lager, login, sendLyd, sendMail });
const optager = lavOptager({ lager, medier: browserMedier() });

const app = document.getElementById('app');

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
  return new Date(ms).toLocaleString('da-DK', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
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
  if (efterLogin) localStorage.setItem(EFTER_LOGIN, JSON.stringify(efterLogin));
  try {
    await login.logInd();
  } catch {
    localStorage.removeItem(EFTER_LOGIN);
    visFejl('net');
    tegn();
  }
}

async function optag() {
  if (t.starter || optager.erAktiv()) return;
  t.starter = true;
  t.besked = null;
  try {
    await optager.start();
    t.visning = 'optager';
    t.startTid = Date.now();
    t.advarsel = false;
    urTimer = setInterval(opdaterUr, 1000);
  } catch (e) {
    visFejl(e?.type || 'kanIkkeOptage');
  } finally {
    t.starter = false;
  }
  await opdater();
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

// Optagelsens afslutning

const AFSLUT_BESKEDER = { afbrudt: 'afbrudt', plads: 'pladsMangler', maks: 'maksNaaet', tom: 'tomOptagelse' };

optager.naarAfsluttet(({ id, grund }) => {
  clearInterval(urTimer);
  t.visning = 'start';
  if (AFSLUT_BESKEDER[grund]) visFejl(AFSLUT_BESKEDER[grund]);
  if (grund === 'tom') opdater();
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

// Skærme

function beskedElement() {
  if (!t.besked) return null;
  return h('p', { klasse: `besked ${t.besked.type}`, role: t.besked.type === 'fejl' ? 'alert' : 'status' }, t.besked.tekst);
}

function venter(tekst) {
  return h('p', { klasse: 'venter', role: 'status' }, h('span', { klasse: 'spinner', 'aria-hidden': 'true' }), tekst);
}

function kort(note) {
  const dato = h('p', { klasse: 'dato' }, formaterDato(note.oprettet));

  if (t.igang.has(note.id) || note.status === STATUS.SENDER) {
    return h('section', { klasse: 'kort' }, dato, venter('Transskriberer …'));
  }

  if (note.status === STATUS.TEKST_KLAR) {
    return h('section', { klasse: 'kort' }, dato, h('p', {}, 'Teksten er klar.'), h('button', { vedTryk: () => {
      t.besked = null;
      t.visning = 'tekst';
      t.aabenNote = note.id;
      opdater();
    } }, 'Læs og send'));
  }

  const proevIgen = note.fejlType === 'login'
    ? h('button', { vedTryk: () => logInd({ id: note.id, handling: 'behandl' }) }, 'Log ind og prøv igen')
    : h('button', { vedTryk: () => behandl(note.id, { aabnBagefter: true }) }, 'Prøv igen');

  if (note.status === STATUS.GEMT || note.status === STATUS.OPTAGER) {
    return h('section', { klasse: 'kort' }, dato, h('p', {}, note.afbrudt ? BESKEDER.afbrudt : 'Optagelsen er gemt.'), proevIgen);
  }

  return h(
    'section',
    { klasse: 'kort fejl' },
    dato,
    h('p', {}, BESKEDER[note.fejlType] || BESKEDER.tjeneste),
    h('div', { klasse: 'knapper' }, proevIgen, h('button', { klasse: 'sekundaer', vedTryk: () => slet(note.id) }, 'Slet')),
  );
}

function hjaelpTilHjemmeskaerm() {
  const installeret = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (installeret) return null;
  return h(
    'div',
    { klasse: 'hjaelp' },
    h('p', {}, 'Læg appen på hjemmeskærmen, så dine optagelser ikke bliver slettet af browseren.'),
    h('p', {}, 'iPhone: Del, derefter Føj til hjemmeskærm. Android: Menu, derefter Føj til startskærm.'),
  );
}

function skaermLogin() {
  return [
    h('h1', {}, 'Transskribering'),
    beskedElement(),
    h('p', {}, 'Log ind med din ØLLGAARD-konto for at komme i gang.'),
    h('button', { vedTryk: () => logInd() }, 'Log ind'),
    hjaelpTilHjemmeskaerm(),
  ];
}

function skaermStart() {
  const afventer = t.noter.filter((n) => n.id !== optager.aktivId());
  return [
    h('h1', {}, 'Transskribering'),
    beskedElement(),
    h('button', { klasse: 'optag', vedTryk: optag, disabled: t.starter }, 'Optag'),
    afventer.length ? h('h2', {}, 'Afventer') : null,
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
      h('div', { klasse: 'ur', id: 'ur' }, formaterTid(Date.now() - t.startTid)),
      t.advarsel ? h('p', { klasse: 'advarsel', role: 'alert' }, BESKEDER.snartSlut) : null,
      h('p', {}, 'Hold skærmen tændt, og bliv i appen, mens du optager.'),
      h('button', { vedTryk: () => optager.stop() }, 'Stop'),
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
    ? h('button', { vedTryk: () => logInd({ id: note.id, handling: 'send' }) }, 'Log ind og prøv igen')
    : h('button', { vedTryk: () => sendTilMig(note.id) }, 'Send til mig');
  return [
    h('h1', {}, 'Læs teksten'),
    beskedElement(),
    fejl ? h('p', { klasse: 'besked fejl', role: 'alert' }, fejl) : null,
    note.maaskeSendt ? h('p', { klasse: 'besked fejl', role: 'alert' }, BESKEDER.maaskeSendt) : null,
    h('div', { klasse: 'tekst' }, note.tekst),
    sender
      ? venter('Sender mail …')
      : h(
        'div',
        { klasse: 'knapper' },
        note.maaskeSendt ? h('button', { vedTryk: () => bekraeftSendt(note.id) }, 'Jeg har fået mailen, slet') : null,
        send,
        h('button', { klasse: 'sekundaer', vedTryk: () => {
          t.visning = 'start';
          t.aabenNote = null;
          t.besked = null;
          tegn();
        } }, 'Tilbage'),
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

async function start() {
  await login.init().catch(() => {});
  try {
    t.noter = await forloeb.genoptag();
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
