'use strict';

/**
 * Samler bidder og dele til én transskription med én tidslinje.
 * Lange optagelser klippes på telefonen i bidder med overlap. Her fjernes overlappet, så hvert ord står én gang.
 * Ordene skrives aldrig om: der klippes kun mellem hele ord. Hellere et par ord gentaget end ét ord tabt.
 */

const { samletTekst } = require('./afsnit.js');

const HUL_TEKST = '[Dette stykke kunne ikke transskriberes]';
const AFBRUDT_TEKST = '[Optagelsen blev afbrudt her]';
// Overlappets ord søges lidt uden for selve overlappet, da Flashs tider er anslået.
const MARGEN_SEK = 15;
const MAKS_ORD_UDEN_TID = 150;
const MIN_FAELLES_ORD = 6;

const ordAf = (tekst) => String(tekst).split(/\s+/).filter(Boolean);
const normaliser = (ord) => ord.toLocaleLowerCase('da-DK').replace(/[^\p{L}\p{N}]/gu, '');
const harTid = (afsnit) => afsnit.length > 0 && afsnit.every((a) => a.sek !== null);

/** Ordene i de afsnit, der kan ligge i overlappet: [{ ai, wi, n }]. */
function vindue(afsnit, { fraSlut, graense }) {
  const ud = [];
  afsnit.forEach((a, ai) => {
    const medTid = a.sek !== null;
    if (medTid && (fraSlut ? a.sek < graense : a.sek > graense)) return;
    ordAf(a.tekst).forEach((w, wi) => ud.push({ ai, wi, n: normaliser(w), sek: a.sek }));
  });
  if (fraSlut) return ud.slice(-MAKS_ORD_UDEN_TID * 2);
  return ud.slice(0, MAKS_ORD_UDEN_TID * 2);
}

/** Den længste fælles række af ord, nærmest midten ved lige lange. { i, j, laengde } eller null. */
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
  const hale = vindue(forrige, { fraSlut: true, graense: naesteStartSek - MARGEN_SEK });
  const hoved = vindue(naeste, { fraSlut: false, graense: naesteStartSek + overlapSek + MARGEN_SEK });
  const fund = faellesRaekke(hale, hoved, midte);

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
  let forskydning = 0;
  let kendt = false;
  dele.forEach((del, d) => {
    const delStart = forskydning;
    ud.push({ fra: afsnit.length, startSek: delStart, overskrift: del.filnavn ? `Del ${d + 1}: ${del.filnavn}` : null });
    if (d > 0 && del.afbrudt) afsnit.push({ sek: delStart, tekst: AFBRUDT_TEKST });

    let samlet = [];
    let forrigeMangler = true;
    for (const bid of del.bidder) {
      const start = delStart + bid.startSek;
      if (bid.mangler) {
        samlet.push({ sek: start, tekst: HUL_TEKST });
        huller++;
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

    const v = delVarighed(del);
    if (v !== null) kendt = true;
    forskydning += v ?? 0;
  });

  // Tiderne må aldrig falde, så emner og bilag kan følge dem.
  let hoejeste = 0;
  for (const a of afsnit) {
    hoejeste = Math.max(hoejeste, a.sek);
    a.sek = hoejeste;
  }
  return { afsnit, tekst: samletTekst(afsnit), dele: ud, huller, varighedSek: kendt ? forskydning : null };
}

module.exports = { fjernOverlap, samlDele, HUL_TEKST, AFBRUDT_TEKST };
