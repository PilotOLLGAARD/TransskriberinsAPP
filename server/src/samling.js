'use strict';

/**
 * Samler bidder og dele til én transskription med én tidslinje.
 * Lange optagelser klippes på telefonen i bidder med overlap. Her fjernes overlappet, så hvert ord står én gang.
 * Ordene skrives aldrig om: der klippes kun mellem hele ord. Hellere et par ord gentaget end ét ord tabt.
 */

const { samletTekst, formaterTid } = require('./afsnit.js');

// Uden cifre: teksten går til referatet og talkontrollen. Tidsrummet sættes først ind i bilag, mail og app (medTidsrum).
const HUL_TEKST = '[Dette afsnit kunne ikke transskriberes]';
const AFBRUDT_TEKST = '[Optagelsen blev afbrudt her]';
// Overlappets ord søges lidt uden for selve overlappet, da Flashs tider er anslået.
const MARGEN_SEK = 15;
const MAKS_ORD_UDEN_TID = 150;
const MIN_FAELLES_ORD = 6;
// Omtrentlig ordrække (lokal justering): +2 for et ens ord, -1 for et andet ord eller et ord for meget eller for lidt.
// Den bruges kun inden for overlappet (ca. 3 ord pr. sekund) og med mindst 8 ens ord, der udgør mindst 70 % af rækken.
const ORD_PR_SEK = 3;
const MIN_ENS_ORD = 8;
const MIN_ENS_ANDEL = 0.7;

const ordAf = (tekst) => String(tekst).split(/\s+/).filter(Boolean);
const normaliser = (ord) => ord.toLocaleLowerCase('da-DK').replace(/[^\p{L}\p{N}]/gu, '');
const harTid = (afsnit) => afsnit.length > 0 && afsnit.every((a) => a.sek !== null);

/** Ordene i de afsnit, der kan ligge i overlappet: [{ ai, wi, n }]. */
function vindue(afsnit, { fraSlut, graense }) {
  const ud = [];
  afsnit.forEach((a, ai) => {
    const medTid = a.sek !== null;
    // Fra slutningen: et afsnit tæller med, hvis det rækker ind i vinduet, dvs. det næste starter efter grænsen
    // (et langt afsnit, der starter tidligt, kan slutte i overlappet). Fra starten: hvis det starter før grænsen.
    const naesteSek = afsnit.slice(ai + 1).find((x) => x.sek !== null)?.sek ?? Infinity;
    if (medTid && (fraSlut ? naesteSek < graense : a.sek > graense)) return;
    ordAf(a.tekst).forEach((w, wi) => ud.push({ ai, wi, n: normaliser(w), sek: a.sek }));
  });
  if (fraSlut) return ud.slice(-MAKS_ORD_UDEN_TID * 2);
  return ud.slice(0, MAKS_ORD_UDEN_TID * 2);
}

/** Den længste fælles række af ord, nærmest midten ved lige lange. { i, j, laengde } eller null. */
/**
 * Den bedste omtrentlige fælles række (lokal justering på ord): { i, j } er dens start i hale og hoved, eller null.
 * Kun inden for de sidste og første ord, et overlap kan fylde (ca. 3 ord pr. sekund), og kun en række med mindst
 * MIN_ENS_ORD ens ord og mindst 70 % ens ord. Så kan en sætning, der gentages et andet sted, aldrig klippe tekst væk.
 */
function lignendeRaekke(haleHel, hovedHel, overlapSek) {
  const maks = Math.max(40, Math.round(overlapSek * ORD_PR_SEK));
  const skub = Math.max(0, haleHel.length - maks);
  const hale = haleHel.slice(skub);
  const hoved = hovedHel.slice(0, maks);
  const m = hoved.length;
  let bedst = null;
  // Pr. celle: point, hvor rækken startede, antal ens ord og rækkens længde.
  const tom = () => Array.from({ length: m + 1 }, () => ({ p: 0, start: null, ens: 0, laengde: 0 }));
  let forrige = tom();
  for (let a = 1; a <= hale.length; a++) {
    const nu = tom();
    for (let b = 1; b <= m; b++) {
      const ens = Boolean(hale[a - 1].n) && hale[a - 1].n === hoved[b - 1].n;
      const d = forrige[b - 1];
      const valg = [
        { p: d.p + (ens ? 2 : -1), start: d.start ?? (ens ? [a - 1, b - 1] : null), ens: d.ens + (ens ? 1 : 0), laengde: d.laengde + 1 },
        { ...forrige[b], p: forrige[b].p - 1, laengde: forrige[b].laengde + 1 },
        { ...nu[b - 1], p: nu[b - 1].p - 1, laengde: nu[b - 1].laengde + 1 },
      ].filter((c) => c.p > 0 && c.start);
      const c = valg.reduce((x, y) => (y.p > x.p ? y : x), { p: 0, start: null, ens: 0, laengde: 0 });
      nu[b] = c;
      if (c.p > (bedst?.p ?? 0)) bedst = c;
    }
    forrige = nu;
  }
  if (!bedst || bedst.ens < MIN_ENS_ORD || bedst.ens / bedst.laengde < MIN_ENS_ANDEL) return null;
  return { i: skub + bedst.start[0], j: bedst.start[1] };
}

function faellesRaekke(hale, hoved, midte) {
  let bedst = null;
  let forrige = new Array(hoved.length + 1).fill(0);
  for (let i = 1; i <= hale.length; i++) {
    const nu = new Array(hoved.length + 1).fill(0);
    for (let j = 1; j <= hoved.length; j++) {
      if (!hale[i - 1].n || hale[i - 1].n !== hoved[j - 1].n) continue;
      nu[j] = forrige[j - 1] + 1;
      const laengde = nu[j];
      if (laengde < MIN_FAELLES_ORD) continue;
      const start = { i: i - laengde, j: j - laengde, laengde };
      const afstand = Math.abs((hale[start.i].sek ?? midte) - midte);
      if (!bedst || laengde > bedst.laengde || (laengde === bedst.laengde && afstand <= bedst.afstand)) bedst = { ...start, afstand };
    }
    forrige = nu;
  }
  return bedst;
}

/**
 * Fjerner overlappet mellem to bidder. Tiderne er globale (sekunder fra optagelsens start), eller null.
 * Findes en fælles række på mindst 6 ord, klippes ved dens start. Ellers, når begge har tider, ved overlappets midte.
 * Uden tider og uden fælles række beholdes begge.
 */
function fjernOverlap(forrige, naeste, { naesteStartSek, overlapSek }) {
  const midte = naesteStartSek + overlapSek / 2;
  // Uden tider på den ene side findes overlappet kun blandt de sidste og første ord, det kan fylde, så en sætning,
  // der gentages længere væk, aldrig klipper tekst væk. Med tider afgrænser tiden vinduet.
  const udenTid = !harTid(forrige) || !harTid(naeste);
  const maks = udenTid ? Math.max(40, Math.round(overlapSek * ORD_PR_SEK)) : MAKS_ORD_UDEN_TID * 2;
  const hale = vindue(forrige, { fraSlut: true, graense: naesteStartSek - MARGEN_SEK }).slice(-maks);
  const hoved = vindue(naeste, { fraSlut: false, graense: naesteStartSek + overlapSek + MARGEN_SEK }).slice(0, maks);
  // Først en ens række på 6 ord, ellers en omtrentlig (to modeller eller to forsøg skriver overlappet lidt forskelligt).
  const fund = faellesRaekke(hale, hoved, midte) ?? lignendeRaekke(hale, hoved, overlapSek);

  if (fund) {
    const skaer = hale[fund.i];
    const start = hoved[fund.j];
    const rest = ordAf(forrige[skaer.ai].tekst).slice(0, skaer.wi).join(' ');
    const foer = forrige.slice(0, skaer.ai);
    const foersteNaeste = { ...naeste[start.ai], tekst: ordAf(naeste[start.ai].tekst).slice(start.wi).join(' ') };
    // Et afsnit, der blev klippet midt i en sætning, fortsætter i bidden efter.
    if (rest) Object.assign(foersteNaeste, { sek: forrige[skaer.ai].sek, start: forrige[skaer.ai].start, tekst: `${rest} ${foersteNaeste.tekst}`.trim() });
    const efter = [foersteNaeste, ...naeste.slice(start.ai + 1)].filter((a) => a.tekst);
    return { forrige: foer, naeste: efter };
  }
  if (harTid(forrige) && harTid(naeste)) {
    // Et afsnit i næste bid, der starter før midten, beholdes, hvis det næste først starter efter den forrige bids
    // slutning: så kan det indeholde ord, den forrige bid aldrig fik. Hellere gentaget end tabt.
    const forrigeSlut = naesteStartSek + overlapSek;
    const beholdt = naeste.filter((a, i) => a.sek > midte || !(naeste[i + 1] && naeste[i + 1].sek <= forrigeSlut));
    return { forrige: forrige.filter((a) => a.sek <= midte), naeste: beholdt };
  }
  return { forrige, naeste };
}

function delVarighed(del) {
  if (Number.isFinite(del.varighedSek)) return del.varighedSek;
  const sidste = del.bidder.at(-1);
  return sidste && Number.isFinite(sidste.varighedSek) ? sidste.startSek + sidste.varighedSek : null;
}

/** "30:00-60:00", eller "fra 30:00", når slutningen ikke kendes. */
function tidsrum(fraSek, tilSek) {
  return Number.isFinite(tilSek) && tilSek > fraSek ? `${formaterTid(fraSek)}-${formaterTid(tilSek)}` : `fra ${formaterTid(fraSek)}`;
}

/** Hul-teksten med tidsrum, fx "[Dette afsnit (30:00-60:00) kunne ikke transskriberes]". */
function hulTekst(fraSek, tilSek) {
  return `[Dette afsnit (${tidsrum(fraSek, tilSek)}) kunne ikke transskriberes]`;
}

/** Sætter tidsrummene ind i hul-teksterne i rækkefølge, også når et hul er lagt sammen med andre afsnit. */
function medTidsrum(tekst, mangler = []) {
  let i = 0;
  return String(tekst).split(HUL_TEKST).reduce((ud, stykke, n) => {
    if (n === 0) return stykke;
    const rum = mangler[i++];
    return ud + (rum ? `[Dette afsnit (${rum}) kunne ikke transskriberes]` : HUL_TEKST) + stykke;
  }, '');
}

/** En bid uden et eneste ord. */
function erTom(bid) {
  const afsnitTekst = Array.isArray(bid.afsnit) ? bid.afsnit.map((a) => a.tekst).join('') : '';
  return !String(bid.tekst || '').trim() && !afsnitTekst.trim();
}

/** En bids afsnit med globale tider. Afsnit uden tid beholder null, til overlappet er fjernet. */
function bidAfsnit(bid, start) {
  const egne = Array.isArray(bid.afsnit) && bid.afsnit.length ? bid.afsnit : (bid.tekst ? [{ sek: null, tekst: bid.tekst }] : []);
  return egne.map((a) => ({ sek: a.sek === null ? null : start + a.sek, tekst: a.tekst }));
}

/**
 * Sætter delene sammen til én tidslinje. Hver del (en fil eller en del af en afbrudt optagelse) har sine bidder.
 * Giver afsnittene, teksten uden tider, hvor hver del starter (til bilaget) og antallet af huller.
 */
function samlDele(dele) {
  const afsnit = [];
  const ud = [];
  let huller = 0;
  const mangler = [];
  let forskydning = 0;
  let kendt = false;
  dele.forEach((del, d) => {
    const delStart = forskydning;
    ud.push({ fra: afsnit.length, startSek: delStart, overskrift: del.filnavn ? `Del ${d + 1}: ${del.filnavn}` : null });
    if (d > 0 && del.afbrudt) afsnit.push({ sek: delStart, tekst: AFBRUDT_TEKST });

    let samlet = [];
    let forrigeMangler = true;
    const delSek = delVarighed(del);
    for (const bid of del.bidder) {
      const start = delStart + bid.startSek;
      // En bid med længde, men uden ord, godtages aldrig som stilhed: den står som et hul med tidsrum.
      const laengde = bid.varighedSek > 0 ? bid.varighedSek : (del.bidder.length === 1 && delSek > 0 ? delSek : 0);
      if (bid.mangler || (laengde > 0 && erTom(bid))) {
        samlet.push({ sek: start, tekst: HUL_TEKST });
        huller++;
        mangler.push(tidsrum(start, laengde > 0 ? start + laengde : null));
        forrigeMangler = true;
        continue;
      }
      let nye = bidAfsnit(bid, start);
      if (!forrigeMangler && bid.overlapSek > 0) {
        const r = fjernOverlap(samlet, nye, { naesteStartSek: start, overlapSek: bid.overlapSek });
        samlet = r.forrige;
        nye = r.naeste;
      }
      // Tekst uden tider får først bidens start, når hele delen er samlet, så overlappet stadig findes ved ordene.
      samlet.push(...nye.map((a) => ({ sek: a.sek, tekst: a.tekst, start: a.start ?? start })));
      forrigeMangler = false;
    }
    afsnit.push(...samlet.map((a) => ({ sek: a.sek ?? a.start ?? delStart, tekst: a.tekst })));

    if (delSek !== null) kendt = true;
    forskydning += delSek ?? 0;
  });

  // Tiderne må aldrig falde, så emner og bilag kan følge dem.
  let hoejeste = 0;
  for (const a of afsnit) {
    hoejeste = Math.max(hoejeste, a.sek);
    a.sek = hoejeste;
  }
  return { afsnit, tekst: samletTekst(afsnit), dele: ud, huller, mangler, varighedSek: kendt ? forskydning : null };
}

module.exports = { fjernOverlap, samlDele, hulTekst, medTidsrum, HUL_TEKST, AFBRUDT_TEKST };
