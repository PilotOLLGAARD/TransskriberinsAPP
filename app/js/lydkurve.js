// Lydkurven på optageskærmen: søjler, der viser, at mikrofonen hører noget. Kun brugerflade.
//
// Kurven lytter med på den strøm, optagelsen allerede bruger. Den optager ikke selv, sender intet til højttaleren
// og stopper aldrig mikrofonens spor. Intet her må kunne stoppe en optagelse: alle fejl sluges, og kan lydmåleren
// ikke starte, mangler kurven bare.

/** Så ofte måles lyden. Hver måling bliver til én søjle. */
export const MAALE_MS = 100;

const SOEJLE = 4; // bredde i px
const SKRIDT = 8; // søjle og mellemrum
const HOEJRE = 14; // plads til den røde streg yderst til højre
const TONER_UD = 14; // de ældste søjler toner ud mod venstre
const HUSKER = 160; // nok til de bredeste telefoner

/** Lydens styrke fra 0 til 1 ud fra lydmålerens bytes (128 er stilhed). -60 dB er 0, -6 dB er 1. */
export function niveau(proever) {
  if (!proever?.length) return 0;
  let sum = 0;
  for (let i = 0; i < proever.length; i++) {
    const v = (proever[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / proever.length);
  const db = 20 * Math.log10(Math.max(rms, 1e-4));
  return Math.max(0, Math.min(1, (db + 60) / 54));
}

/** De nyeste målinger, nyeste sidst. */
export function lavHistorik(antal) {
  let liste = [];
  return {
    tilfoej(v) {
      liste.push(v);
      if (liste.length > antal) liste = liste.slice(-antal);
    },
    vaerdier: () => [...liste],
    ryd() { liste = []; },
  };
}

/** Hvor langt søjlerne er gledet siden sidste måling, fra 0 til 1. Med reduceret bevægelse glider de ikke. */
export function forskydning(sidenMs, reducer) {
  if (reducer) return 0;
  return Math.max(0, Math.min(1, sidenMs / MAALE_MS));
}

function tegnSoejler(laerred, vaerdier, forskudt) {
  const taethed = globalThis.devicePixelRatio || 1;
  const bredde = laerred.clientWidth;
  const hoejde = laerred.clientHeight;
  if (!bredde || !hoejde) return;
  if (laerred.width !== Math.round(bredde * taethed) || laerred.height !== Math.round(hoejde * taethed)) {
    laerred.width = Math.round(bredde * taethed);
    laerred.height = Math.round(hoejde * taethed);
  }
  const c = laerred.getContext('2d');
  c.setTransform(taethed, 0, 0, taethed, 0, 0);
  c.clearRect(0, 0, bredde, hoejde);
  c.fillStyle = '#ffffff';
  const nyeste = bredde - HOEJRE - SOEJLE - forskudt * SKRIDT;
  for (let i = 0; i < vaerdier.length; i++) {
    const x = nyeste - i * SKRIDT;
    if (x < 0) break;
    const h = Math.max(SOEJLE, vaerdier[vaerdier.length - 1 - i] * (hoejde - 8));
    c.globalAlpha = 0.35 + 0.65 * Math.min(1, x / (TONER_UD * SKRIDT));
    c.beginPath();
    // Runde ender, hvor telefonen kan. Ellers firkanter.
    if (c.roundRect) c.roundRect(x, (hoejde - h) / 2, SOEJLE, h, SOEJLE / 2);
    else c.rect(x, (hoejde - h) / 2, SOEJLE, h);
    c.fill();
  }
  // Rød streg: her er "nu".
  c.globalAlpha = 1;
  c.fillStyle = '#ff453a';
  c.fillRect(bredde - HOEJRE + 6, 0, 2, hoejde);
}

/**
 * start(strøm) giver true, når lydmåleren kører. vis(lærred) tegner på et lærred, til det tages ud af siden
 * eller stop() kaldes. Ingen af funktionerne kaster.
 */
export function lavLydkurve({
  lavKontekst = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)(),
  raf = (fn) => requestAnimationFrame(fn),
  afbrydRaf = (id) => cancelAnimationFrame(id),
  nu = () => performance.now(),
  reducer = () => matchMedia('(prefers-reduced-motion: reduce)').matches,
} = {}) {
  const historik = lavHistorik(HUSKER);
  let kontekst = null;
  let kilde = null;
  let maaler = null;
  let buffer = null;
  let laerred = null;
  let billede = null;
  let sidstMaalt = 0;

  function kanTegne() {
    return Boolean(maaler && laerred?.isConnected);
  }

  function loekke() {
    billede = null;
    if (!kanTegne()) return;
    try {
      const tid = nu();
      if (tid - sidstMaalt >= MAALE_MS) {
        maaler.getByteTimeDomainData(buffer);
        historik.tilfoej(niveau(buffer));
        sidstMaalt = tid;
      }
      tegnSoejler(laerred, historik.vaerdier(), forskydning(tid - sidstMaalt, reducer()));
    } catch { /* Kurven fryser. Optagelsen kører videre. */ }
    planlaeg();
  }

  function planlaeg() {
    if (billede !== null || !kanTegne()) return;
    try {
      billede = raf(loekke);
    } catch { billede = null; }
  }

  function stop() {
    try {
      if (billede !== null) afbrydRaf(billede);
    } catch { /* intet */ }
    billede = null;
    try { kilde?.disconnect(); } catch { /* intet */ }
    // Kun lydmåleren lukkes. Mikrofonens spor ejes af optagelsen.
    try { kontekst?.close?.()?.catch?.(() => {}); } catch { /* intet */ }
    kontekst = null;
    kilde = null;
    maaler = null;
    buffer = null;
    laerred = null;
    historik.ryd();
  }

  return {
    start(stroem) {
      stop();
      try {
        kontekst = lavKontekst();
        kilde = kontekst.createMediaStreamSource(stroem);
        const ny = kontekst.createAnalyser();
        ny.fftSize = 1024;
        // Kun til måleren. Lyden sendes ikke til højttaleren.
        kilde.connect(ny);
        buffer = new Uint8Array(ny.fftSize);
        maaler = ny;
        // Telefonen kan starte lydmåleren på pause.
        try { kontekst.resume?.()?.catch?.(() => {}); } catch { /* intet */ }
        sidstMaalt = 0;
        return true;
      } catch {
        stop();
        return false;
      }
    },
    vis(nytLaerred) {
      laerred = nytLaerred || null;
      planlaeg();
    },
    stop,
    erAktiv: () => Boolean(maaler),
  };
}
