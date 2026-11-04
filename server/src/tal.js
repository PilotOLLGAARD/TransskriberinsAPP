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
const SAMMENSAT = new RegExp(`^(${Object.keys(ENERE).filter((o) => ENERE[o] > 0).join('|')})og(${[...Object.keys(TIERE), 'tyvende', 'tredivte', 'tredvte'].join('|')})$`);

/** Værdien af ét ord, eller null. Fx "fire" 4, "niogfirs" 89, "enogtyvende" 21. */
function ordVaerdi(ord) {
  for (const tabel of [ENERE, TEENS, TIERE, GANGE, ORDENSTAL, BROEK, ANTAL]) if (Object.hasOwn(tabel, ord)) return tabel[ord];
  const m = SAMMENSAT.exec(ord);
  if (!m) return null;
  return ENERE[m[1]] + (TIERE[m[2]] ?? ORDENSTAL[m[2]]);
}

// Tal skrevet med cifre: tusinder med mellemrum (12 500), ellers grupper delt af punktum, komma eller kolon.
const CIFRE = /\d{1,3}(?: \d{3})+(?:,\d+)?(?!\d)|\d+(?:[.,:]\d+)*/g;

/** Værdier, et tal med cifre kan betyde på dansk. Fx "1.500" 1500, "2,5" 2,5, "8.00" 8. */
function tolkninger(tekst) {
  const ud = new Set();
  const udenMellemrum = tekst.replace(/ /g, '');
  if (/^\d+(?:\.\d{3})+(?:,\d+)?$/.test(udenMellemrum)) ud.add(Number(udenMellemrum.replace(/\./g, '').replace(',', '.')));
  if (/^\d+(?:,\d+)?$/.test(udenMellemrum)) ud.add(Number(udenMellemrum.replace(',', '.')));
  // Punktum med 1-2 cifre efter: decimal eller klokkeslæt (8.00 er 8).
  if (/^\d+\.\d{1,2}$/.test(tekst)) ud.add(Number(tekst));
  return ud;
}

/** Alle tal, der blev sagt: cifre, talord, ordenstal og klokkeslæt. */
function talIKilde(tekst) {
  const tal = new Set();
  const kilde = String(tekst ?? '');
  for (const [m] of kilde.matchAll(CIFRE)) {
    for (const v of tolkninger(m)) tal.add(v);
    for (const g of m.split(/[.,: ]/)) tal.add(Number(g));
  }
  const ord = [...kilde.toLowerCase().matchAll(/\p{L}+/gu)].map((m) => m[0]);
  let total = 0;
  let nu = 0;
  let iTal = false;
  let forrige = null; // seneste hele tal, til "en komma fem"
  const afslut = () => {
    if (iTal) {
      forrige = total + nu;
      tal.add(forrige);
    }
    total = 0;
    nu = 0;
    iTal = false;
  };
  for (let i = 0; i < ord.length; i++) {
    const w = ord[i];
    const v = ordVaerdi(w);
    const naeste = ord[i + 1];
    // Klokkeslæt: "halv otte" er 7.30, "kvart over otte" 8.15, "kvart i otte" 7.45.
    if (w === 'halv' && ordVaerdi(naeste) !== null && ordVaerdi(naeste) >= 1) {
      tal.add(ordVaerdi(naeste) - 1).add(30).add(ordVaerdi(naeste) - 0.5);
    }
    if (w === 'kvart' && (naeste === 'over' || naeste === 'i') && ordVaerdi(ord[i + 2]) !== null) {
      const t = ordVaerdi(ord[i + 2]);
      if (naeste === 'over') tal.add(t).add(15);
      else tal.add(t - 1).add(45);
    }
    if (w === 'komma' && iTal && ordVaerdi(naeste) !== null) {
      afslut();
      const decimal = ordVaerdi(naeste);
      if (Number.isInteger(decimal)) tal.add(Number(`${forrige}.${decimal}`));
      continue;
    }
    // "to og en halv" er 2,5.
    if (w === 'og' && iTal && naeste === 'en' && ord[i + 2] === 'halv') tal.add(total + nu + 0.5);
    if (w === 'og' && iTal && naeste !== undefined && ordVaerdi(naeste) !== null) continue;
    if (v === null || Object.hasOwn(BROEK, w) || Object.hasOwn(ANTAL, w)) {
      afslut();
      if (v !== null) tal.add(v);
      continue;
    }
    // Hvert talord tæller også for sig, fx "F to tre".
    tal.add(v);
    if (Object.hasOwn(GANGE, w)) {
      if (v === 100) nu = (nu || 1) * 100;
      else {
        total += (nu || 1) * v;
        nu = 0;
      }
    } else if (iTal && nu > 0 && nu < 100 && v < 100) {
      // To små tal efter hinanden er to tal, ikke en sum.
      afslut();
      nu = v;
    } else {
      nu += v;
    }
    iTal = true;
  }
  afslut();
  return tal;
}

/** Kan et tal med cifre fra referatet findes blandt de sagte? */
function cifreSagt(tekst, sagt) {
  for (const v of tolkninger(tekst)) if (sagt.has(v)) return true;
  // Klokkeslæt med kolon: timen skal være sagt, minutterne 00 eller sagt.
  const kl = /^(\d{1,2}):(\d{2})$/.exec(tekst);
  if (kl) return sagt.has(Number(kl[1])) && (Number(kl[2]) === 0 || sagt.has(Number(kl[2])));
  // Betegnelser og klokkeslæt med punktum (F 2.3, 7.30): hver del skal være sagt. Komma er altid decimal.
  if (/^\d+(?:\.\d{1,2})+$/.test(tekst)) return tekst.split('.').every((g) => sagt.has(Number(g)));
  return false;
}

// Talord, der kontrolleres i referatet. "en", "et", ordenstal og brøker er udeladt, da de også er almindelige ord.
const KONTROLLEREDE_ORD = (ord) => {
  if (Object.hasOwn(ENERE, ord)) return ENERE[ord] >= 2;
  return Object.hasOwn(TEENS, ord) || Object.hasOwn(TIERE, ord) || SAMMENSAT.test(ord);
};

function kontrollerTekst(tekst, sagt, taeller) {
  if (typeof tekst !== 'string' || !tekst) return tekst;
  const medCifre = tekst.replace(CIFRE, (m) => {
    if (cifreSagt(m, sagt)) return m;
    taeller.n++;
    return UKLART;
  });
  return medCifre.replace(/\p{L}+/gu, (w) => {
    const lille = w.toLowerCase();
    if (!KONTROLLEREDE_ORD(lille) || sagt.has(ordVaerdi(lille))) return w;
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

module.exports = { talIKilde, kontrollerTal, UKLART };
