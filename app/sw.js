// Gør, at appen kan åbnes uden net, så gemte optagelser altid kan nås.
// Kun appens egne filer caches. Kald til serveren, Microsoft og Graph røres ikke.
//
// Hver udgave hentes samlet i sit eget cache, så gamle og nye filer aldrig blandes.
// VERSION sættes til commit-nummeret, når appen udgives (.github/workflows/app.yml).

const VERSION = 'udvikling';
const UDVIKLING = ['localhost', '127.0.0.1'].includes(self.location.hostname);
const FILER = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'ordmaerke.svg',
  'maerke.svg',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'js/app.js',
  'js/beskeder.js',
  'js/forloeb.js',
  'js/konfig.js',
  'js/lydfil.js',
  'js/lager.js',
  'js/login.js',
  'js/mail.js',
  'js/optager.js',
  'js/tilstand.js',
  'js/transskribering.js',
  'js/typer.js',
  'js/vendor/msal-browser.min.js',
];

// En lydfil fra del-menuen på Android ligger her, til appen har gemt den i sit eget lager.
// Navnene går igen i js/lydfil.js. Cachen ryddes ikke ved en ny udgave.
const DELT_CACHE = 'delt-lydfil';
const DELT_NOEGLE = 'delt-fil';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(FILER.map((f) => new Request(f, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const navn of await caches.keys()) {
      if (navn !== VERSION && navn !== DELT_CACHE) await caches.delete(navn);
    }
    await self.clients.claim();
  })());
});

// Et tryk på beskeden om en stoppet optagelse åbner appen igen.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const [vindue] = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (vindue) await vindue.focus();
    else await self.clients.openWindow('./');
  })());
});

/**
 * Del-menuen (Web Share Target, kun Android): Filen lægges midlertidigt, og appen åbnes med ?delt=1.
 * Appen kontrollerer og gemmer filen straks og åbner navneskærmen. Enhver side kan sende hertil, men intet
 * sendes, før brugeren selv trykker Send. Kopien fjernes efter gemning, Annullér eller en fil, der ikke kan bruges.
 * Går noget galt, åbnes appen alligevel med en besked i stedet for en fejlside.
 */
async function modtagDelt(request) {
  const tilAppen = (svar) => Response.redirect(new URL(`./?delt=${svar}`, self.registration.scope).href, 303);
  try {
    const data = await request.formData();
    const fil = data.getAll('lyd').find((f) => typeof f === 'object' && f !== null && f.size > 0);
    if (!fil) return tilAppen('0');
    const cache = await caches.open(DELT_CACHE);
    await cache.put(new URL(DELT_NOEGLE, self.registration.scope).href, new Response(fil, {
      headers: { 'content-type': fil.type || 'application/octet-stream', 'x-filnavn': encodeURIComponent(fil.name || '') },
    }));
    return tilAppen('1');
  } catch (e) {
    return tilAppen(e?.name === 'QuotaExceededError' ? 'plads' : 'fejl');
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  const omfang = new URL(self.registration.scope).pathname;
  const sti = url.pathname.slice(omfang.length);
  if (e.request.method === 'POST' && sti === 'del') {
    e.respondWith(modtagDelt(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;
  // Kun appens forside gives ved sideskift. Andre sider på samme adresse hentes fra nettet.
  const navigering = e.request.mode === 'navigate';
  if (navigering ? sti !== '' && sti !== 'index.html' : !FILER.includes(sti)) return;
  const noegle = navigering ? './' : e.request;

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    // Under udvikling hentes filerne altid friske. Cachen bruges kun uden net.
    if (UDVIKLING) {
      try {
        return await fetch(e.request);
      } catch {
        return (await cache.match(noegle, { ignoreSearch: true })) || Response.error();
      }
    }
    return (await cache.match(noegle, { ignoreSearch: true })) || fetch(e.request);
  })());
});
