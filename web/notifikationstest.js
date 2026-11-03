// Midlertidig test: kan appen vise en notifikation i det øjeblik, telefonen låses under optagelse?
// Slettes igen, når testen er gennemført. Sender intet og gemmer ingen lyd.

const LOG = 'notifikationstest';
const BESKED = 'Optagelsen er stoppet — hold appen åben, mens du optager.';
let igang = false;
let laas = null;

function laesLog() {
  try {
    return JSON.parse(localStorage.getItem(LOG) || '[]');
  } catch {
    return [];
  }
}

function skriv(tekst) {
  const log = laesLog();
  log.push(`${new Date().toLocaleTimeString('da-DK')}: ${tekst}`);
  try { localStorage.setItem(LOG, JSON.stringify(log.slice(-30))); } catch { /* kun til test */ }
  vis();
}

function vis() {
  const installeret = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const tilladelse = typeof Notification === 'undefined' ? 'findes ikke her' : Notification.permission;
  document.getElementById('status').textContent =
    `Hjemmeskærm: ${installeret ? 'ja' : 'nej'}. Notifikationer: ${tilladelse}. Test: ${igang ? 'kører' : 'stoppet'}.`;
  const liste = document.getElementById('log');
  liste.replaceChildren(...laesLog().map((l) => Object.assign(document.createElement('li'), { textContent: l })));
}

async function notifikation(tekst) {
  const reg = await navigator.serviceWorker?.ready;
  if (!reg) throw new Error('ingen service worker');
  await reg.showNotification('Transskribering', { body: tekst, tag: 'notifikationstest' });
}

document.getElementById('tillad').addEventListener('click', async () => {
  if (typeof Notification === 'undefined') {
    skriv('Notification findes ikke. På iPhone kræver det, at siden er åbnet fra hjemmeskærmen.');
    return;
  }
  skriv(`Tilladelse: ${await Notification.requestPermission()}`);
});

document.getElementById('proeve').addEventListener('click', async () => {
  try {
    await notifikation('Prøve: notifikationer virker, mens siden er åben.');
    skriv('Prøve vist uden fejl.');
  } catch (e) {
    skriv(`Prøve fejlede: ${e.name || "Fejl"}: ${e.message || e}`);
  }
});

document.getElementById('start').addEventListener('click', async () => {
  try {
    // Mikrofonen tændes som under en rigtig optagelse, men lyden bruges ikke.
    await navigator.mediaDevices.getUserMedia({ audio: true });
    laas = await navigator.wakeLock?.request('screen').catch(() => null);
    igang = true;
    skriv(`Test startet. Skærmlås: ${laas ? 'ja' : 'nej'}. Lås nu telefonen.`);
  } catch (e) {
    skriv(`Kunne ikke starte: ${e.name || "Fejl"}: ${e.message || e}`);
  }
});

document.getElementById('nulstil').addEventListener('click', () => {
  try { localStorage.removeItem(LOG); } catch { /* kun til test */ }
  igang = false;
  vis();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && igang) {
    skriv('Siden blev skjult. Prøver at vise notifikationen.');
    notifikation(BESKED)
      .then(() => skriv('showNotification lykkedes (men kom den frem?).'))
      .catch((e) => skriv(`showNotification fejlede: ${e.name || "Fejl"}: ${e.message || e}`));
  } else if (document.visibilityState === 'visible') {
    skriv('Siden er synlig igen.');
  }
});

navigator.serviceWorker?.register('sw.js').catch(() => skriv('Service worker kunne ikke registreres.'));
vis();
