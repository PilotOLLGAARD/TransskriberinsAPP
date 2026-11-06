'use strict';

/**
 * Laver et referat af en transskription med en Gemini-tekstmodel.
 * Samme nøgle og betalte vilkår som transskriptionen, og intet gemmes hos Google (store: false).
 * Svaret kommer som JSON efter et skema, der følger optagelsens type, så tomme afsnit altid kan udelades.
 */

const { BASE, GeminiFejl, svarFejl, fejltype, udtraekTekst, hentUdenGraense } = require('./gemini.js');
const { medGenforsoeg } = require('./genforsoeg.js');
const { TYPER, ETIKET, BESKRIVELSE, FELTER, AFSNIT, laesType } = require('./typer.js');
const { kontrollerTal } = require('./tal.js');
const { harTider, medTider, knytEmner } = require('./afsnit.js');

const KORT_SEKUNDER = 30;
// Kortere optagelser deles ikke i emner. Bilaget viser kun tidspunkterne.
const EMNER_MIN_SEKUNDER = 120;
const EMNER_MIN_ORD = 300;
const STANDARD_TITEL = 'Optagelse';
// De typer, modellen kan vælge imellem, når brugeren har valgt Automatisk.
const VALGBARE = TYPER.filter((t) => t !== 'automatisk');

const tekstFelt = { type: 'string' };
const liste = { type: 'array', items: { type: 'string' } };
const emneSkema = {
  type: 'array',
  items: { type: 'object', properties: { tid: tekstFelt, undertitel: tekstFelt }, required: ['tid', 'undertitel'] },
};
const opgaveSkema = {
  type: 'array',
  items: {
    type: 'object',
    properties: { hvem: { type: 'string' }, hvad: { type: 'string' }, hvornaar: { type: 'string' } },
    required: ['hvad'],
  },
};

/** Felterne i et fuldt referat. Ved Automatisk er det alle typers felter, da modellen først vælger typen. */
function felterFor(type) {
  const typer = type === 'automatisk' ? VALGBARE : [type];
  return [...new Set(typer.flatMap((t) => AFSNIT[t].map((a) => a.felt)))];
}

/** Korte noter får kun den rensede tekst. En påmindelse får også sin huskeliste. Lange optagelser får emner. */
function lavSkema({ type, kort, emner }) {
  const properties = { titel: tekstFelt };
  if (type === 'automatisk') properties.type = { type: 'string', enum: VALGBARE };
  if (kort) {
    properties.renTekst = tekstFelt;
    if (type === 'automatisk' || type === 'paamindelse') properties.huskeliste = liste;
  } else {
    properties.opsummering = tekstFelt;
    for (const felt of felterFor(type)) properties[felt] = felt === 'opgaver' ? opgaveSkema : liste;
    if (emner) properties.emner = emneSkema;
  }
  return { type: 'object', properties, required: Object.keys(properties) };
}

const REGLER = [
  'Intet må opfindes. Medtag kun det, der faktisk blev sagt i transskriptionen.',
  'Tilføj ikke roller, titler, årsager eller sammenhænge, der ikke blev sagt.',
  'Nævn ikke steder, lande, personer, firmaer eller årstal, der ikke står i transskriptionen, heller ikke når de virker indlysende.',
  'Er noget uklart eller utydeligt, så skriv "[uklart]" i stedet for at gætte.',
  'Gengiv tal, mål, mængder, datoer, frister, adresser, navne og fagudtryk præcist, som de blev sagt.',
  'Er du i tvivl om et tal, et mål, en dato eller en frist, så skriv "[uklart]" i stedet for tallet. Gæt aldrig, og ret aldrig et tal, der lyder forkert eller ufuldstændigt.',
  'Retter taleren sig selv (fx "tre meter, nej fire meter"), så brug kun det rettede tal.',
  'Et talord, der ikke er et gyldigt dansk tal, eller et tal, der kan være hørt forkert, er uklart: skriv "[uklart]". Lav det ikke om til et tal, der ligner.',
  'Omregn ikke enheder, og læg ikke tal sammen. Tilføj ikke årstal, ugedage eller datoer, der ikke blev sagt.',
  'Tilføj ingen egne vurderinger, anbefalinger eller konklusioner.',
  'Skriv på dansk i en kort, saglig referatstil.',
  'Fjern fyldord, gentagelser, small talk og afbrydelser.',
];

const EMNE_REGLER = [
  'Del også transskriptionen i emner i feltet emner, ca. ét emne pr. 3-5 minutter, mindst 2 og højst 20:',
  '- tid: tidspunktet for det afsnit, hvor emnet begynder, præcis som det står i transskriptionen (fx "04:26").',
  '- undertitel: 2-6 ord, der KUN beskriver, hvad der faktisk bliver sagt i emnet. Intet opfundet og ingen vurdering.',
  'Tidspunkterne i [mm:ss] viser kun, hvor i lyden afsnittene begynder. Skriv ikke tidspunkterne i referatet.',
];

function opgaveDel({ kort, type, emner }) {
  const automatisk = type === 'automatisk';
  const huskeliste = `skriv også i feltet huskeliste: ${FELTER.huskeliste.vejledning}`;
  if (kort) {
    const del = [
      'Optagelsen er en kort note. Lav ikke et referat.',
      'Ryd blot teksten op i feltet renTekst: ret tegnsætning og fjern fyldord og gentagelser, men bevar indholdet.',
    ];
    if (type === 'paamindelse') del.push(`Det er en påmindelse, så ${huskeliste}`);
    if (automatisk) del.push(`Er typen paamindelse, så ${huskeliste} Ellers lad huskeliste være tom.`);
    return del;
  }
  const del = [
    'Lav et referat med disse felter:',
    '- opsummering: 1-3 sætninger om, hvad optagelsen handlede om.',
    ...felterFor(type).map((felt) => `- ${felt}: ${FELTER[felt].vejledning}`),
  ];
  if (automatisk) {
    del.push('Udfyld kun felterne for den valgte type, og lad de andre lister være tomme:');
    del.push(...VALGBARE.map((t) => `- ${t}: ${AFSNIT[t].map((a) => a.felt).join(', ')}`));
  }
  del.push('Lad en liste være tom, hvis der ikke er noget til den.');
  if (emner) del.push('', ...EMNE_REGLER);
  return del;
}

function lavPrompt({ tekst, titel, kort, type = 'automatisk', emner = false }) {
  const titelDel = titel
    ? `Brugerens titel på optagelsen: "${titel}". Brug den som titel.`
    : 'Brugeren har ikke givet optagelsen en titel. Lav selv en kort, sigende titel på 3-8 ord ud fra indholdet.';
  const typeDel = type === 'automatisk'
    ? ['Vælg først den type, der passer bedst, og skriv den i feltet type:', ...VALGBARE.map((t) => `- ${t}: ${BESKRIVELSE[t]}.`)]
    : [`Optagelsen er af typen ${ETIKET[type]}.`];
  return [
    'Du skriver for ØLLGAARD, rådgivende ingeniører. Du får transskriptionen af en lydoptagelse fra en medarbejder.',
    '',
    'Regler:',
    ...REGLER.map((r) => `- ${r}`),
    '',
    ...typeDel,
    '',
    ...opgaveDel({ kort, type, emner }),
    '',
    titelDel,
    '',
    'Transskription:',
    '"""',
    tekst,
    '"""',
  ].join('\n');
}

function streng(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function strengListe(v) {
  return Array.isArray(v) ? v.map(streng).filter(Boolean) : [];
}

function opgaveListe(v) {
  if (!Array.isArray(v)) return [];
  const ud = [];
  for (const o of v) {
    if (!o || typeof o !== 'object' || !streng(o.hvad)) continue;
    const opgave = { hvad: streng(o.hvad) };
    if (streng(o.hvem)) opgave.hvem = streng(o.hvem);
    if (streng(o.hvornaar)) opgave.hvornaar = streng(o.hvornaar);
    ud.push(opgave);
  }
  return ud;
}

/**
 * Gør modellens svar sikkert at bruge: forkerte typer bliver til tomme felter, og felter,
 * der ikke hører til optagelsens type, tømmes. Alle felter er altid med.
 */
function normaliser(raa, { titel, kort, tekst, type, afsnit, emner }) {
  const r = raa && typeof raa === 'object' ? raa : {};
  const valgt = type !== 'automatisk' ? type : VALGBARE.includes(r.type) ? r.type : 'andet';
  const tilladte = new Set(kort ? (valgt === 'paamindelse' ? ['huskeliste'] : []) : AFSNIT[valgt].map((a) => a.felt));
  const felt = (navn) => {
    if (!tilladte.has(navn)) return [];
    return navn === 'opgaver' ? opgaveListe(r.opgaver) : strengListe(r[navn]);
  };
  const referat = {
    titel: titel || streng(r.titel) || STANDARD_TITEL,
    type: valgt,
    kort,
    opsummering: kort ? '' : streng(r.opsummering),
    hovedpunkter: felt('hovedpunkter'),
    beslutninger: felt('beslutninger'),
    opgaver: felt('opgaver'),
    fejlOgMangler: felt('fejlOgMangler'),
    maalOgMaengder: felt('maalOgMaengder'),
    huskeliste: felt('huskeliste'),
    aabneSpoergsmaal: felt('aabneSpoergsmaal'),
    renTekst: kort ? streng(r.renTekst) || tekst : '',
  };
  // Emnerne knyttes til afsnittene her i koden: { fra: afsnittets nummer, undertitel }.
  if (emner) referat.emner = knytEmner(afsnit, r.emner);
  return referat;
}

/**
 * Skal referatet dele optagelsen i emner? Kun med tidspunkter fra Flash og kun for optagelser
 * på mindst 2 minutter, eller med ukendt varighed mindst ca. 300 ord.
 */
function vilEmner({ afsnit, kort, varighedSek, tekst }) {
  if (kort || !Array.isArray(afsnit) || !harTider(afsnit)) return false;
  if (Number.isFinite(varighedSek)) return varighedSek >= EMNER_MIN_SEKUNDER;
  return String(tekst).split(/\s+/).filter(Boolean).length >= EMNER_MIN_ORD;
}

function lavReferat({ noegle, model, timeoutMs, hent = hentUdenGraense, log = () => {}, nu = Date.now, vent, tilfaeldig }) {
  return {
    /**
     * tekst er transskriptionen uden tidspunkter. afsnit ([{ sek, tekst }], kan mangle) har de rettede
     * tidspunkter, som kun bruges til emnerne. Kontrollen af tal ser aldrig tidspunkterne.
     */
    async lav({ tekst, titel, type, varighedSek, signal, afsnit }) {
      const renTitel = streng(titel);
      const valgtType = laesType(type);
      const kort = Number.isFinite(varighedSek) && varighedSek < KORT_SEKUNDER;
      const emner = vilEmner({ afsnit, kort, varighedSek, tekst });
      const kilde = emner ? medTider(afsnit) : tekst;
      const samlet = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      // Genforsøg skal kunne vente færdig inden for referatets egen grænse.
      const frist = nu() + timeoutMs;
      try {
        // Kroppen er en færdig tekst, så referatet kan sikkert bestilles igen.
        const svar = await medGenforsoeg(() => hent(`${BASE}/v1beta/interactions`, {
          method: 'POST',
          signal: samlet,
          headers: { 'x-goog-api-key': noegle, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            input: [{ type: 'text', text: lavPrompt({ tekst: kilde, titel: renTitel, kort, type: valgtType, emner }) }],
            response_format: { type: 'text', mime_type: 'application/json', schema: lavSkema({ type: valgtType, kort, emner }) },
            generation_config: { thinking_level: 'low' },
            // Ellers gemmes referatet i 55 dage hos Google.
            store: false,
          }),
        }), {
          signal: samlet, frist, nu, vent, tilfaeldig,
          vedGenforsoeg: (t) => log({ haendelse: 'gemini-genforsoeg', hvor: 'referat', ...t }),
        });
        if (!svar.ok) {
          const e = await svarFejl(svar, 'referat');
          // Optagelsen var i orden, når referatet fejler. Derfor aldrig 'format', som ville få brugeren til at slette den.
          if (e.kode === 'format') e.kode = 'tjeneste';
          throw e;
        }
        const krop = await svar.json();
        if (krop.status !== 'completed') throw new GeminiFejl('tjeneste', `referat: status ${krop.status}`, { trin: 'referat' });
        let raa;
        try {
          raa = JSON.parse(udtraekTekst(krop));
        } catch {
          throw new GeminiFejl('tjeneste', 'referat: ugyldig JSON', { trin: 'referat' });
        }
        // Hvert tal i referatet skal kunne findes i transskriptionen. Ellers bliver det [uklart].
        // Kilden er teksten uden tidspunkter, så et tidspunkt aldrig tæller som et sagt tal.
        const referat = normaliser(raa, { titel: renTitel, kort, tekst, type: valgtType, afsnit, emner });
        return kontrollerTal(referat, tekst, { brugerTitel: renTitel }).referat;
      } catch (e) {
        if (e instanceof GeminiFejl) throw e;
        // Originalbeskeden kan indeholde detaljer fra kaldet, så den sendes ikke videre.
        throw new GeminiFejl('tjeneste', `referat: netværk ${fejltype(e)}`, { trin: 'referat', fejltype: fejltype(e) });
      }
    },
  };
}

module.exports = { lavReferat, lavPrompt };
