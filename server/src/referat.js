'use strict';

/**
 * Laver et referat af en transskription med en Gemini-tekstmodel.
 * Samme nøgle og betalte vilkår som transskriptionen, og intet gemmes hos Google (store: false).
 * Svaret kommer som JSON efter et skema, der følger optagelsens type, så tomme afsnit altid kan udelades.
 */

const { BASE, GeminiFejl, httpFejl, udtraekTekst, hentUdenGraense } = require('./gemini.js');
const { TYPER, ETIKET, BESKRIVELSE, FELTER, AFSNIT, laesType } = require('./typer.js');

const KORT_SEKUNDER = 30;
const STANDARD_TITEL = 'Optagelse';
// De typer, modellen kan vælge imellem, når brugeren har valgt Automatisk.
const VALGBARE = TYPER.filter((t) => t !== 'automatisk');

const tekstFelt = { type: 'string' };
const liste = { type: 'array', items: { type: 'string' } };
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

/** Korte noter får kun den rensede tekst. En påmindelse får også sin huskeliste. */
function lavSkema({ type, kort }) {
  const properties = { titel: tekstFelt };
  if (type === 'automatisk') properties.type = { type: 'string', enum: VALGBARE };
  if (kort) {
    properties.renTekst = tekstFelt;
    if (type === 'automatisk' || type === 'paamindelse') properties.huskeliste = liste;
  } else {
    properties.opsummering = tekstFelt;
    for (const felt of felterFor(type)) properties[felt] = felt === 'opgaver' ? opgaveSkema : liste;
  }
  return { type: 'object', properties, required: Object.keys(properties) };
}

const REGLER = [
  'Intet må opfindes. Medtag kun det, der faktisk blev sagt i transskriptionen.',
  'Tilføj ikke roller, titler, årsager eller sammenhænge, der ikke blev sagt.',
  'Er noget uklart eller utydeligt, så skriv "[uklart]" i stedet for at gætte.',
  'Gengiv tal, mål, mængder, datoer, frister, adresser, navne og fagudtryk præcist, som de blev sagt.',
  'Tilføj ingen egne vurderinger, anbefalinger eller konklusioner.',
  'Skriv på dansk i en kort, saglig referatstil.',
  'Fjern fyldord, gentagelser, small talk og afbrydelser.',
];

function opgaveDel({ kort, type }) {
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
  return del;
}

function lavPrompt({ tekst, titel, kort, type = 'automatisk' }) {
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
    ...opgaveDel({ kort, type }),
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
function normaliser(raa, { titel, kort, tekst, type }) {
  const r = raa && typeof raa === 'object' ? raa : {};
  const valgt = type !== 'automatisk' ? type : VALGBARE.includes(r.type) ? r.type : 'andet';
  const tilladte = new Set(kort ? (valgt === 'paamindelse' ? ['huskeliste'] : []) : AFSNIT[valgt].map((a) => a.felt));
  const felt = (navn) => {
    if (!tilladte.has(navn)) return [];
    return navn === 'opgaver' ? opgaveListe(r.opgaver) : strengListe(r[navn]);
  };
  return {
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
}

function lavReferat({ noegle, model, timeoutMs, hent = hentUdenGraense }) {
  return {
    async lav({ tekst, titel, type, varighedSek, signal }) {
      const renTitel = streng(titel);
      const valgtType = laesType(type);
      const kort = Number.isFinite(varighedSek) && varighedSek < KORT_SEKUNDER;
      const samlet = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      try {
        const svar = await hent(`${BASE}/v1beta/interactions`, {
          method: 'POST',
          signal: samlet,
          headers: { 'x-goog-api-key': noegle, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            input: [{ type: 'text', text: lavPrompt({ tekst, titel: renTitel, kort, type: valgtType }) }],
            response_format: { type: 'text', mime_type: 'application/json', schema: lavSkema({ type: valgtType, kort }) },
            generation_config: { thinking_level: 'low' },
            // Ellers gemmes referatet i 55 dage hos Google.
            store: false,
          }),
        });
        // Optagelsen var i orden, når referatet fejler. Derfor aldrig 'format', som ville få brugeren til at slette den.
        if (!svar.ok) throw new GeminiFejl(httpFejl(svar.status, 'referat').kode === 'noegle' ? 'noegle' : 'tjeneste', `referat: status ${svar.status}`);
        const krop = await svar.json();
        if (krop.status !== 'completed') throw new GeminiFejl('tjeneste', `referat: status ${krop.status}`);
        let raa;
        try {
          raa = JSON.parse(udtraekTekst(krop));
        } catch {
          throw new GeminiFejl('tjeneste', 'referat: ugyldig JSON');
        }
        return normaliser(raa, { titel: renTitel, kort, tekst, type: valgtType });
      } catch (e) {
        if (e instanceof GeminiFejl) throw e;
        // Originalbeskeden kan indeholde detaljer fra kaldet, så den sendes ikke videre.
        throw new GeminiFejl('tjeneste', `referat: netværk ${e && e.name}`);
      }
    },
  };
}

module.exports = { lavReferat, lavPrompt };
