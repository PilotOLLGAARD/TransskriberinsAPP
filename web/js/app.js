// Kun brugerflade. Logikken ligger i forloeb.js og optager.js.

import { BESKEDER } from './beskeder.js';
import { ENTRA, LOKAL } from './konfig.js';
import { lavForloeb } from './forloeb.js';
import * as lager from './lager.js';
import { lavLogin, lavLokalLogin } from './login.js';
import { sendMail } from './mail.js';
import { LAAS_PRAEFIKS, bedOmTilladelse, browserMedier, lavOptager, visAdvarsel } from './optager.js';
import { FORTRYD_MS, STATUS, slettesOm } from './tilstand.js';
import { sendLyd, sendReferat } from './transskribering.js';
import { typeNavn } from './typer.js';

const EFTER_LOGIN = 'efterLogin';

const login = LOKAL
  ? lavLokalLogin()
  : lavLogin({ msal: window.msal, entra: ENTRA, redirectUri: new URL('./', location.href).href });
const forloeb = lavForloeb({
  lager, login, sendLyd, sendMail, sendReferat,
  aktivAndetSted: async (id) => (await optagelserAndetSted())?.has(id) ?? null,
  // Fremdriften vises på skærmen efter Send.
  vedAendring: () => { opdater().catch(() => {}); },
});
const optager = lavOptager({ lager, medier: browserMedier() });

const app = document.getElementById('app');
const temaFarve = document.querySelector('meta[name="theme-color"]');

const t = {
  visning: 'start', // start | optager | navn | tekst
  noter: [],
  aabenNote: null,
  fraVisning: 'start', // skærmen, Læs vender tilbage til
  fremdriftNote: null, // noten, skærmen efter Send viser
  fortryd: null, // { id, tekst, timer } mens en sletning kan fortrydes
  navnNote: null,
  navnUdkast: null, // det, brugeren har skrevet på navneskærmen, så det overlever en ny tegning
  valgtNavn: '', // navnet skrevet på startskærmen, til optagelsen er startet
  besked: null, // { tekst, type: 'fejl' | 'ok' }
  igang: new Set(),
  startTid: 0,
  advarsel: false,
  starter: false,
  loginStatus: null, // 'ja' | 'nej' | null (ukendt). Login-boksen vises kun ved 'nej'.
  fornyer: false, // under et stille skift til Microsoft kan Optag ikke trykkes
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
  liste: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/>',
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
  // Noter, der er ved at blive slettet, vises ikke. De kan stadig fortrydes.
  t.noter = (await lager.alleNoter()).filter((n) => !n.slettet);
  // En afsendelse, der fejlede på login, betyder, at man ikke er logget ind. En mulig dobbelt mail tæller ikke:
  // den venter på brugerens eget valg.
  if (t.noter.some((n) => n.fejlType === 'login' && !n.maaskeSendt)) t.loginStatus = 'nej';
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
  if (t.starter || t.fornyer || optager.erAktiv()) return;
  // Første gang: lov til at give besked, hvis optagelsen stopper. Venter ikke, så optagelsen starter straks.
  bedOmTilladelse();
  t.starter = true;
  t.besked = null;
  tegn();
  try {
    nyDelStartet(await optager.start({ titel: t.valgtNavn.trim() }));
    maerkbar();
    // Navnet gælder kun denne optagelse. Det ligger nu på noten.
    t.valgtNavn = '';
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

/** Optager en ny del på en afbrudt note. Navnet fra navneskærmen gemmes først. */
async function fortsaetOptagelse(id) {
  if (t.starter || optager.erAktiv()) return;
  bedOmTilladelse();
  t.starter = true;
  t.besked = null;
  try {
    if (t.visning === 'navn' && t.navnNote === id && t.navnUdkast !== null) {
      await lager.opdaterNote(id, { titel: [...t.navnUdkast.trim()].slice(0, 120).join('').trim() });
    }
    const note = await lager.hentNote(id);
    await optager.fortsaet(id);
    nyDelStartet(id);
    maerkbar();
    if (optager.erAktiv()) {
      t.visning = 'optager';
      // Uret fortsætter fra den samlede tid.
      t.startTid = Date.now() - (note?.varighedMs ?? 0);
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

function fortsaetKnap(id) {
  // type=button, så knappen ikke sender navneskærmens formular.
  return h('button', { type: 'button', klasse: 'tonet', vedTryk: () => fortsaetOptagelse(id), disabled: t.starter }, ikon('mikrofon'), 'Fortsæt optagelsen');
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

async function navngivOgSend(id, titel) {
  t.visning = 'fremdrift';
  t.fremdriftNote = id;
  t.navnNote = null;
  t.navnUdkast = null;
  t.besked = null;
  t.igang.add(id);
  await opdater().catch(() => {});
  try {
    await forloeb.navngivOgSend(id, titel);
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
  tegn();
}

/** Logger kun ud af appen. Optagelser på telefonen bliver liggende. */
async function logUd() {
  await login.logUd().catch(() => {});
  t.loginStatus = 'nej';
  t.visning = 'start';
  tegn();
}

function aabnInformation() {
  t.besked = null;
  t.visning = 'information';
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

/** Sender en sendt notes referat igen fra telefonen. */
async function sendIgen(id) {
  t.igang.add(id);
  t.besked = null;
  await opdater().catch(() => {});
  const foer = (await lager.hentNote(id))?.sendtIgen;
  try {
    await forloeb.sendIgen(id);
  } finally {
    t.igang.delete(id);
  }
  const note = await lager.hentNote(id);
  if (note?.sendtIgen && note.sendtIgen !== foer) {
    t.besked = { tekst: `Referatet er sendt igen til ${login.brugerMail()}.`, type: 'ok' };
  }
  await opdater();
}

function tilForsiden() {
  t.visning = 'start';
  t.fremdriftNote = null;
  t.besked = null;
  tegn();
}

function aabnTidligere() {
  t.besked = null;
  t.visning = 'tidligere';
  opdater();
}

async function bekraeftSendt(id) {
  await forloeb.bekraeftSendt(id);
  t.visning = 'start';
  t.aabenNote = null;
  t.besked = null;
  await opdater();
}

/** Sletter med det samme, men kan fortrydes i FORTRYD_MS. Stopper en afsendelse, der er i gang. */
async function sletOptagelse(id) {
  const note = t.noter.find((n) => n.id === id);
  const tekst = note?.status === STATUS.SENDT ? 'Optagelsen er slettet.' : 'Optagelsen er slettet og bliver aldrig sendt.';
  // En tidligere sletning, der stadig kunne fortrydes, bliver endelig nu.
  if (t.fortryd) {
    clearTimeout(t.fortryd.timer);
    forloeb.endeligSlet(t.fortryd.id).catch(() => {});
  }
  await forloeb.slet(id);
  t.besked = null;
  t.fortryd = { id, tekst, timer: setTimeout(() => sletEndeligt(id), FORTRYD_MS) };
  visFortrydBjaelke();
  await opdater();
}

async function sletEndeligt(id) {
  if (t.fortryd?.id === id) {
    t.fortryd = null;
    fjernFortrydBjaelke();
  }
  await forloeb.endeligSlet(id).catch(() => {});
  await opdater();
}

async function fortrydSletning() {
  if (!t.fortryd) return;
  const { id, timer } = t.fortryd;
  clearTimeout(timer);
  t.fortryd = null;
  fjernFortrydBjaelke();
  await forloeb.fortrydSlet(id);
  await opdater();
}

// Ligger uden for #app, så den ikke laves om (og glider ind igen), hver gang skærmen tegnes.
let bjaelke = null;

function visFortrydBjaelke() {
  bjaelke?.remove();
  bjaelke = h('div', { klasse: 'toast', role: 'status' }, h('span', {}, t.fortryd.tekst), h('button', { type: 'button', vedTryk: fortrydSletning }, 'Fortryd'));
  document.body.append(bjaelke);
}

function fjernFortrydBjaelke() {
  bjaelke?.remove();
  bjaelke = null;
}

function aabnTekst(id) {
  t.besked = null;
  t.fraVisning = t.visning === 'tidligere' ? 'tidligere' : 'start';
  t.visning = 'tekst';
  t.aabenNote = id;
  opdater();
}

function tilbage() {
  t.visning = t.visning === 'tekst' ? t.fraVisning : 'start';
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
  if (grund === 'afbrudt') {
    sidstAfbrudt = { id, tid: Date.now() };
    if (document.visibilityState === 'hidden') advarStoppet(id);
  } else {
    sidstAfbrudt = null;
  }
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

/** Toppen på skærme, man kan gå tilbage fra. Samme sted og udseende overalt. */
function topMedTilbage(vedTryk) {
  return h(
    'header',
    { klasse: 'top' },
    h('button', { type: 'button', klasse: 'top-knap tilbage-knap', vedTryk }, ikon('tilbage'), 'Tilbage'),
    ordmaerke(),
  );
}

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
  return h('div', { klasse: 'felt start-navn' }, h('label', { for: 'startnavn', klasse: 'felt-titel' }, 'Navn (valgfrit)'), felt);
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

/** Handlinger øverst, derefter Læs og Slet ved siden af hinanden. Slet findes på alle kort. */
function kortKnapper(note, handlinger, laes) {
  return h(
    'div',
    { klasse: 'knapper' },
    ...handlinger,
    h(
      'div',
      { klasse: 'knap-raekke' },
      laes ? knap('Læs', () => aabnTekst(note.id), { klasse: 'hvid', ikonNavn: 'tekst' }) : null,
      knap('Slet', () => sletOptagelse(note.id), { klasse: 'slet', ikonNavn: 'slet' }),
    ),
  );
}

/** Forklaring og knapper for en note, der ikke er sendt. Bruges i Afventer og Tidligere optagelser. */
function kortIndhold(note) {
  if (t.igang.has(note.id) || note.status === STATUS.SENDER || note.status === STATUS.SENDER_MAIL) {
    return { klasse: 'kort', ikonNavn: 'spinner', ikonKlasse: 'venter', forklaring: 'Laver referat …', handlinger: [], laes: false };
  }

  if (note.status === STATUS.TEKST_KLAR) {
    if (note.maaskeSendt) {
      return {
        klasse: 'kort fejl', ikonNavn: 'advarsel', ikonKlasse: 'fejl', forklaring: BESKEDER.maaskeSendt,
        handlinger: [knap('Læs og send', () => aabnTekst(note.id))], laes: false,
      };
    }
    const forklaring = note.fejlType === 'mailFejl' ? BESKEDER.mailFejl
      : note.fejlType === 'login' ? BESKEDER.login : 'Referatet er klar.';
    const send = note.fejlType === 'login'
      ? knap('Log ind og prøv igen', () => logInd({ id: note.id, handling: 'send' }), { ikonNavn: 'person' })
      : knap('Send igen', () => behandlOgSend(note.id), { ikonNavn: 'send' });
    return {
      klasse: note.fejlType ? 'kort fejl' : 'kort',
      ikonNavn: note.fejlType ? 'advarsel' : 'tekst',
      ikonKlasse: note.fejlType ? 'fejl' : '',
      forklaring,
      handlinger: [send],
      laes: true,
    };
  }

  const proevIgen = note.fejlType === 'login'
    ? knap('Log ind og prøv igen', () => logInd({ id: note.id, handling: 'behandl' }), { ikonNavn: 'person' })
    : knap('Prøv igen', () => behandlOgSend(note.id), { ikonNavn: 'igen' });

  if (note.status === STATUS.GEMT || note.status === STATUS.OPTAGER) {
    const send = note.navngivet ? proevIgen : knap('Navngiv og send', () => aabnNavn(note.id), { ikonNavn: 'send' });
    const kanFortsaette = note.status === STATUS.GEMT && note.afbrudt;
    return {
      klasse: 'kort', ikonNavn: 'ur', ikonKlasse: 'venter',
      forklaring: note.afbrudt ? BESKEDER.afbrudt : 'Optagelsen er gemt.',
      handlinger: kanFortsaette ? [fortsaetKnap(note.id), send] : [send],
      laes: false,
    };
  }

  return {
    klasse: 'kort fejl', ikonNavn: 'advarsel', ikonKlasse: 'fejl',
    forklaring: BESKEDER[note.fejlType] || BESKEDER.tjeneste,
    handlinger: [proevIgen],
    laes: false,
  };
}

function kort(note) {
  const k = kortIndhold(note);
  return h('section', { klasse: k.klasse }, kortHoved(note, k.ikonNavn, k.ikonKlasse, k.forklaring), kortKnapper(note, k.handlinger, k.laes));
}

function klokken(ms) {
  return new Date(ms).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' }).replace(':', '.');
}

function formaterVarighed(ms) {
  if (!Number.isFinite(ms)) return null;
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} sek` : `${Math.round(s / 60)} min`;
}

/** Sendt, Venter eller Fejlet. Ikon og tekst, så status ikke kun vises med farve. */
function statusFor(note) {
  if (note.status === STATUS.SENDT) return { tekst: 'Sendt', klasse: 'ok', ikonNavn: 'tjek' };
  if (note.status === STATUS.FEJL || note.fejlType) return { tekst: 'Fejlet', klasse: 'fejl', ikonNavn: 'advarsel' };
  return { tekst: 'Venter', klasse: 'venter', ikonNavn: 'ur' };
}

function sletteTekst(note) {
  const dage = slettesOm(note, Date.now());
  if (dage === null) return 'Slettes ikke, før den er sendt';
  if (dage === 0) return 'Slettes i dag';
  return dage === 1 ? 'Slettes om 1 dag' : `Slettes om ${dage} dage`;
}

function sendtKnapper(note) {
  const send = t.igang.has(note.id) ? venter('Sender mail …')
    : note.fejlType === 'login'
      ? knap('Log ind og prøv igen', () => logInd({ id: note.id, handling: 'sendIgen' }), { ikonNavn: 'person' })
      : knap('Send referat igen', () => sendIgen(note.id), { ikonNavn: 'send' });
  return kortKnapper(note, [send], true);
}

function historikKort(note) {
  const status = statusFor(note);
  const sendt = note.status === STATUS.SENDT;
  const indhold = sendt ? null : kortIndhold(note);
  const advarsel = sendt
    ? (note.maaskeSendt ? BESKEDER.maaskeSendt : note.fejlType === 'login' ? BESKEDER.login : note.fejlType ? BESKEDER.mailFejl : null)
    : indhold.forklaring;
  // Typen, AI'en valgte. Før afsendelsen er der ingen.
  const type = typeNavn(note.type);
  return h(
    'section',
    { klasse: `kort historik${status.klasse === 'fejl' ? ' fejl' : ''}` },
    h(
      'div',
      { klasse: 'historik-top' },
      h('p', { klasse: 'dato' }, note.titel || formaterDato(note.oprettet)),
      h('span', { klasse: `status-maerke ${status.klasse}` }, ikon(status.ikonNavn), status.tekst),
    ),
    h('p', { klasse: 'meta' }, [type, formaterDato(note.oprettet), formaterVarighed(note.varighedMs)].filter(Boolean).join(' · ')),
    h('p', { klasse: 'slettes' }, sletteTekst(note)),
    note.sendtIgen ? h('p', { klasse: 'meta' }, `Sendt igen kl. ${klokken(note.sendtIgen)}`) : null,
    advarsel ? h('p', { klasse: 'forklaring' }, advarsel) : null,
    sendt ? sendtKnapper(note) : kortKnapper(note, indhold.handlinger, indhold.laes),
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

function loginKnap() {
  return knap('Log ind med din ØLLGAARD-konto', () => logInd(), { ikonNavn: 'person' });
}

function loginBoks() {
  if (t.loginStatus !== 'nej') return null;
  return h(
    'section',
    { klasse: 'login-boks', 'aria-label': 'Login' },
    h('p', {}, 'Du er ikke logget ind. Du kan stadig optage. Log ind for at få dine referater sendt.'),
    loginKnap(),
  );
}

function skaermStart() {
  // Sendte noter venter ikke på noget. De ligger under Tidligere optagelser.
  const afventer = t.noter.filter((n) => n.id !== optager.aktivId() && n.status !== STATUS.SENDT);
  return [
    h(
      'header',
      { klasse: 'top' },
      ordmaerke(),
      // Øverst, så den altid kan ses uden at rulle.
      h('button', { klasse: 'top-knap', 'aria-label': 'Tidligere optagelser', vedTryk: aabnTidligere }, ikon('liste'), 'Tidligere'),
    ),
    h('h1', { klasse: 'titel' }, 'Transskribering'),
    beskedElement(),
    // Er man ikke logget ind, står det i stedet for introen.
    loginBoks() ?? h('p', { klasse: 'intro' }, 'Indtal noter, møder og påmindelser. Du får et referat med PDF på din mail.'),
    h('button', { klasse: 'top-knap info-knap', vedTryk: aabnInformation }, ikon('info'), 'Information'),
    startNavn(),
    h(
      'div',
      { klasse: 'scene' },
      h('button', { klasse: 'optag', vedTryk: optag, disabled: t.starter || t.fornyer }, ikon('mikrofon'), 'Optag'),
      t.fornyer ? venter('Logger ind …') : null,
    ),
    afventer.length ? h('h2', { klasse: 'sektion-titel' }, 'Afventer') : null,
    afventer.length ? h('div', { klasse: 'liste' }, ...afventer.map(kort)) : null,
    hjaelpTilHjemmeskaerm(),
  ];
}

// Skærmen efter Send: fire trin, der krydses af undervejs

function trinPunkt(tilstand, titel, tekst) {
  const tegnet = tilstand === 'faerdig' ? ikon('tjek')
    : tilstand === 'fejl' ? ikon('advarsel')
      : tilstand === 'igang' ? h('span', { klasse: 'spinner' }) : null;
  return h(
    'li',
    { klasse: `trin-punkt ${tilstand}` },
    h('span', { klasse: 'trin-ikon', 'aria-hidden': 'true' }, tegnet),
    h('div', {}, h('p', { klasse: 'trin-titel' }, titel), tekst ? h('p', { klasse: 'trin-tekst' }, tekst) : null),
  );
}

/** Hvor langt noten er: 1 sender lyden, 2 laver referatet, 3 sender mailen, 4 færdig. */
function fase(note) {
  if (note.status === STATUS.SENDT) return 4;
  if (note.status === STATUS.SENDER_MAIL || note.status === STATUS.TEKST_KLAR) return 3;
  return note.fremdrift === 'laver' ? 2 : 1;
}

/** Hvilket trin der fejlede, og hvad der skal stå. null, når intet fejlede. */
function fremdriftFejl(note) {
  if (t.igang.has(note.id)) return null;
  if (note.status === STATUS.FEJL) {
    if (note.fremdrift === 'laver' || note.fejlType === 'ingenTale') {
      return { trin: 3, titel: 'Referatet kunne ikke laves lige nu', tekst: BESKEDER[note.fejlType] || BESKEDER.tjeneste };
    }
    return { trin: 2, titel: 'Lyden kunne ikke sendes', tekst: BESKEDER[note.fejlType] || BESKEDER.tjeneste };
  }
  if (note.status === STATUS.TEKST_KLAR && (note.fejlType || note.maaskeSendt)) {
    const tekst = note.maaskeSendt ? BESKEDER.maaskeSendt : note.fejlType === 'login' ? BESKEDER.login : BESKEDER.mailFejl;
    return { trin: 4, titel: 'Mailen blev ikke sendt', tekst };
  }
  return null;
}

function skaermFremdrift() {
  const note = t.noter.find((n) => n.id === t.fremdriftNote);
  if (!note) {
    t.visning = 'start';
    return skaermStart();
  }
  const mail = login.brugerMail();
  const p = fase(note);
  const fejl = fremdriftFejl(note);
  const trin = [
    trinPunkt('faerdig', 'Optagelsen er gemt', 'På telefonen'),
    fejl?.trin === 2 ? trinPunkt('fejl', fejl.titel, fejl.tekst)
      : trinPunkt(p > 1 ? 'faerdig' : 'igang', p > 1 ? 'Lyden er sendt' : 'Sender lyden …'),
    fejl?.trin === 3 ? trinPunkt('fejl', fejl.titel, fejl.tekst)
      : p > 2 ? trinPunkt('faerdig', 'Referatet er lavet')
        : p === 2 && !fejl ? trinPunkt('igang', 'Referatet laves …', 'Det kan tage et par minutter.')
          : trinPunkt('venter', 'Referatet laves'),
    fejl?.trin === 4 ? trinPunkt('fejl', fejl.titel, fejl.tekst)
      : p === 4 ? trinPunkt('faerdig', `Referatet er sendt til ${mail}`)
        : trinPunkt(p === 3 && !fejl ? 'igang' : 'venter', 'Referatet sendes til din mail'),
  ];
  const type = typeNavn(note.type);
  const meta = [type, formaterVarighed(note.varighedMs)].filter(Boolean).join(' · ');
  let nederst;
  if (fejl) {
    const kanIgen = !['ingenTale', 'kanIkkeBehandles'].includes(note.fejlType) && !note.maaskeSendt;
    const igen = note.fejlType === 'login'
      ? knap('Log ind og prøv igen', () => logInd({ id: note.id, handling: note.status === STATUS.TEKST_KLAR ? 'send' : 'behandl' }), { ikonNavn: 'person' })
      : knap('Prøv igen', () => behandlOgSend(note.id), { ikonNavn: 'igen' });
    nederst = h('div', { klasse: 'knapper' }, kanIgen ? igen : null, knap('Til forsiden', tilForsiden, { klasse: 'hvid', ikonNavn: 'tilbage' }));
  } else if (p === 4) {
    nederst = [
      h('p', { klasse: 'mail-linje' }, 'Du finder det også under ', h('strong', {}, 'Tidligere'), ' i 7 dage.'),
      knap('Ny optagelse', tilForsiden, { ikonNavn: 'mikrofon' }),
    ];
  } else {
    nederst = [
      h('p', { klasse: 'mail-linje' }, 'Sendes til ', h('strong', {}, mail)),
      h('div', { klasse: 'info' }, ikon('info'), h('span', {}, 'Hold appen åben, til referatet er sendt. Lukker du den, får du en besked og kan sende igen bagefter.')),
      // En ny optagelse kan startes, mens referatet laves. Appen er stadig åben.
      knap('Ny optagelse', tilForsiden, { klasse: 'hvid', ikonNavn: 'mikrofon' }),
    ];
  }
  return [
    h('header', { klasse: 'top' }, ordmaerke()),
    h('h1', { klasse: 'titel' }, note.titel || 'Optagelse'),
    meta ? h('p', { klasse: 'undertitel' }, meta) : null,
    // Fejl som manglende net ved login vises her. At referatet er sendt, står allerede i trinene.
    t.besked?.type === 'fejl' ? beskedElement() : null,
    h('div', { klasse: 'trin-kort' }, h('ol', { klasse: 'trin-liste', 'aria-live': 'polite' }, ...trin)),
    ...[nederst].flat(),
  ];
}

function skaermInformation() {
  const afsnit = (titel, ...indhold) => h('section', { klasse: 'info-afsnit' }, h('h2', {}, titel), ...indhold);
  return [
    topMedTilbage(tilForsiden),
    h('h1', { klasse: 'titel' }, 'Information'),
    afsnit(
      'Hvad appen kan bruges til',
      h('p', {}, 'Indtal byggenotater, møder, påmindelser til dig selv og andet. Du får et referat på din egen mail.'),
    ),
    afsnit(
      'Sådan bruger du den',
      h(
        'ol',
        { klasse: 'trin' },
        h('li', {}, 'Skriv evt. et navn.'),
        h('li', {}, 'Tryk Optag, og tryk Stop, når du er færdig.'),
        h('li', {}, 'Giv optagelsen et navn, og tryk Send.'),
        h('li', {}, 'Du får et referat på mail med PDF. Det kan tage et par minutter.'),
      ),
    ),
    afsnit(
      'Vigtigt at vide',
      h(
        'ul',
        { klasse: 'info-liste' },
        h('li', {}, 'Brug appen fra hjemmeskærmen, ikke fra en fane i Safari eller Chrome.'),
        h('li', {}, 'Svar Ja, når Microsoft spørger \'Vil du forblive logget på?\'.'),
        h('li', {}, 'Hold appen åben og skærmen tændt, mens du optager, og indtil referatet er sendt.'),
        h('li', {}, 'Lyden slettes fra telefonen, når referatet er sendt. Referatet og PDF\'en gemmes på telefonen i 7 dage under Tidligere. Optagelser, der ikke er sendt, gemmes, indtil de er sendt.'),
        h('li', {}, 'Referatet laves af AI. Tjek altid vigtige tal, mål og frister. Hele transskriptionen ligger bagerst i PDF\'en.'),
        h('li', {}, 'Lyd og tekst behandles af Google for at lave transskription og referat. De bruges ikke til at træne AI-modeller. Mailen sendes fra din egen Outlook.'),
      ),
    ),
    afsnit(
      'Konto',
      ...(t.loginStatus === 'nej' || !login.harVaeretLoggetInd()
        ? [h('p', {}, 'Du er ikke logget ind.'), loginKnap()]
        : [
          h('p', { klasse: 'konto' }, 'Logget ind som ', h('strong', {}, login.brugerMail())),
          knap('Log ud', logUd, { klasse: 'hvid' }),
        ]),
    ),
    afsnit(
      'Kontakt',
      h('p', {}, 'Hvis noget ikke virker, så kontakt Rasmus Winther på ', h('a', { href: 'mailto:rw@ollgaard.dk' }, 'rw@ollgaard.dk'), '.'),
    ),
  ];
}

function skaermTidligere() {
  const noter = t.noter.filter((n) => n.id !== optager.aktivId());
  return [
    topMedTilbage(tilbage),
    h('h1', { klasse: 'titel' }, 'Tidligere optagelser'),
    h('p', { klasse: 'undertitel' }, 'Her finder du dine optagelser fra de sidste 7 dage. Optagelser, der endnu ikke er sendt, gemmes, indtil de er sendt.'),
    beskedElement(),
    noter.length
      ? h('div', { klasse: 'liste historik-liste' }, ...noter.map(historikKort))
      : h('p', { klasse: 'tom-liste' }, 'Ingen optagelser endnu.'),
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
    note.status === STATUS.GEMT && note.afbrudt ? fortsaetKnap(note.id) : null,
    h('label', { for: 'titel', klasse: 'navn-titel' }, 'Hvad handler optagelsen om?'),
    felt,
    h('p', { klasse: 'hjaelpetekst' }, 'Valgfrit. Er feltet tomt, finder appen selv på en titel. Appen finder også selv ud af, om det er et møde, et byggenotat, en påmindelse eller andet.'),
    h('button', { type: 'submit' }, ikon('send'), 'Send'),
    // En afbrudt optagelse kan vente. Den ligger i Afventer.
    note.afbrudt ? h('button', { type: 'button', klasse: 'hvid', vedTryk: tilForsiden }, ikon('tilbage'), 'Til forsiden') : null,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    navngivOgSend(note.id, felt.value);
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
  const sendt = note.status === STATUS.SENDT;
  const send = note.fejlType === 'login'
    ? knap('Log ind og prøv igen', () => logInd({ id: note.id, handling: sendt ? 'sendIgen' : 'send' }), { ikonNavn: 'person' })
    : sendt ? knap('Send referat igen', () => sendIgen(note.id), { ikonNavn: 'send' })
      : knap('Send til mig', () => sendTilMig(note.id), { ikonNavn: 'send' });
  const advarsel = (tekst) => h('p', { klasse: 'besked fejl', role: 'alert' }, ikon('advarsel'), h('span', {}, tekst));
  return [
    h(
      'div',
      { klasse: 'tekst-skaerm' },
      topMedTilbage(tilbage),
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
          note.maaskeSendt && !sendt ? knap('Jeg har fået mailen', () => bekraeftSendt(note.id), { klasse: 'tonet', ikonNavn: 'tjek' }) : null,
          send,
        ]),
    ),
  ];
}

let forrigeVisning = null;

function tegn() {
  let indhold;
  if (t.visning === 'optager') indhold = skaermOptager();
  else if (t.visning === 'tekst') indhold = skaermTekst();
  else if (t.visning === 'navn') indhold = skaermNavn();
  else if (t.visning === 'tidligere') indhold = skaermTidligere();
  else if (t.visning === 'fremdrift') indhold = skaermFremdrift();
  else if (t.visning === 'information') indhold = skaermInformation();
  // Kontoen kan være væk efter en koldstart. Optagelse skal stadig kunne startes, også uden net.
  else if (!login.harVaeretLoggetInd() && t.noter.length === 0) indhold = skaermLogin();
  else indhold = skaermStart();
  temaFarve?.setAttribute('content', t.visning === 'optager' ? '#0f1a26' : '#f3f5f8');
  // En note, der bliver færdig i baggrunden, tegner skærmen på ny. Skriver brugeren, skal feltet beholde fokus.
  const aktivt = document.activeElement?.tagName === 'INPUT' ? document.activeElement : null;
  const markering = aktivt && [aktivt.id, aktivt.selectionStart, aktivt.selectionEnd];
  app.replaceChildren(...indhold.filter(Boolean));
  if (t.visning !== forrigeVisning) {
    forrigeVisning = t.visning;
    window.scrollTo(0, 0);
  }
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
  if (handling === 'sendIgen') {
    if (!(await lager.hentNote(id))) return;
    await lager.opdaterNote(id, { fejlType: undefined });
    t.visning = 'tidligere';
    await sendIgen(id);
  } else if (handling === 'send') {
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

// Telefonen kan stoppe appen i baggrunden. Så bliver referatet først færdigt, når appen åbnes igen.
const IKKE_SENDT = 'Referatet er ikke sendt endnu — åbn appen igen, så det kan blive færdigt.';
// På iPhone tager telefonen mikrofonen, før appen meldes skjult. Derfor regnes en afbrydelse lige før med.
const STOPPET = 'Optagelsen er stoppet. Åbn appen og hold den åben, mens du optager.';
const STOPPET_VINDUE_MS = 10 * 1000;
const advaretOm = new Set();
let sidstAfbrudt = null; // { id, tid }

/** Én notifikation pr. afbrydelse. Giver true, hvis den blev vist. */
function advarStoppet(id) {
  if (!id || advaretOm.has(id)) return false;
  advaretOm.add(id);
  visAdvarsel(STOPPET);
  return true;
}

/** En ny del er startet: en senere afbrydelse skal give en ny notifikation. */
function nyDelStartet(id) {
  advaretOm.delete(id);
  sidstAfbrudt = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  if (optager.erAktiv()) {
    // Har brugeren lige trykket Stop, er der intet at advare om.
    const grund = optager.afsluttesMed();
    if (!grund || grund === 'afbrudt') advarStoppet(optager.aktivId());
    return;
  }
  if (sidstAfbrudt && Date.now() - sidstAfbrudt.tid < STOPPET_VINDUE_MS && advarStoppet(sidstAfbrudt.id)) return;
  const igang = t.igang.size > 0 || t.noter.some((n) => n.status === STATUS.SENDER || n.status === STATUS.SENDER_MAIL);
  if (igang) visAdvarsel(IKKE_SENDT);
});

// En afbrudt optagelse åbnes direkte ved start, hvis den er fra den sidste halve time. Ældre ligger i Afventer.
const NYLIG_AFBRUDT_MS = 30 * 60 * 1000;

/** Er appen i gang med noget, må den ikke skifte til Microsoft. */
function nogetIGang() {
  return t.visning !== 'start' || t.starter || optager.erAktiv() || t.igang.size > 0
    || t.noter.some((n) => n.status === STATUS.SENDER || n.status === STATUS.SENDER_MAIL);
}

async function tjekLoginVedStart() {
  // Aldrig logget ind eller logget ud: ingen fornyelse uden tryk. Uden optagelser vises login-skærmen.
  if (!login.harVaeretLoggetInd()) {
    t.loginStatus = 'nej';
    await opdater();
    return;
  }
  let status = await login.tjekLogin();
  // Uden net kan login ikke ses eller fornys. Så vises intet.
  if (status === 'nej' && !navigator.onLine) status = 'ukendt';
  if (status === 'nej' && !nogetIGang()) {
    // Appen skifter til Microsoft og tilbage. Imens kan Optag ikke trykkes, så skiftet aldrig afbryder en optagelse.
    t.fornyer = true;
    tegn();
    try {
      await login.fornyStille(() => !nogetIGang());
    } finally {
      t.fornyer = false;
    }
  }
  t.loginStatus = status === 'ukendt' ? null : status;
  if (status === 'ja') await forloeb.sendVentende();
  await opdater();
}

async function start() {
  await login.init().catch(() => {});
  try {
    t.noter = await forloeb.genoptag(optagelserAndetSted);
  } catch {
    t.noter = [];
  }
  // Blev appen lukket midt i en optagelse, skal det være det første, man ser.
  const nylig = (n) => Date.now() - (n.sidstAktiv ?? n.oprettet ?? 0) < NYLIG_AFBRUDT_MS;
  const afbrudtNote = t.noter.find((n) => n.status === STATUS.GEMT && n.afbrudt && !n.navngivet && nylig(n));
  if (afbrudtNote) {
    t.visning = 'navn';
    t.navnNote = afbrudtNote.id;
    visFejl('afbrudt');
  }
  tegn();
  document.body.dataset.klar = '1';
  // Beder telefonen om ikke at slette optagelserne. Afgøres af telefonen.
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  await genoptagEfterLogin();
  await tjekLoginVedStart().catch(() => {});
}

start();
