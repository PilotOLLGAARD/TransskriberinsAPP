// Gør, at appen kan åbnes uden net, så gemte optagelser altid kan nås.
// Kun appens egne filer caches. Kald til serveren, Microsoft og Graph røres ikke.
// En ny udgave hentes i baggrunden og bruges næste gang, appen åbnes.

const VERSION = 'v1';
const FILER = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
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
  'js/vendor/msal-browser.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILER)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const navn of await caches.keys()) {
      if (navn !== VERSION) await caches.delete(navn);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const omfang = new URL(self.registration.scope).pathname;
  const sti = url.pathname.slice(omfang.length);
  const kendt = e.request.mode === 'navigate' || FILER.includes(sti);
  if (!kendt) return;

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const noegle = e.request.mode === 'navigate' ? './' : e.request;
    const gemt = await cache.match(noegle, { ignoreSearch: true });
    const hentet = fetch(e.request).then((svar) => {
      if (svar.ok) cache.put(noegle, svar.clone());
      return svar;
    });
    if (gemt) {
      e.waitUntil(hentet.catch(() => {}));
      return gemt;
    }
    return hentet;
  })());
});
