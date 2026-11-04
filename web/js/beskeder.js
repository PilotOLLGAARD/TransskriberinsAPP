export const BESKEDER = {
  mikrofonNaegtet: 'Appen må ikke bruge mikrofonen. Giv tilladelse i telefonens indstillinger, og prøv igen.',
  kanIkkeOptage: 'Telefonen kan ikke optage her. Åbn appen fra hjemmeskærmen.',
  net: 'Ingen forbindelse. Optagelsen er gemt. Prøv igen, når du har net.',
  login: 'Du skal logge ind igen. Optagelsen er gemt.',
  adgang: 'Din konto har ikke adgang til appen. Optagelsen er gemt. Kontakt IT.',
  tjeneste: 'Transskriptionen mislykkedes. Optagelsen er gemt. Prøv igen.',
  kvote: 'Grænsen for i dag hos Google er nået. Optagelsen er gemt på telefonen. Prøv igen i morgen.',
  kanIkkeBehandles: 'Optagelsen kunne ikke behandles. Den er gemt på telefonen. Kontakt IT, hvis det sker igen.',
  ingenTale: 'Der blev ikke fundet tale i optagelsen. Den er gemt på telefonen.',
  afbrudt: 'Optagelsen blev afbrudt — det optagede er gemt. Vil du fortsætte?',
  ingenFlereDele: 'Optagelsen kan ikke fortsættes mere. Send den, og start en ny.',
  tomOptagelse: 'Der blev ikke optaget noget lyd. Prøv igen.',
  pladsMangler: 'Telefonen er løbet tør for plads. Det indtalte indtil nu er gemt.',
  pladsTom: 'Telefonen er løbet tør for plads, så intet blev gemt. Frigør plads, og prøv igen.',
  plads: 'Telefonen er løbet tør for plads. Optagelsen er gemt. Slet gamle optagelser eller frigør plads på telefonen, og prøv igen.',
  lager: 'Telefonen kunne ikke gemme ændringen. Optagelsen er gemt. Prøv igen.',
  loginKraeverNet: 'Du skal have net for at logge ind. Optagelsen er gemt.',
  snartSlut: 'Optagelsen stopper om 4 minutter.',
  maksNaaet: 'Optagelsen stoppede efter 59 minutter. Det indtalte er gemt.',
  mailFejl: 'Mailen blev ikke sendt. Referatet er gemt. Prøv igen.',
  maaskeSendt: 'Mailen er måske allerede sendt. Tjek din indbakke, før du sender igen.',
};

// Fejl, der vises med en anden tekst end deres eget navn.
const VISES_SOM = { mailUkendt: 'maaskeSendt' };

/** Teksten til en fejltype. Aldrig tom: en ukendt type giver reserven. */
export function besked(noegle, reserve = 'tjeneste') {
  const n = VISES_SOM[noegle] ?? noegle;
  if (Object.hasOwn(BESKEDER, n)) return BESKEDER[n];
  return Object.hasOwn(BESKEDER, reserve) ? BESKEDER[reserve] : BESKEDER.tjeneste;
}
