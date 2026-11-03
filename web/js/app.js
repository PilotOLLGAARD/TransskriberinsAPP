// Kun brugerflade. Logikken ligger i forloeb.js og optager.js.

import { BESKEDER } from './beskeder.js';
import { ENTRA, LOKAL } from './konfig.js';
import { lavForloeb } from './forloeb.js';
import * as lager from './lager.js';
import { lavLogin, lavLokalLogin } from './login.js';
import { sendMail } from './mail.js';
import { LAAS_PRAEFIKS, browserMedier, lavOptager } from './optager.js';
import { STATUS } from './tilstand.js';
import { sendLyd } from './transskribering.js';
import { STANDARD_TYPE, TYPER } from './typer.js';

const EFTER_LOGIN = 'efterLogin';
const SKJUL_FORKLARING = 'skjulForklaring';

// Lageret kan være slået fra i privat tilstand. Så vises forklaringen bare igen.
function husk(noegle, vaerdi) {
  try {
    if (vaerdi) localStorage.setItem(noegle, vaerdi);
    else localStorage.removeItem(noegle);
  } catch { /* Kun en bekvemmelighed. */ }
}

function huskes(noegle) {
  try {
    return Boolean(localStorage.getItem(noegle));
  } catch {
    return false;
  }
}

const login = LOKAL
  ? lavLokalLogin()
  : lavLogin({ msal: window.msal, entra: ENTRA, redirectUri: new URL('./', location.href).href });
const forloeb = lavForloeb({
  lager, login, sendLyd, sendMail,
  aktivAndetSted: async (id) => (await optagelserAndetSted())?.has(id) ?? null,
});
const optager = lavOptager({ lager, medier: browserMedier() });

const app = document.getElementById('app');
const temaFarve = document.querySelector('meta[name="theme-color"]');

const t = {
  visning: 'start', // start | optager | navn | tekst
  noter: [],
  aabenNote: null,
  navnNote: null,
  navnUdkast: null, // det, brugeren har skrevet på navneskærmen, så det overlever en ny tegning
  navnType: null, // typen valgt på navneskærmen; null betyder den, der blev valgt før optagelsen
  valgtNavn: '', // navn og type valgt på startskærmen, til optagelsen er startet
  valgtType: STANDARD_TYPE,
  forklaringSkjult: huskes(SKJUL_FORKLARING),
  besked: null, // { tekst, type: 'fejl' | 'ok' }
  igang: new Set(),
  startTid: 0,
  advarsel: false,
  starter: false,
};

let urTimer = null;

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

async function optag() {
  if (t.starter || optager.erAktiv()) return;
  t.starter = true;
  t.besked = null;
  tegn();
  try {
    await optager.start({ titel: t.valgtNavn.trim(), type: t.valgtType });
    maerkbar();
    // Valget gælder kun denne optagelse. Det ligger nu på noten.
    t.valgtNavn = '';
    t.valgtType = STANDARD_TYPE;
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

async function efterAfsendelse(id) {
  if ((await lager.hentNote(id))?.status === STATUS.SENDT) t.besked = { tekst: `Referatet er sendt til ${login.brugerMail()}.`, type: 'ok' };
  await opdater();
}

/** Laver referatet, hvis det mangler, og mailer det. Bruges af Prøv igen og Send igen. */
async function behandlOgSend(id) {
  t.igang.add(id);
  t.besked = null;
  await opdater().catch(() => {});
  try {
    await forloeb.behandlOgSend(id);
  } finally {
    t.igang.delete(id);
  }
  await efterAfsendelse(id);
}

async function navngivOgSend(id, titel, type) {
  t.visning = 'start';
  t.navnNote = null;
  t.navnUdkast = null;
  t.navnType = null;
  t.besked = null;
  t.igang.add(id);
  await opdater().catch(() => {});
  try {
    await forloeb.navngivOgSend(id, titel, type);
  } finally {
    t.igang.delete(id);
  }
  await efterAfsendelse(id);
}

function aabnNavn(id) {
  t.besked = null;
  t.visning = 'navn';
  t.navnNote = id;
  t.navnUdkast = null;
  t.navnType = null;
  tegn();
}

function visForklaring(vis) {
  t.forklaringSkjult = !vis;
  husk(SKJUL_FORKLARING, vis ? null : '1');
  tegn();
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
  if ((await lager.hentNote(id))?.status === STATUS.SENDT) {
    t.visning = 'start';
    t.aabenNote = null;
    t.besked = { tekst: `Referatet er sendt til ${login.brugerMail()}.`, type: 'ok' };
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
  t.visning = 'start';
  if (AFSLUT_BESKEDER[grund]) visFejl(AFSLUT_BESKEDER[grund]);
  if (grund === 'tom' || grund === 'pladsTom') {
    opdater();
    return;
  }
  // Lyden er gemt. Nu får optagelsen et navn, før den sendes.
  t.visning = 'navn';
  t.navnNote = id;
  t.navnUdkast = null;
  t.navnType = null;
  opdater();
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

/**
 * De fem typer som én valggruppe. Valget skifter på stedet uden ny tegning, så tastaturet
 * og det skrevne navn bliver, hvor de er.
 */
function typeVaelger(valgt, vedValg) {
  const gruppe = h('div', { klasse: 'typer', role: 'radiogroup', 'aria-label': 'Type' });
  for (const { noegle, navn } of TYPER) {
    const valg = h('button', { type: 'button', role: 'radio', 'aria-checked': String(noegle === valgt) }, ikon('tjek'), navn);
    valg.addEventListener('click', () => {
      for (const andet of gruppe.children) andet.setAttribute('aria-checked', String(andet === valg));
      vedValg(noegle);
    });
    gruppe.append(valg);
  }
  return gruppe;
}

function forklaring() {
  if (t.forklaringSkjult) return null;
  return h(
    'section',
    { klasse: 'forklaring-kort', 'aria-labelledby': 'forklaring-titel' },
    h('h2', { id: 'forklaring-titel' }, 'Sådan gør du'),
    h(
      'ol',
      { klasse: 'trin' },
      h('li', {}, 'Vælg type, og skriv evt. et navn.'),
      h('li', {}, 'Tryk Optag, og læg telefonen med skærmen opad.'),
      h('li', {}, 'Tryk Stop. Du får et referat på mail.'),
    ),
    h(
      'dl',
      { klasse: 'typeliste' },
      ...TYPER.filter((x) => x.noegle !== STANDARD_TYPE).flatMap(({ navn, forklaring: tekst }) => [h('dt', {}, navn), h('dd', {}, tekst)]),
    ),
    h('p', { klasse: 'lille' }, 'Vælger du Automatisk, finder appen selv typen.'),
    knap('Skjul forklaringen', () => visForklaring(false), { klasse: 'hvid' }),
  );
}

function startNavn() {
  const felt = h('input', {
    id: 'startnavn',
    klasse: 'navnefelt',
    type: 'text',
    maxlength: '120',
    enterkeyhint: 'done',
    autocomplete: 'off',
    autocapitalize: 'sentences',
    placeholder: 'Fx Møde omkring SAS Lounge',
  });
  felt.value = t.valgtNavn;
  felt.addEventListener('input', () => { t.valgtNavn = felt.value; });
  // Enter lukker tastaturet. Optagelsen startes kun med Optag.
  felt.addEventListener('keydown', (e) => { if (e.key === 'Enter') felt.blur(); });
  return h('div', { klasse: 'felt' }, h('label', { for: 'startnavn', klasse: 'felt-titel' }, 'Navn (valgfrit)'), felt);
}

function kortHoved(note, ikonNavn, ikonKlasse, forklaring) {
  return h(
    'div',
    { klasse: 'kort-hoved' },
    h('span', { klasse: `status-ikon ${ikonKlasse}` }, ikonNavn === 'spinner' ? h('span', { klasse: 'spinner' }) : ikon(ikonNavn)),
    h(
      'div',
      {},
      h('p', { klasse: 'dato' }, note.titel || formaterDato(note.oprettet)),
      note.titel ? h('p', { klasse: 'tid' }, formaterDato(note.oprettet)) : null,
      h('p', { klasse: 'forklaring' }, forklaring),
    ),
  );
}

function kort(note) {
  if (t.igang.has(note.id) || note.status === STATUS.SENDER || note.status === STATUS.SENDER_MAIL) {
    return h('section', { klasse: 'kort' }, kortHoved(note, 'spinner', 'venter', 'Laver referat …'));
  }

  if (note.status === STATUS.TEKST_KLAR) {
    if (note.maaskeSendt) {
      return h(
        'section',
        { klasse: 'kort fejl' },
        kortHoved(note, 'advarsel', 'fejl', BESKEDER.maaskeSendt),
        knap('Læs og send', () => aabnTekst(note.id)),
      );
    }
    const forklaring = note.fejlType === 'mailFejl' ? BESKEDER.mailFejl
      : note.fejlType === 'login' ? BESKEDER.login : 'Referatet er klar.';
    const send = note.fejlType === 'login'
      ? knap('Log ind og prøv igen', () => logInd({ id: note.id, handling: 'send' }), { ikonNavn: 'person' })
      : knap('Send igen', () => behandlOgSend(note.id), { ikonNavn: 'send' });
    return h(
      'section',
      { klasse: note.fejlType ? 'kort fejl' : 'kort' },
      kortHoved(note, note.fejlType ? 'advarsel' : 'tekst', note.fejlType ? 'fejl' : '', forklaring),
      h('div', { klasse: 'knapper' }, send, knap('Læs', () => aabnTekst(note.id), { klasse: 'hvid', ikonNavn: 'tekst' })),
    );
  }

  const proevIgen = note.fejlType === 'login'
    ? knap('Log ind og prøv igen', () => logInd({ id: note.id, handling: 'behandl' }), { ikonNavn: 'person' })
    : knap('Prøv igen', () => behandlOgSend(note.id), { ikonNavn: 'igen' });

  if (note.status === STATUS.GEMT || note.status === STATUS.OPTAGER) {
    const forklaring = note.afbrudt ? BESKEDER.afbrudt : 'Optagelsen er gemt.';
    const handling = note.navngivet ? proevIgen : knap('Navngiv og send', () => aabnNavn(note.id), { ikonNavn: 'send' });
    return h('section', { klasse: 'kort' }, kortHoved(note, 'ur', 'venter', forklaring), handling);
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
        h('p', { klasse: 'undertitel' }, 'Indtal noter, møder og påmindelser. Du får et referat på din egen mail.'),
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
  // Sendte noter venter ikke på noget. De ligger under Tidligere optagelser.
  const afventer = t.noter.filter((n) => n.id !== optager.aktivId() && n.status !== STATUS.SENDT);
  return [
    h('header', { klasse: 'top' }, ordmaerke()),
    h('h1', { klasse: 'titel' }, 'Transskribering'),
    beskedElement(),
    forklaring(),
    h(
      'div',
      { klasse: 'valg' },
      h('p', { klasse: 'felt-titel', 'aria-hidden': 'true' }, 'Type'),
      typeVaelger(t.valgtType, (type) => { t.valgtType = type; }),
      startNavn(),
    ),
    h(
      'div',
      { klasse: 'scene' },
      h('button', { klasse: 'optag', vedTryk: optag, disabled: t.starter }, ikon('mikrofon'), 'Optag'),
      h('p', { klasse: 'hjaelpetekst' }, 'Du får et referat på mail'),
    ),
    afventer.length ? h('h2', { klasse: 'sektion-titel' }, 'Afventer') : null,
    afventer.length ? h('div', { klasse: 'liste' }, ...afventer.map(kort)) : null,
    t.forklaringSkjult ? knap('Vis forklaring', () => visForklaring(true), { klasse: 'hvid' }) : null,
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
        h('p', {}, 'Lad skærmen være tændt — læg telefonen med skærmen opad'),
      ),
      h('button', { klasse: 'stop', vedTryk: stop }, h('span', { klasse: 'firkant', 'aria-hidden': 'true' }), 'Stop'),
    ),
  ];
}

/** Referatet, som det står i mailen. Noter fra før referaterne viser den rå tekst. */
function referatVisning(note) {
  const r = note.referat;
  if (!r) return h('div', { klasse: 'tekst' }, note.tekst);
  if (r.kort) return h('div', { klasse: 'tekst' }, r.renTekst);
  return h(
    'div',
    { klasse: 'tekst' },
    r.opsummering ? h('p', {}, r.opsummering) : null,
    r.hovedpunkter?.length ? h('ul', {}, ...r.hovedpunkter.map((p) => h('li', {}, p))) : null,
  );
}

function skaermNavn() {
  const note = t.noter.find((n) => n.id === t.navnNote);
  if (!note) {
    t.visning = 'start';
    return skaermStart();
  }
  const felt = h('input', {
    id: 'titel',
    klasse: 'navnefelt',
    type: 'text',
    maxlength: '120',
    enterkeyhint: 'send',
    autocomplete: 'off',
    autocapitalize: 'sentences',
    placeholder: 'Fx Møde omkring SAS Lounge',
  });
  felt.value = t.navnUdkast ?? note.titel ?? '';
  felt.addEventListener('input', () => { t.navnUdkast = felt.value; });
  const form = h(
    'form',
    { klasse: 'navn' },
    h('label', { for: 'titel', klasse: 'navn-titel' }, 'Hvad handler optagelsen om?'),
    felt,
    h('p', { klasse: 'hjaelpetekst' }, 'Valgfrit. Er feltet tomt, finder appen selv på en titel.'),
    h('p', { klasse: 'felt-titel', 'aria-hidden': 'true' }, 'Type'),
    typeVaelger(t.navnType ?? note.type ?? STANDARD_TYPE, (type) => { t.navnType = type; }),
    h('button', { type: 'submit' }, ikon('send'), 'Send'),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    navngivOgSend(note.id, felt.value, t.navnType ?? note.type);
  });
  return [h('header', { klasse: 'top' }, ordmaerke()), beskedElement(), form];
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
      h('h1', { klasse: 'titel' }, note.titel || 'Teksten'),
      h('p', { klasse: 'undertitel' }, formaterDato(note.oprettet)),
      beskedElement(),
      fejl ? advarsel(fejl) : null,
      note.maaskeSendt ? advarsel(BESKEDER.maaskeSendt) : null,
      referatVisning(note),
    ),
    h(
      'div',
      { klasse: 'vaerktoej' },
      ...(sender
        ? [venter('Sender mail …')]
        : [
          note.maaskeSendt ? knap('Jeg har fået mailen', () => bekraeftSendt(note.id), { klasse: 'tonet', ikonNavn: 'tjek' }) : null,
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
  else if (t.visning === 'navn') indhold = skaermNavn();
  // Kontoen kan være væk efter en koldstart. Optagelse skal stadig kunne startes, også uden net.
  else if (!login.harVaeretLoggetInd() && t.noter.length === 0) indhold = skaermLogin();
  else indhold = skaermStart();
  temaFarve?.setAttribute('content', t.visning === 'optager' ? '#0f1a26' : '#f3f5f8');
  // En note, der bliver færdig i baggrunden, tegner skærmen på ny. Skriver brugeren, skal feltet beholde fokus.
  const aktivt = document.activeElement?.tagName === 'INPUT' ? document.activeElement : null;
  const markering = aktivt && [aktivt.id, aktivt.selectionStart, aktivt.selectionEnd];
  app.replaceChildren(...indhold.filter(Boolean));
  // Tastaturet åbnes med det samme, så navnet kan skrives med én hånd.
  if (t.visning === 'navn') document.getElementById('titel')?.focus();
  else if (markering) {
    const [id, fra, til] = markering;
    const felt = document.getElementById(id);
    if (felt) {
      felt.focus();
      felt.setSelectionRange(fra, til);
    }
  }
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
    await behandlOgSend(id);
  }
}

/** Optagelser, der kører i en anden fane eller i den installerede app. null, når det ikke kan ses. */
async function optagelserAndetSted() {
  if (!navigator.locks?.query) return null;
  try {
    const { held = [] } = await navigator.locks.query();
    return new Set(held.map((l) => l.name).filter((n) => n?.startsWith(LAAS_PRAEFIKS)).map((n) => n.slice(LAAS_PRAEFIKS.length)));
  } catch {
    return null;
  }
}

async function start() {
  await login.init().catch(() => {});
  try {
    t.noter = await forloeb.genoptag(optagelserAndetSted);
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
