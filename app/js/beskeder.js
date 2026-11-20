export const BESKEDER = {
  mikrofonNaegtet: 'Appen må ikke bruge mikrofonen. Giv tilladelse i telefonens indstillinger, og prøv igen.',
  kanIkkeOptage: 'Telefonen kan ikke optage her. Åbn appen fra hjemmeskærmen.',
  net: 'Ingen forbindelse. Optagelsen er gemt. Prøv igen, når du har net.',
  login: 'Du skal logge ind igen. Optagelsen er gemt.',
  adgang: 'Din konto har ikke adgang til appen. Optagelsen er gemt. Kontakt Rasmus Winther på rw@ollgaard.dk.',
  tjeneste: 'Det lykkedes ikke at lave referatet. Optagelsen er gemt. Prøv igen.',
  kvote: 'Grænsen for i dag hos Google er nået. Optagelsen er gemt på telefonen. Prøv igen i morgen.',
  kanIkkeBehandles: 'Optagelsen kunne ikke behandles. Den er gemt på telefonen. Kontakt Rasmus Winther på rw@ollgaard.dk, hvis det sker igen.',
  // Googles filter afviste hele optagelsen (også i mindre stykker).
  blokeret: 'Optagelsen kunne ikke behandles. Den er gemt på telefonen. Kontakt Rasmus Winther på rw@ollgaard.dk, hvis det sker igen.',
  ingenTale: 'Der blev ikke fundet tale i optagelsen. Den er gemt på telefonen.',
  afbrudt: 'Optagelsen blev afbrudt. Det optagede er gemt. Vil du fortsætte?',
  ingenFlereDele: 'Optagelsen kan ikke fortsættes mere. Send den, og start en ny.',
  tomOptagelse: 'Der blev ikke optaget noget lyd. Prøv igen.',
  pladsMangler: 'Telefonen er løbet tør for plads. Det indtalte indtil nu er gemt.',
  pladsTom: 'Telefonen er løbet tør for plads, så intet blev gemt. Frigør plads, og prøv igen.',
  lagerTom: 'Telefonen kunne ikke gemme optagelsen. Prøv igen.',
  plads: 'Telefonen er løbet tør for plads. Optagelsen er gemt. Slet gamle optagelser eller frigør plads på telefonen, og prøv igen.',
  lager: 'Telefonen kunne ikke gemme ændringen. Optagelsen er gemt. Prøv igen.',
  loginKraeverNet: 'Du skal have net for at logge ind. Optagelsen er gemt.',
  snartSlut: 'Optagelsen stopper om 5 minutter.',
  lang: 'Optagelsen har kørt i 2 timer. Sæt gerne telefonen til opladning.',
  maksNaaet: 'Optagelsen stoppede efter 4 timer. Det indtalte er gemt.',
  // Optagelser, der ikke kan klippes i bidder (fx et ukendt format fra en ny telefon), stopper som før.
  maksNaaetKort: 'Optagelsen stoppede efter 59 minutter. Det indtalte er gemt.',
  mailFejl: 'Mailen blev ikke sendt. Referatet er gemt. Prøv igen.',
  ikkeLydfil: 'Filen er ikke en lydfil, appen kan bruge. Brug m4a, mp3, wav, ogg eller webm.',
  forStorFil: 'Filen er for stor. Den må højst fylde 500 MB. Gem optagelsen som m4a eller mp3, og prøv igen.',
  forLang: 'Lydfilen er længere end 4 timer. Del den op i en anden app, og upload delene sammen.',
  forLangFormat: 'Lydfiler i dette format kan højst være 2½ time. Gem optagelsen som m4a eller mp3, og prøv igen.',
  forMangeFiler: 'Du kan højst vælge 10 lydfiler ad gangen.',
  samletForLang: 'Lydfilerne er tilsammen længere end 4 timer.',
  filKanIkkeLaeses: 'Filen kunne ikke læses, så intet blev gemt. Prøv igen, eller gem filen i Filer først.',
  maaskeSendt: 'Mailen er måske allerede sendt. Tjek din indbakke, før du sender igen.',
};

/** Beskeden før en optagelse, når telefonen har lidt plads. minutter er, hvad pladsen rækker til. */
export function lidtPlads(minutter) {
  return `Telefonen har kun plads til ca. ${minutter} minutters optagelse. Slet gamle filer, hvis mødet bliver langt.`;
}

// Fejl, der vises med en anden tekst end deres eget navn.
const VISES_SOM = { mailUkendt: 'maaskeSendt' };

/** Teksten til en fejltype. Aldrig tom: en ukendt type giver reserven. */
export function besked(noegle, reserve = 'tjeneste') {
  const n = VISES_SOM[noegle] ?? noegle;
  if (Object.hasOwn(BESKEDER, n)) return BESKEDER[n];
  return Object.hasOwn(BESKEDER, reserve) ? BESKEDER[reserve] : BESKEDER.tjeneste;
}
