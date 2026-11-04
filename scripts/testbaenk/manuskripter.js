'use strict';
// Opdigtede manuskripter til syntetisk testlyd. Manuskriptet er facit. Ingen rigtige noter, navne eller sager.
// tekst: linjer "Navn: ..." ved flere talere. forkerte: tal, der blev rettet undervejs og ikke må stå i referatet.
// type: den type, AI'en bør vælge. Navnene er fiktive.

const EN = { A: 'Kore' };
const MAND = { A: 'Charon' };
const TO = { Mette: 'Kore', Jonas: 'Charon' };
const TO_B = { Anne: 'Aoede', Peter: 'Puck' };

module.exports = [
  { id: 's01-kort-paamindelse', type: 'paamindelse', stemmer: EN,
    tekst: 'Husk at ringe til VVS-firmaet i morgen klokken otte.' },
  { id: 's02-tre-sek', type: 'paamindelse', stemmer: MAND,
    tekst: 'Bestil fire paller mursten.' },
  { id: 's03-maal', type: 'byggenotat', stemmer: MAND,
    tekst: 'Jeg står i opgang 3 på Vestervangen 14. Revnen i betongulvet er cirka 45 centimeter lang og 2 millimeter bred. '
      + 'Bjælken over døren er 4,2 meter, og vederlaget er 150 millimeter i hver side. Fugtmåleren viser 18 procent i væggen mod nord.' },
  { id: 's04-rettelser', type: 'byggenotat', stemmer: EN, forkerte: [3, 5, 27],
    tekst: 'Hullet til den nye dør skal være tre meter, nej undskyld, fire meter bredt. Stålbjælken skal være fem, nej seks meter lang. '
      + 'Vi skal bruge syvogtyve, nej otteogtyve gipsplader. Elektrikeren kommer på mandag, nej, det er tirsdag.' },
  { id: 's05-datoer', type: 'moede', stemmer: TO,
    tekst: 'Mette: Armeringen leveres fredag den syttende.\nJonas: Og betonen støbes onsdag den tyvende klokken kvart over syv.\n'
      + 'Mette: Pumpen skal bestilles senest den tolvte. Jonas, tager du den?\nJonas: Ja, det gør jeg.\n'
      + 'Mette: Tegningerne til næste etape skal være klar i uge syvogfyrre.' },
  { id: 's06-beloeb', type: 'moede', stemmer: TO_B,
    tekst: 'Anne: Tilbuddet på stilladset lyder på 48.500 kroner ekskl. moms.\nPeter: Det er dyrere end sidst. Sidst var det 41.000.\n'
      + 'Anne: Ja, men det er også to uger længere. Lejen er 1.250 kroner om ugen ud over de første otte uger.\n'
      + 'Peter: Okay. Vi godkender det, men jeg vil have det skriftligt inden fredag.' },
  { id: 's07-byggemoede', type: 'moede', stemmer: TO,
    tekst: 'Mette: Velkommen til byggemøde nummer 9 på Skovbrynet. Første punkt er tidsplanen.\n'
      + 'Jonas: Tømreren er cirka ti arbejdsdage bagud på tagkonstruktionen i blok C, fordi spærene kom for sent.\n'
      + 'Mette: Kan I indhente det?\nJonas: Hvis vi må arbejde lørdag den 21. fra klokken 7 til 15, så ja.\n'
      + 'Mette: Det godkender vi. Næste punkt er vinduerne. Der er leveret 62 ud af 70.\n'
      + 'Jonas: De sidste 8 kommer i uge 49, siger leverandøren.\n'
      + 'Mette: Så er der døren i lejlighed C 1.4. Den skal flyttes 35 centimeter mod øst. Hvem betaler?\n'
      + 'Jonas: Det må vi tage op med bygherren. Jeg laver en ændringsanmodning.\n'
      + 'Mette: Godt. Næste møde er tirsdag den 24. klokken 9 på pladsen.' },
  { id: 's08-gennemgang', type: 'byggenotat', stemmer: EN,
    tekst: 'Gennemgang af lejlighed 2.3 på Havnevej 7. I køkkenet mangler der fuge ved bordpladen, cirka 1,5 meter. '
      + 'Badeværelset: der er en revne i flisen ved gulvafløbet, og faldet mod afløbet er for lille, kun 5 promille. '
      + 'I stuen er der en skjold på loftet på cirka 30 gange 40 centimeter, sandsynligvis en gammel vandskade. '
      + 'Altandøren lukker ikke tæt. Elementerne virker. Alt i alt syv fejl og mangler, som skal udbedres inden aflevering den 15. december.' },
  { id: 's09-engelsk', type: 'moede', stemmer: TO_B,
    tekst: 'Anne: Vi skal have en kickoff med rådgiverne, og deadline for design freeze er den første december.\n'
      + 'Peter: Skal vi bruge BIM-modellen i IFC-format, eller har de en Revit-fil?\nAnne: IFC, version fire. Og clash detection kører hver mandag.\n'
      + 'Peter: Fint. Jeg sender en invite til teamet.' },
  { id: 's10-adresser-navne', type: 'paamindelse', stemmer: EN,
    tekst: 'Ting til i morgen. Ring til Birthe Kjærgaard hos Nordisk Tag på 12 34 56 78 om tagrenderne. '
      + 'Kør forbi Ågade 23B i Aarhus og tag billeder af facaden. Send tegning nummer K-104 revision C til Søren Ravnholt. '
      + 'Og husk at bestille 12 sække fliseklæber.' },
  { id: 's11-pauser', type: 'paamindelse', stemmer: MAND, pauser: true,
    tekst: 'Okay, et par ting. [lang pause] Brandsikringen omkring rørgennemføringerne i kælderen mangler. [lang pause] '
      + 'Og så skal vi have tjekket ventilationen i opgang 5. Det var det.' },
  { id: 's12-mumlen', type: 'byggenotat', stemmer: EN, stil: 'Say quickly and quietly, mumbling a bit',
    tekst: 'Øh, ja, så taget på blok A, der mangler cirka tyve tagsten mod nord, og tagrenden hænger, den er sænket måske 40 millimeter i midten. Øh, og inddækningen ved skorstenen er løs.' },
  { id: 's13-afbrydelser', type: 'moede', stemmer: TO,
    tekst: 'Mette: Så det, vi skal beslutte, er om vi —\nJonas: Undskyld, men før vi går videre, så har jeg tallene fra måleren.\n'
      + 'Mette: Okay, kom med dem.\nJonas: Det er 3,8 kubikmeter vand siden i går. Det er alt for meget.\n'
      + 'Mette: Så lukker vi for hovedhanen, til VVS-manden har set på det.\nJonas: Enig. Jeg ringer til ham nu.' },
  { id: 's14-klokkeslaet', type: 'paamindelse', stemmer: EN,
    tekst: 'Mødet med bygherren er flyttet fra klokken ti til halv et. Kranen kommer klokken kvart i syv, og afspærringen skal være klar senest kvart over seks.' },
  { id: 's15-tal-ord', type: 'byggenotat', stemmer: MAND,
    tekst: 'Vi har brugt femten hundrede kilo armering på fundamentet. Der mangler et dusin bolte og en snes skiver. '
      + 'Afstanden mellem søjlerne er to og en halv meter, og dækket er to hundrede og tyve millimeter tykt.' },
  { id: 's16-andet', type: 'andet', stemmer: EN,
    tekst: 'Jeg har været til et kursus om bæredygtighed i byggeriet. Det vigtigste var, at materialevalget betyder mere end driften over de første 50 år. '
      + 'Underviseren nævnte, at træ har et lavere aftryk end beton, men at det kræver god brandsikring. Jeg tror, det bliver et større tema i vores projekter.' },
  { id: 's17-lang-moede', type: 'moede', stemmer: TO_B,
    tekst: 'Anne: Godmorgen. Det er projektmøde på Rønnebærparken, etape 2. Vi har tre punkter i dag.\n'
      + 'Peter: Før vi starter: jeg skal gå klokken 11.\nAnne: Det når vi. Første punkt: økonomien. Vi har brugt 4,7 millioner af et budget på 6,2 millioner.\n'
      + 'Peter: Og vi er cirka 60 procent færdige, så det ser fornuftigt ud.\n'
      + 'Anne: Ja. Men der er en ekstraregning fra jordentreprenøren på 186.000 kroner for bortkørsel af forurenet jord.\n'
      + 'Peter: Den er ikke godkendt. Jeg vil se analyserne først.\nAnne: Det noterer jeg. Andet punkt: sikkerheden. Der var et uheld i uge 44, en faldet stige. Ingen kom til skade.\n'
      + 'Peter: Vi skal have en sikkerhedsrunde hver fredag fra nu af.\nAnne: Enig. Tredje punkt: afleveringen. Den er planlagt til den 30. april.\n'
      + 'Peter: Det holder kun, hvis vinduerne kommer i uge 2.\nAnne: Jeg tjekker med leverandøren i dag og vender tilbage senest torsdag.' },
  { id: 's18-tre-sek-tal', type: 'paamindelse', stemmer: EN,
    tekst: 'Ring til Kim klokken tre.' },
  { id: 's19-dialekt-stil', type: 'byggenotat', stemmer: MAND, stil: 'Speak with a strong rural Jutlandic Danish accent',
    tekst: 'Ja, så har vi været ude ved stalden på Mosevej 9. Gulvet skal hæves 80 millimeter, og der skal laves fald mod afløbet på 2 procent. Vi regner med fire dage.' },
  { id: 's20-usikker', type: 'byggenotat', stemmer: EN,
    tekst: 'Hældningen på taget er vist omkring tolv-tretten grader, men jeg har ikke målt det. Prisen bliver et sted mellem fem og otte tusind, siger leverandøren. Der skal bruges et par ruller undertag.' },
];
