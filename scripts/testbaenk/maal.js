'use strict';
// Målinger til testbænken: ordfejlrate, tal mod facit, nye egennavne og pris.

const { talIKilde, scanTalord, CIFRE, erEksponent, cifreSagt } = require('../../server/src/tal.js');

/** Tekst som ord til sammenligning: små bogstaver, ingen tegnsætning, tal som cifre ("tres" og "60" er ens). */
function kanonisk(tekst) {
  let t = String(tekst ?? '').toLowerCase();
  for (const s of scanTalord(t).sekvenser.reverse()) t = `${t.slice(0, s.fra)} ${s.vaerdi} ${t.slice(s.til)}`;
  t = t.replace(CIFRE, (m) => {
    if (/^\d{1,3}(?:[. ]\d{3})+(?:,\d+)?$/.test(m)) return m.replace(/[. ]/g, '').replace(',', '.');
    return m.replace(',', '.');
  });
  return t.replace(/[^\p{L}\p{N}.]+/gu, ' ').replace(/(?<!\d)\.|\.(?!\d)/g, ' ').split(/\s+/).filter(Boolean);
}

/** Ordfejlrate: (erstatninger + udeladelser + indsættelser) / antal ord i facit. */
function wer(facit, hyp) {
  const r = kanonisk(facit);
  const h = kanonisk(hyp);
  let forrige = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const nu = [i];
    for (let j = 1; j <= h.length; j++) nu[j] = Math.min(forrige[j] + 1, nu[j - 1] + 1, forrige[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    forrige = nu;
  }
  const fejl = forrige[h.length];
  return { fejl, ord: r.length, rate: r.length ? fejl / r.length : 0 };
}

/** Alle tekster i et referat med feltnavn. type og kort springes over. */
function tekster(v, felt = '') {
  if (typeof v === 'string') return [{ felt, tekst: v }];
  if (Array.isArray(v)) return v.flatMap((x) => tekster(x, felt));
  if (v && typeof v === 'object') {
    return Object.entries(v).filter(([k]) => k !== 'type' && k !== 'kort').flatMap(([k, x]) => tekster(x, felt ? `${felt}.${k}` : k));
  }
  return [];
}

/**
 * Tallene i referatet mod facit: korrekte, [uklart] og forkerte.
 * Forkert er et tal, der ikke blev sagt, eller et tal, der blev rettet undervejs (forkerte).
 */
function talNoejagtighed(referat, facit, rettede = []) {
  const sagt = talIKilde(facit);
  const forbudt = new Set(rettede);
  const r = { korrekte: 0, uklart: 0, forkerte: 0, detaljer: [] };
  for (const { felt, tekst } of tekster(referat)) {
    r.uklart += (tekst.match(/\[uklart\]/g) ?? []).length;
    for (const m of tekst.matchAll(CIFRE)) {
      if (erEksponent(tekst, m[0], m.index)) continue;
      const vaerdi = Number(m[0].replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
      if (cifreSagt(m[0], sagt) && !forbudt.has(vaerdi)) r.korrekte++;
      else {
        r.forkerte++;
        r.detaljer.push({ felt, tal: m[0], tekst });
      }
    }
    for (const s of scanTalord(tekst).sekvenser) {
      if (!s.kontrolleres) continue;
      if (sagt.has(s.vaerdi) && !forbudt.has(s.vaerdi)) r.korrekte++;
      else {
        r.forkerte++;
        r.detaljer.push({ felt, tal: tekst.slice(s.fra, s.til), tekst });
      }
    }
  }
  return r;
}

/** Ord med stort begyndelsesbogstav (ikke først i en sætning) og hvem i opgaver, som ikke findes i facit. */
function nyeEgennavne(referat, facit) {
  const iFacit = new Set(kanonisk(facit));
  const fundet = new Set();
  for (const { felt, tekst } of tekster(referat)) {
    const kandidater = felt.endsWith('hvem')
      ? tekst.split(/[\s,]+/)
      : [...tekst.matchAll(/(?<![.!?:]\s|^)(?<=\s)\p{Lu}[\p{L}-]+/gu)].map((m) => m[0]);
    for (const k of kandidater) {
      const ord = k.replace(/[^\p{L}-]/gu, '');
      if (ord && /^\p{Lu}/u.test(ord) && ord !== 'Mig' && !iFacit.has(ord.toLowerCase())) fundet.add(ord);
    }
  }
  return [...fundet];
}

/**
 * Pris i USD. Transskription (gemini-3.5-transcribe): 25 lydtokens pr. sek. til 2,00 og teksttokens til 12,00 pr. mio.
 * Referat (gemini-3.8-flash til og med 31.12.2026): 0,75 ind og 3,75 ud (inkl. tænkning) pr. mio.
 */
function pris({ sek = 0, tekstTokens = 0, referat = null }) {
  const transskription = (sek * 25 * 2 + tekstTokens * 12) / 1e6;
  const ref = referat ? (referat.ind * 0.75 + referat.ud * 3.75) / 1e6 : 0;
  return transskription + ref;
}

module.exports = { kanonisk, wer, talNoejagtighed, nyeEgennavne, pris, tekster };
