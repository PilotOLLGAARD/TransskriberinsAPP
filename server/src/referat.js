'use strict';

/**
 * Laver et referat af en transskription med en Gemini-tekstmodel.
 * Samme nøgle og betalte vilkår som transskriptionen, og intet gemmes hos Google (store: false).
 * Svaret kommer som JSON efter et fast skema, så tomme afsnit altid kan udelades.
 */

const { BASE, GeminiFejl, httpFejl, udtraekTekst, hentUdenGraense } = require('./gemini.js');

const KORT_SEKUNDER = 30;
const STANDARD_TITEL = 'Optagelse';

const liste = { type: 'array', items: { type: 'string' } };

const SKEMA_FULD = {
  type: 'object',
  properties: {
    titel: { type: 'string' },
    opsummering: { type: 'string' },
    hovedpunkter: liste,
    beslutninger: liste,
    opgaver: {
      type: 'array',
      items: {
        type: 'object',
        properties: { hvem: { type: 'string' }, hvad: { type: 'string' }, hvornaar: { type: 'string' } },
        required: ['hvad'],
      },
    },
    fejlOgMangler: liste,
    aabneSpoergsmaal: liste,
  },
  required: ['titel', 'opsummering', 'hovedpunkter', 'beslutninger', 'opgaver', 'fejlOgMangler', 'aabneSpoergsmaal'],
};

const SKEMA_KORT = {
  type: 'object',
  properties: { titel: { type: 'string' }, renTekst: { type: 'string' } },
  required: ['titel', 'renTekst'],
};

const REGLER = [
  'Intet må opfindes. Medtag kun det, der faktisk blev sagt i transskriptionen.',
  'Tilføj ikke roller, titler, årsager eller sammenhænge, der ikke blev sagt.',
  'Er noget uklart eller utydeligt, så skriv "[uklart]" i stedet for at gætte.',
  'Gengiv tal, mål, mængder, datoer, frister, adresser, navne og fagudtryk præcist, som de blev sagt.',
  'Tilføj ingen egne vurderinger, anbefalinger eller konklusioner.',
  'Skriv på dansk i en kort, saglig referatstil.',
  'Fjern fyldord, gentagelser, small talk og afbrydelser.',
];

function lavPrompt({ tekst, titel, kort }) {
  const titelDel = titel
    ? `Brugerens titel på optagelsen: "${titel}". Brug den som titel.`
    : 'Brugeren har ikke givet optagelsen en titel. Lav selv en kort, sigende titel på 3-8 ord ud fra indholdet.';
  const opgave = kort
    ? [
      'Optagelsen er en kort note. Lav ikke et referat.',
      'Ryd blot teksten op i feltet renTekst: ret tegnsætning og fjern fyldord og gentagelser, men bevar indholdet.',
    ]
    : [
      'Lav et referat med disse felter:',
      '- opsummering: 1-3 sætninger om, hvad optagelsen handlede om.',
      '- hovedpunkter: kun de værdifulde og nødvendige oplysninger.',
      '- beslutninger: beslutninger, der blev truffet.',
      '- opgaver: opgaver og aftaler med hvem, hvad og hvornår. Udelad hvem eller hvornår, hvis det ikke blev sagt.',
      '  Skal den, der taler, selv gøre noget, så skriv "Mig" som hvem.',
      '- fejlOgMangler: fejl og mangler, der blev observeret.',
      '- aabneSpoergsmaal: spørgsmål, der stadig er åbne.',
      'Lad en liste være tom, hvis der ikke er noget til den.',
    ];
  return [
    'Du skriver for ØLLGAARD, rådgivende ingeniører. Du får transskriptionen af en lydoptagelse fra en medarbejder.',
    '',
    'Regler:',
    ...REGLER.map((r) => `- ${r}`),
    '',
    ...opgave,
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

/** Gør modellens svar sikkert at bruge: forkerte typer bliver til tomme felter. */
function normaliser(raa, { titel, kort, tekst }) {
  const r = raa && typeof raa === 'object' ? raa : {};
  return {
    titel: titel || streng(r.titel) || STANDARD_TITEL,
    kort,
    opsummering: kort ? '' : streng(r.opsummering),
    hovedpunkter: kort ? [] : strengListe(r.hovedpunkter),
    beslutninger: kort ? [] : strengListe(r.beslutninger),
    opgaver: kort ? [] : opgaveListe(r.opgaver),
    fejlOgMangler: kort ? [] : strengListe(r.fejlOgMangler),
    aabneSpoergsmaal: kort ? [] : strengListe(r.aabneSpoergsmaal),
    renTekst: kort ? streng(r.renTekst) || tekst : '',
  };
}

function lavReferat({ noegle, model, timeoutMs, hent = hentUdenGraense }) {
  return {
    async lav({ tekst, titel, varighedSek, signal }) {
      const renTitel = streng(titel);
      const kort = Number.isFinite(varighedSek) && varighedSek < KORT_SEKUNDER;
      const samlet = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      try {
        const svar = await hent(`${BASE}/v1beta/interactions`, {
          method: 'POST',
          signal: samlet,
          headers: { 'x-goog-api-key': noegle, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            input: [{ type: 'text', text: lavPrompt({ tekst, titel: renTitel, kort }) }],
            response_format: { type: 'text', mime_type: 'application/json', schema: kort ? SKEMA_KORT : SKEMA_FULD },
            generation_config: { thinking_level: 'low' },
            // Ellers gemmes referatet i 55 dage hos Google.
            store: false,
          }),
        });
        if (!svar.ok) throw httpFejl(svar.status, 'referat');
        const krop = await svar.json();
        if (krop.status !== 'completed') throw new GeminiFejl('tjeneste', `referat: status ${krop.status}`);
        let raa;
        try {
          raa = JSON.parse(udtraekTekst(krop));
        } catch {
          throw new GeminiFejl('tjeneste', 'referat: ugyldig JSON');
        }
        return normaliser(raa, { titel: renTitel, kort, tekst });
      } catch (e) {
        if (e instanceof GeminiFejl) throw e;
        // Originalbeskeden kan indeholde detaljer fra kaldet, så den sendes ikke videre.
        throw new GeminiFejl('tjeneste', `referat: netværk ${e && e.name}`);
      }
    },
  };
}

module.exports = { lavReferat, lavPrompt };
