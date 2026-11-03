// Gør, at appen kan åbnes uden net, så gemte optagelser altid kan nås.
// Kun appens egne filer caches. Kald til serveren, Microsoft og Graph røres ikke.
//
// Hver udgave hentes samlet i sit eget cache, så gamle og nye filer aldrig blandes.
// VERSION sættes til commit-nummeret, når appen udgives (.github/workflows/web.yml).

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
  'js/lager.js',
  'js/login.js',
  'js/mail.js',
  'js/optager.js',
  'js/tilstand.js',
  'js/transskribering.js',
  'js/typer.js',
  'js/vendor/msal-browser.min.js',
];

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
      if (navn !== VERSION) await caches.delete(navn);
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

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const omfang = new URL(self.registration.scope).pathname;
  const sti = url.pathname.slice(omfang.length);
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
