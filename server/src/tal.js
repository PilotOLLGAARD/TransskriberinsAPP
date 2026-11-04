'use strict';

/**
 * Kontrol af tal i et referat. Laves i koden, ikke af AI'en.
 * Hvert tal i referatet skal kunne findes i transskriptionen (eller i brugerens egen titel).
 * Et tal, der ikke kan findes, erstattes med [uklart]. Kontrollen ser kun på værdien, ikke på enheden,
 * og kan ikke afgøre, hvilket af to sagte tal der er det rigtige (fx ved en rettelse undervejs).
 */

const UKLART = '[uklart]';

const ENERE = { nul: 0, en: 1, et: 1, 'én': 1, 'ét': 1, to: 2, tre: 3, fire: 4, fem: 5, seks: 6, syv: 7, otte: 8, ni: 9 };
const TEENS = { ti: 10, elleve: 11, tolv: 12, tretten: 13, fjorten: 14, femten: 15, seksten: 16, sytten: 17, atten: 18, nitten: 19 };
const TIERE = {
  tyve: 20, tredive: 30, tredve: 30, fyrre: 40, fyrretyve: 40, halvtreds: 50, halvtredsindstyve: 50,
  tres: 60, tresindstyve: 60, halvfjerds: 70, halvfjerdsindstyve: 70, firs: 80, firsindstyve: 80,
  halvfems: 90, halvfemsindstyve: 90,
};
const GANGE = { hundrede: 100, hundred: 100, tusind: 1000, tusinde: 1000, million: 1e6, millioner: 1e6 };
const ORDENSTAL = {
  'første': 1, anden: 2, andet: 2, tredje: 3, fjerde: 4, femte: 5, sjette: 6, syvende: 7, ottende: 8, niende: 9,
  tiende: 10, ellevte: 11, tolvte: 12, trettende: 13, fjortende: 14, femtende: 15, sekstende: 16, syttende: 17,
  attende: 18, nittende: 19, tyvende: 20, tredivte: 30, tredvte: 30,
};
const BROEK = { halvanden: 1.5, halvandet: 1.5, halv: 0.5, halvt: 0.5, kvart: 0.25 };
// Står alene: "en snes" er 20, men skal ikke lægges sammen med tallet foran.
const ANTAL = { snes: 20, dusin: 12 };
const MAANEDER = {
  januar: 1, februar: 2, marts: 3, april: 4, maj: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, december: 12,
};
const TIERE_ORD = [...Object.keys(TIERE), 'tyvende', 'tredivte', 'tredvte'].join('|');
const SAMMENSAT = new RegExp(`^(${Object.keys(ENERE).filter((o) => ENERE[o] > 0).join('|')})og(${TIERE_ORD})$`);
// Et ord, der er bygget som et tal (fx "nittenogtres"), men ikke er et gyldigt dansk tal.
const UGYLDIGT_TALORD = new RegExp(`^\\p{L}+og(${TIERE_ORD})$`, 'u');

/** Værdien af ét ord, eller null. Fx "fire" 4, "niogfirs" 89, "enogtyvende" 21. */
function ordVaerdi(ord) {
  for (const tabel of [ENERE, TEENS, TIERE, GANGE, ORDENSTAL, BROEK, ANTAL]) if (Object.hasOwn(tabel, ord)) return tabel[ord];
  const m = SAMMENSAT.exec(ord);
  if (!m) return null;
  return ENERE[m[1]] + (TIERE[m[2]] ?? ORDENSTAL[m[2]]);
}

/** Talord, der kontrolleres i referatet. "en", "et", ordenstal og brøker er udeladt, da de også er almindelige ord. */
function kontrolleresOrd(ord) {
  if (Object.hasOwn(ENERE, ord)) return ENERE[ord] >= 2;
  return Object.hasOwn(TEENS, ord) || Object.hasOwn(TIERE, ord) || Object.hasOwn(GANGE, ord) || SAMMENSAT.test(ord);
}

const enkeltOrd = (w) => Object.hasOwn(BROEK, w) || Object.hasOwn(ANTAL, w) || Object.hasOwn(ORDENSTAL, w);

// Ord og tegnsætning. Tegnsætning afslutter et tal sagt med ord.
const TOKEN = /\p{L}+|[.,;:!?()\-–/]/gu;

/**
 * Tal sagt med ord: sekvenserne med deres placering, og ekstra værdier fra klokkeslæt,
 * decimaler ("en komma fem"), årstal i par ("tyve seksogtyve") og måneder.
 */
function scanTalord(tekst) {
  const tokens = [...tekst.matchAll(TOKEN)].map((m) => ({ w: m[0].toLowerCase(), fra: m.index, til: m.index + m[0].length }));
  const sekvenser = [];
  const ekstra = new Set();
  let s = null; // { total, nu, fra, til, smaaFra, kontrolleres }
  let kommaFoer = null;
  const gem = (vaerdi, fra, til, kontrolleres) => {
    sekvenser.push({ vaerdi, fra, til, kontrolleres });
    if (kommaFoer !== null && Number.isInteger(vaerdi)) ekstra.add(Number(`${kommaFoer}.${vaerdi}`));
    kommaFoer = null;
  };
  const afslut = () => {
    if (s) gem(s.total + s.nu, s.fra, s.til, s.kontrolleres);
    s = null;
  };
  const naesteTal = (i) => (tokens[i] ? ordVaerdi(tokens[i].w) : null);
  for (let i = 0; i < tokens.length; i++) {
    const { w, fra, til } = tokens[i];
    const v = ordVaerdi(w);
    // Klokkeslæt: "halv otte" er 7.30 (og 19.30), "kvart over syv" 7.15, "kvart i en" 12.45, "klokken to" 2 eller 14.
    const time = (t) => [t % 12 || 12, (t % 12 || 12) + 12];
    if (w === 'halv' && naesteTal(i + 1) >= 1 && naesteTal(i + 1) <= 12) for (const t of [...time(naesteTal(i + 1) - 1), 30]) ekstra.add(t);
    if (w === 'kvart' && (tokens[i + 1]?.w === 'over' || tokens[i + 1]?.w === 'i') && naesteTal(i + 2) >= 1 && naesteTal(i + 2) <= 12) {
      const t = naesteTal(i + 2);
      for (const x of tokens[i + 1].w === 'over' ? [...time(t), 15] : [...time(t - 1), 45]) ekstra.add(x);
    }
    if ((w === 'klokken' || w === 'kl') && naesteTal(i + 1 + (tokens[i + 1]?.w === '.' ? 1 : 0)) <= 12) {
      const t = naesteTal(i + 1 + (tokens[i + 1]?.w === '.' ? 1 : 0));
      if (t >= 1) for (const x of time(t)) ekstra.add(x);
    }
    if (Object.hasOwn(MAANEDER, w)) ekstra.add(MAANEDER[w]);
    // "to og en halv" er 2,5.
    if (w === 'og' && s && tokens[i + 1]?.w === 'en' && tokens[i + 2]?.w === 'halv') ekstra.add(s.total + s.nu + 0.5);
    // "to hundrede og halvtreds": "og" binder et tal sammen.
    if (w === 'og' && s && naesteTal(i + 1) !== null && !enkeltOrd(tokens[i + 1].w)) continue;
    if (w === 'komma' && s && naesteTal(i + 1) !== null) {
      const foer = s.total + s.nu;
      afslut();
      kommaFoer = foer;
      continue;
    }
    if (v === null || enkeltOrd(w)) {
      afslut();
      if (v !== null) gem(v, fra, til, false);
      continue;
    }
    if (!s) s = { total: 0, nu: 0, fra, til, smaaFra: fra, kontrolleres: false };
    else if (Object.hasOwn(GANGE, w)) {
      // Samme størrelsesorden igen er et nyt tal: "to hundrede og to hundrede", "fem tusind to tusind".
      const nytHundrede = v === 100 && s.nu >= 100;
      const nytTusind = v >= 1000 && s.total >= v && s.total < v * 1000;
      if (nytHundrede || nytTusind) {
        const lille = nytHundrede ? s.nu % 100 : s.nu;
        gem(s.total + s.nu - lille, s.fra, s.smaaFra, s.kontrolleres);
        s = { total: 0, nu: lille, fra: s.smaaFra, til, smaaFra: s.smaaFra, kontrolleres: true };
      }
    } else if (s.nu % 100 !== 0) {
      // To små tal efter hinanden er to tal, ikke en sum: "to og tre", "tyve seksogtyve".
      afslut();
      s = { total: 0, nu: 0, fra, til, smaaFra: fra, kontrolleres: false };
    }
    if (Object.hasOwn(GANGE, w)) {
      if (v === 100) s.nu = (s.nu || 1) * 100;
      else {
        s.total += (s.nu || 1) * v;
        s.nu = 0;
      }
    } else {
      if (s.nu === 0) s.smaaFra = fra;
      s.nu += v;
    }
    s.til = til;
    s.kontrolleres ||= kontrolleresOrd(w);
  }
  afslut();
  // Årstal sagt i par: "tyve seksogtyve" 2026, "nitten seksoghalvfems" 1996.
  for (let i = 1; i < sekvenser.length; i++) {
    const [a, b] = [sekvenser[i - 1], sekvenser[i]];
    if (a.vaerdi >= 10 && a.vaerdi <= 20 && Number.isInteger(b.vaerdi) && b.vaerdi < 100 && tekst.slice(a.til, b.fra).trim() === '') {
      ekstra.add(a.vaerdi * 100 + b.vaerdi);
    }
  }
  return { sekvenser, ekstra };
}

// Tal skrevet med cifre: tusinder med mellemrum (12 500), ellers grupper delt af punktum, komma eller kolon.
const CIFRE = /\d{1,3}(?: \d{3})+(?:,\d+)?(?!\d)|\d+(?:[.,:]\d+)*/g;

/** 2 og 3 i m2, cm3 og CO2 er en del af enheden, ikke et tal. */
function erEksponent(tekst, m, index) {
  if (m !== '2' && m !== '3') return false;
  const foer = tekst.slice(Math.max(0, index - 3), index);
  return /(?:^|[^\p{L}])[kdcm]?m$/iu.test(foer) || (m === '2' && /(?:^|[^\p{L}])co$/iu.test(foer));
}

/** Værdier, et tal med cifre kan betyde på dansk. Fx "1.500" 1500, "2,5" 2,5, "4.2" 4,2, "8.00" 8. */
function tolkninger(tekst) {
  const ud = new Set();
  const udenMellemrum = tekst.replace(/ /g, '');
  if (/^\d+(?:\.\d{3})+(?:,\d+)?$/.test(udenMellemrum)) ud.add(Number(udenMellemrum.replace(/\./g, '').replace(',', '.')));
  if (/^\d+(?:,\d+)?$/.test(udenMellemrum)) ud.add(Number(udenMellemrum.replace(',', '.')));
  // Punktum og ét ciffer er en decimal. "8.00" er hele timer. Andre to cifre efter punktum er klokkeslæt eller betegnelser.
  if (/^\d+\.\d$/.test(tekst)) ud.add(Number(tekst));
  if (/^\d+\.00$/.test(tekst)) ud.add(Number(tekst.slice(0, -3)));
  return ud;
}

/** Alle tal, der blev sagt: cifre, talord, ordenstal, klokkeslæt, årstal og måneder. */
function talIKilde(tekst) {
  const tal = new Set();
  const kilde = String(tekst ?? '');
  for (const m of kilde.matchAll(CIFRE)) {
    if (erEksponent(kilde, m[0], m.index)) continue;
    for (const v of tolkninger(m[0])) tal.add(v);
    for (const g of m[0].split(/[.,: ]/)) tal.add(Number(g));
  }
  const { sekvenser, ekstra } = scanTalord(kilde);
  for (const s of sekvenser) tal.add(s.vaerdi);
  for (const v of ekstra) tal.add(v);
  return tal;
}

/** Kan et tal med cifre fra referatet findes blandt de sagte? */
function cifreSagt(tekst, sagt) {
  for (const v of tolkninger(tekst)) if (sagt.has(v)) return true;
  const dele = tekst.split(/[.:]/).map(Number);
  // Klokkeslæt med kolon: timen skal være sagt, minutterne 00 eller sagt. Ellers fx målestok 1:100.
  const kl = /^(\d{1,2}):(\d{2})$/.exec(tekst);
  if (kl && sagt.has(Number(kl[1])) && (Number(kl[2]) === 0 || sagt.has(Number(kl[2])))) return true;
  // Betegnelser, klokkeslæt og målestok (F 2.3, 7.30, 3.11, 1:100): hver del skal være sagt. Komma er altid decimal.
  if (/^\d+(?:\.\d{1,2})+$/.test(tekst) || /^\d+(?::\d+)+$/.test(tekst)) return dele.every((d) => sagt.has(d));
  return false;
}

function kontrollerTekst(tekst, sagt, taeller) {
  if (typeof tekst !== 'string' || !tekst) return tekst;
  const medCifre = tekst.replace(CIFRE, (m, index, hel) => {
    if (erEksponent(hel, m, index) || cifreSagt(m, sagt)) return m;
    taeller.n++;
    return UKLART;
  });
  // Talord kontrolleres som hele tal ("fem tusind"), bagfra, så placeringerne passer.
  let ud = medCifre;
  for (const s of scanTalord(medCifre).sekvenser.reverse()) {
    if (!s.kontrolleres || sagt.has(s.vaerdi)) continue;
    taeller.n++;
    ud = ud.slice(0, s.fra) + UKLART + ud.slice(s.til);
  }
  return ud.replace(/\p{L}+/gu, (w) => {
    if (!UGYLDIGT_TALORD.test(w.toLowerCase()) || ordVaerdi(w.toLowerCase()) !== null) return w;
    taeller.n++;
    return UKLART;
  });
}

function kontrollerVaerdi(v, sagt, taeller) {
  if (typeof v === 'string') return kontrollerTekst(v, sagt, taeller);
  if (Array.isArray(v)) return v.map((x) => kontrollerVaerdi(x, sagt, taeller));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, kontrollerVaerdi(x, sagt, taeller)]));
  }
  return v;
}

/**
 * Erstatter tal i referatet, der ikke blev sagt, med [uklart].
 * @param {object} referat det normaliserede referat
 * @param {string} kilde transskriptionen
 * @param {{ brugerTitel?: string }} valg brugerens egen titel røres ikke, og dens tal tæller som sagt
 * @returns {{ referat: object, rettet: number }}
 */
function kontrollerTal(referat, kilde, { brugerTitel = '' } = {}) {
  const sagt = talIKilde(`${kilde ?? ''}\n${brugerTitel}`);
  const taeller = { n: 0 };
  const ud = {};
  for (const [k, v] of Object.entries(referat)) {
    if (k === 'type' || k === 'kort' || (k === 'titel' && brugerTitel)) ud[k] = v;
    else ud[k] = kontrollerVaerdi(v, sagt, taeller);
  }
  return { referat: ud, rettet: taeller.n };
}

// scanTalord, CIFRE, erEksponent og cifreSagt bruges også af testbænken (scripts/testbaenk/maal.js).
module.exports = { talIKilde, kontrollerTal, UKLART, scanTalord, CIFRE, erEksponent, cifreSagt };
