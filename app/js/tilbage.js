// Telefonens egen tilbage (Android-knappen og swipe) går ét skridt tilbage i appen i stedet for at lukke den.
//
// Appen har kun én adresse. Hver underskærm lægger derfor et skridt på browserens historik, og et tilbage-tryk
// meldes til appen, som selv vælger skærmen. Forsiden er bunden: herfra lukker tilbage appen, som telefoner plejer.

/** Hvor mange skridt fra forsiden en skærm ligger. Læs åbnet fra Tidligere ligger to skridt inde. */
export function dybdeFor(visning, fraVisning) {
  if (visning === 'start') return 0;
  if (visning === 'tekst' && fraVisning === 'tidligere') return 2;
  return 1;
}

/**
 * synk(visning, fraVisning) kaldes, hver gang skærmen er tegnet, og bringer historikken i takt med skærmen.
 * vedTilbage(dybde) kaldes, når brugeren selv går tilbage. Intet her kaster.
 */
export function lavTilbage({
  historik = globalThis.history,
  lyt = (fn) => addEventListener('popstate', fn),
  vedTilbage,
}) {
  // Skift, synk selv har sat i gang med go(). De melder sig som tilbage-tryk, men er ikke brugerens.
  let undervejs = 0;
  let sidst = ['start', 'start'];
  let foerste = true;

  function synk(visning, fraVisning) {
    sidst = [visning, fraVisning];
    // Historikken er på vej tilbage. Der synkroniseres igen, når den er nået frem.
    if (undervejs > 0) return;
    try {
      if (foerste) {
        foerste = false;
        // Efter en genindlæsning husker historikken dybden fra før. Skridtet under hører til en tidligere
        // indlæsning (eller til en anden side, fx Microsofts login), så appen går aldrig selv tilbage dertil.
        // Det nuværende skridt bliver bunden.
        if (historik.state?.dybde) historik.replaceState({ dybde: 0 }, '');
      }
      const oensket = dybdeFor(visning, fraVisning);
      let dybde = historik.state?.dybde ?? 0;
      if (oensket < dybde) {
        undervejs++;
        historik.go(oensket - dybde);
        return;
      }
      while (dybde < oensket) {
        dybde++;
        historik.pushState({ dybde }, '');
      }
    } catch { /* Uden historik virker Tilbage-knappen i appen stadig. */ }
  }

  lyt((e) => {
    if (undervejs > 0) {
      undervejs--;
      synk(...sidst);
      return;
    }
    vedTilbage(e.state?.dybde ?? 0);
  });

  return { synk };
}
