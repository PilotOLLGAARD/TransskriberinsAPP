// Referatets typer. Brugeren vælger ikke typen: serveren lader AI'en vælge ud fra navn og indhold
// og svarer med den valgte type. Nøglerne er de samme som serverens (server/src/typer.js).
// Gamle noter med en valgt type sendes stadig med den i x-type.

export const TYPER = ['automatisk', 'byggenotat', 'moede', 'paamindelse', 'andet'];

const NAVNE = { byggenotat: 'Byggenotat', moede: 'Møde', paamindelse: 'Påmindelse', andet: 'Andet' };

/** Typens navn til visning. null, før AI'en har valgt (automatisk), og for ukendte typer. */
export function typeNavn(noegle) {
  return Object.hasOwn(NAVNE, noegle ?? '') ? NAVNE[noegle] : null;
}
