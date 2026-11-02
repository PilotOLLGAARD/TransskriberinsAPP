// Optagelsens typer. Nøglerne er de samme som serverens (server/src/typer.js) og sendes i x-type.

export const STANDARD_TYPE = 'automatisk';

export const TYPER = [
  { noegle: 'automatisk', navn: 'Automatisk', forklaring: 'Appen vælger selv typen ud fra indholdet.' },
  { noegle: 'byggenotat', navn: 'Byggenotat', forklaring: 'Fejl og mangler, mål og mængder.' },
  { noegle: 'moede', navn: 'Møde', forklaring: 'Beslutninger, opgaver og åbne spørgsmål.' },
  { noegle: 'paamindelse', navn: 'Påmindelse', forklaring: 'En huskeliste.' },
  { noegle: 'andet', navn: 'Andet', forklaring: 'Opsummering og hovedpunkter.' },
];

/** Ukendt eller manglende type bliver Automatisk. */
export function rensType(raa) {
  return TYPER.some((t) => t.noegle === raa) ? raa : STANDARD_TYPE;
}
