'use strict';

/**
 * Optagelsens typer og de afsnit, referatet har for hver type.
 * Referat, PDF og mail læser alle herfra, så afsnittene altid er de samme.
 */

const TYPER = ['automatisk', 'byggenotat', 'moede', 'paamindelse', 'andet'];

const ETIKET = {
  automatisk: 'Automatisk',
  byggenotat: 'Byggenotat',
  moede: 'Møde',
  paamindelse: 'Påmindelse',
  andet: 'Andet',
};

/** Til modellen, når den selv skal vælge typen. */
const BESKRIVELSE = {
  byggenotat: 'noter fra byggepladsen, fx en gennemgang, et tilsyn, fejl og mangler eller opmåling',
  moede: 'et møde eller en samtale mellem flere personer',
  paamindelse: 'en kort huskeseddel til den, der taler',
  andet: 'alt andet',
};

const FELTER = {
  hovedpunkter: { overskrift: 'Hovedpunkter', vejledning: 'kun de værdifulde og nødvendige oplysninger.' },
  beslutninger: { overskrift: 'Beslutninger', vejledning: 'beslutninger, der blev truffet.' },
  opgaver: {
    overskrift: 'Opgaver og aftaler',
    vejledning: 'opgaver og aftaler med hvem, hvad og hvornår. Udelad hvem eller hvornår, hvis det ikke blev sagt. '
      + 'Skal den, der taler, selv gøre noget, så skriv "Mig" som hvem.',
  },
  fejlOgMangler: { overskrift: 'Fejl og mangler', vejledning: 'fejl og mangler, der blev observeret.' },
  maalOgMaengder: { overskrift: 'Mål og mængder', vejledning: 'mål, mængder, antal og enheder præcis som sagt.' },
  huskeliste: { overskrift: 'Huskeliste', vejledning: 'det, der skal huskes eller gøres, som korte punkter.' },
  aabneSpoergsmaal: { overskrift: 'Åbne spørgsmål', vejledning: 'spørgsmål, der stadig er åbne.' },
};

const afsnit = (...felter) => felter.map((felt) => ({ felt, ...FELTER[felt] }));

const AFSNIT = {
  byggenotat: afsnit('hovedpunkter', 'fejlOgMangler', 'maalOgMaengder', 'opgaver'),
  moede: afsnit('hovedpunkter', 'beslutninger', 'opgaver', 'aabneSpoergsmaal'),
  paamindelse: afsnit('huskeliste'),
  andet: afsnit('hovedpunkter'),
};

/** Ukendt eller manglende type bliver Automatisk. */
function laesType(raa) {
  const t = typeof raa === 'string' ? raa.trim() : '';
  return TYPER.includes(t) ? t : 'automatisk';
}

module.exports = { TYPER, ETIKET, BESKRIVELSE, FELTER, AFSNIT, laesType };
