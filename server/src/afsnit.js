'use strict';

/**
 * Afsnit og tidspunkter i transskriptionen.
 * Flash starter hvert afsnit med tidspunktet i lyden som [mm:ss] eller [t:mm:ss]. Markørerne bruges kun til at
 * dele bilaget op. De fjernes fra den tekst, der bruges til alt andet (appen, kontrollen af tal og referatet),
 * og teksten selv skrives aldrig om.
 */

// Kun i starten af en linje: et tidspunkt i selve teksten ("kl. [14:30]") skal blive stående.
// Minutter må gå over 59, hvis Flash ikke skriver timer. Sekunder skal være gyldige, ellers er det ikke en markør.
const MARKOER = /^[ \t]*\[(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)\]/gm;
const TID = /^\[?(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)\]?$/;
const MAX_UNDERTITEL_ORD = 6;
const MAX_UNDERTITEL_TEGN = 60;

const sekunder = (t, m, s) => Number(t || 0) * 3600 + Number(m) * 60 + Number(s);
const antalOrd = (tekst) => String(tekst).split(/\s+/).filter(Boolean).length;
const renLinjer = (tekst) => tekst.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n');

/**
 * Deler Flashs svar i afsnit: [{ sek, tekst }]. Uden markører er hele teksten ét afsnit med sek null.
 * Tekst før første markør får tiden 0. Tider, der falder, sættes til tiden før, så rækkefølgen holder.
 */
function laesAfsnit(tekst) {
  const kilde = typeof tekst === 'string' ? tekst.trim() : '';
  if (!kilde) return [];
  const markoerer = [...kilde.matchAll(MARKOER)];
  if (!markoerer.length) return [{ sek: null, tekst: kilde }];

  const ud = [];
  let sidste = 0;
  const tilfoej = (sek, del) => {
    const ren = renLinjer(del);
    if (ren) ud.push({ sek, tekst: ren });
  };
  tilfoej(0, kilde.slice(0, markoerer[0].index));
  markoerer.forEach((m, i) => {
    sidste = Math.max(sidste, sekunder(m[1], m[2], m[3]));
    const slut = i + 1 < markoerer.length ? markoerer[i + 1].index : kilde.length;
    tilfoej(sidste, kilde.slice(m.index + m[0].length, slut));
  });
  return ud;
}

const harTider = (afsnit) => afsnit.some((a) => a.sek !== null);

/** Teksten uden markører, ét afsnit pr. linje. Den bruges til appen, kontrollen af tal og referatet. */
const samletTekst = (afsnit) => afsnit.map((a) => a.tekst).join('\n');

/**
 * Flashs tidslinje er presset ca. 8 % sammen. Rettes lineært med optagelsens kendte længde: Flashs slutpunkt
 * anslås ud fra ordene i sidste afsnit, og alle tider ganges med varighed / slutpunkt. Hele sekunder,
 * aldrig over varigheden og aldrig faldende. Ukendt varighed giver uændrede tider.
 */
function skalerTider(afsnit, varighedSek) {
  if (!(Number.isFinite(varighedSek) && varighedSek > 0) || !harTider(afsnit)) return afsnit;
  const sidste = afsnit.at(-1);
  const ordFoer = afsnit.slice(0, -1).reduce((sum, a) => sum + antalOrd(a.tekst), 0);
  const slutpunkt = ordFoer ? sidste.sek * (1 + antalOrd(sidste.tekst) / ordFoer) : 0;
  const raa = slutpunkt > 0 ? varighedSek / slutpunkt : 1;
  // Kun en rimelig rettelse (målt ca. 1,08). Lang stilhed til sidst eller en forkert varighed ville ellers strække alt.
  const faktor = raa >= 0.95 && raa <= 1.25 ? raa : 1;
  let forrige = 0;
  return afsnit.map((a) => {
    forrige = Math.max(forrige, Math.min(Math.floor(varighedSek), Math.round(a.sek * faktor)));
    return { sek: forrige, tekst: a.tekst };
  });
}

// Et afsnit længere end dette deles. Målet er et stykke for hver ca. 45 s eller 150 ord.
const MAKS_AFSNIT_SEK = 90;
const MAKS_AFSNIT_ORD = 200;
const MAAL_SEK = 45;
const MAAL_ORD = 150;
// Sætningsskel: efter . ! ? … (evt. med anførselstegn eller parentes) og før et stort bogstav eller [uklart].
// Så deles der ikke efter "ca. 20" eller "kl. 14".
const SAETNINGSSKEL = /(?<=[.!?…]["'”»)\]]*)\s+(?=[\p{Lu}[«"])/u;

/** Afsnittets sætninger og linjer: [{ skel, tekst }], hvor skel er det, der stod foran ("\n" eller " "). */
function enheder(tekst) {
  return tekst.split('\n').flatMap((linje, i) => linje.split(SAETNINGSSKEL)
    .map((s, j) => ({ skel: j ? ' ' : i ? '\n' : '', tekst: s.trim() }))
    .filter((e) => e.tekst));
}

/**
 * I en samtale uden lange pauser kan Flash skrive minutter af tale som ét afsnit (set: hele optagelsen
 * under [00:00]). Så kan emnerne ikke knyttes til tiden. Et afsnit over 90 s eller 200 ord deles derfor ved
 * sætninger og linjeskift i stykker på ca. 45 s, og hvert stykkes tid anslås ud fra antal ord mellem
 * afsnittets tid og det næstes (sidste afsnit: optagelsens længde). Ordene ændres aldrig.
 * Uden tider, uden kendt slutning eller uden sætningsskel røres afsnittet ikke.
 */
function delLangeAfsnit(afsnit, varighedSek) {
  if (!harTider(afsnit)) return afsnit;
  const kendtSlut = Number.isFinite(varighedSek) && varighedSek > 0 ? Math.floor(varighedSek) : null;
  return afsnit.flatMap((a, i) => {
    const slut = i + 1 < afsnit.length ? afsnit[i + 1].sek : kendtSlut;
    const ordIalt = antalOrd(a.tekst);
    if (slut === null || a.sek === null || slut <= a.sek) return [a];
    const spaend = slut - a.sek;
    if (spaend <= MAKS_AFSNIT_SEK && ordIalt <= MAKS_AFSNIT_ORD) return [a];
    const dele = enheder(a.tekst);
    if (dele.length < 2) return [a];

    const antal = Math.max(Math.ceil(spaend / MAAL_SEK), Math.ceil(ordIalt / MAAL_ORD));
    const maal = ordIalt / antal;
    const stykker = [];
    let ordFoer = 0;
    let nu = null;
    for (const d of dele) {
      if (!nu || nu.ord >= maal) {
        nu = { ordFoer, skel: d.skel, tekst: d.tekst, ord: 0 };
        stykker.push(nu);
      } else {
        nu.tekst += d.skel + d.tekst;
      }
      const n = antalOrd(d.tekst);
      nu.ord += n;
      ordFoer += n;
    }
    // Et lille stykke til sidst lægges til det før, så der ikke står en tid over en enkelt sætning.
    if (stykker.length > 1 && stykker.at(-1).ord < maal / 3) {
      const sidste = stykker.pop();
      stykker.at(-1).tekst += sidste.skel + sidste.tekst;
    }
    return stykker.map((s) => ({ sek: a.sek + Math.floor((spaend * s.ordFoer) / ordIalt), tekst: s.tekst }));
  });
}

/** "04:26", og over en time "1:04:12". */
function formaterTid(sek) {
  const s = Math.max(0, Math.round(sek));
  const to = (n) => String(n).padStart(2, '0');
  const timer = Math.floor(s / 3600);
  const minSek = `${to(Math.floor((s % 3600) / 60))}:${to(s % 60)}`;
  return timer ? `${timer}:${minSek}` : minSek;
}

/** Sekunder fra "mm:ss", "t:mm:ss" eller "[mm:ss]", ellers null. */
function laesTid(tekst) {
  if (typeof tekst !== 'string') return null;
  const m = TID.exec(tekst.trim());
  return m ? sekunder(m[1], m[2], m[3]) : null;
}

/** Transskriptionen til referatet med [mm:ss] foran hvert afsnit, så modellen kan angive, hvor et emne begynder. */
const medTider = (afsnit) => afsnit.map((a) => `[${formaterTid(a.sek)}] ${a.tekst}`).join('\n');

/** Højst 6 ord og 60 tegn. Afkortes ved et ord, hvis det kan lade sig gøre. */
function trimUndertitel(tekst) {
  if (typeof tekst !== 'string') return '';
  const ordene = tekst.split(/\s+/).filter(Boolean).slice(0, MAX_UNDERTITEL_ORD);
  while (ordene.length > 1 && ordene.join(' ').length > MAX_UNDERTITEL_TEGN) ordene.pop();
  return [...ordene.join(' ')].slice(0, MAX_UNDERTITEL_TEGN).join('').trim();
}

/**
 * Knytter referatets emner ({ tid, undertitel }) til afsnittene: [{ fra, undertitel }], hvor fra er
 * afsnittets nummer. Findes tidspunktet ikke, bruges det nærmeste efterfølgende afsnit. Emner uden gyldig
 * tid eller undertitel og efter sidste afsnit udelades. Dubletter og forkert rækkefølge ryddes,
 * og første emne starter altid ved første afsnit.
 */
function knytEmner(afsnit, raa) {
  if (!Array.isArray(raa) || !afsnit.length) return [];
  const emner = [];
  for (const e of raa) {
    const sek = laesTid(e?.tid);
    const undertitel = trimUndertitel(e?.undertitel);
    if (sek === null || !undertitel) continue;
    const fra = afsnit.findIndex((a) => a.sek >= sek);
    if (fra >= 0) emner.push({ fra, undertitel });
  }
  emner.sort((a, b) => a.fra - b.fra);
  const ud = emner.filter((e, i) => i === 0 || e.fra !== emner[i - 1].fra);
  if (ud.length) ud[0].fra = 0;
  return ud;
}

// Et afsnit, der ikke slutter med punktum, spørgsmålstegn eller udråbstegn, fortsætter i det næste.
const fortsaetter = (tekst) => !/[.!?…]["'”»)\]]*$/.test(tekst);

/**
 * Afsnittenes tekster. Et afsnit, der fortsætter en sætning, sættes sammen med det før med et mellemrum,
 * men højst til 150 ord, så linjer midt i en sætning (mindst hvert 30. s) ikke bliver én lang blok.
 */
function saml(afsnit) {
  const ud = [];
  for (const a of afsnit) {
    const forrige = ud.at(-1);
    if (forrige && fortsaetter(forrige) && antalOrd(forrige) < 150) ud[ud.length - 1] += ` ${a.tekst}`;
    else ud.push(a.tekst);
  }
  return ud;
}

/**
 * Bilaget til PDF og Word, eller null uden tidspunkter (så vises teksten som før).
 * Med emner: [{ sek, undertitel, afsnit: [tekst, …] }]. Uden: [{ sek, afsnit: [tekst] }] pr. afsnit.
 */
function lavBilag(afsnit, emner = []) {
  if (!afsnit.length || !harTider(afsnit)) return null;
  if (emner.length) {
    return emner.map((e, i) => ({
      sek: afsnit[e.fra].sek,
      undertitel: e.undertitel,
      afsnit: saml(afsnit.slice(e.fra, emner[i + 1]?.fra ?? afsnit.length)),
    }));
  }
  const ud = [];
  for (const a of afsnit) {
    const forrige = ud.at(-1);
    // En sætning, der fortsætter, sættes sammen, men højst 60 s og 150 ord, så tiderne ikke forsvinder.
    const plads = forrige && a.sek - forrige.sek < 60 && antalOrd(forrige.afsnit[0]) < 150;
    if (plads && fortsaetter(forrige.afsnit[0])) forrige.afsnit[0] += ` ${a.tekst}`;
    else ud.push({ sek: a.sek, afsnit: [a.tekst] });
  }
  return ud;
}

module.exports = {
  laesAfsnit, harTider, samletTekst, skalerTider, delLangeAfsnit, formaterTid, laesTid, medTider, trimUndertitel, knytEmner, lavBilag,
};
