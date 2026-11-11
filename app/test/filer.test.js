import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { inflateSync } from 'node:zlib';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const laes = (navn) => readFileSync(join(APP, navn), 'utf8');

test('alle filer i service workeren findes', () => {
  // En manglende fil får hele installationen til at fejle, og så virker appen ikke uden net.
  const liste = /const FILER = \[([\s\S]*?)\];/.exec(laes('sw.js'))[1];
  const filer = [...liste.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((f) => f !== './');
  assert.ok(filer.length > 5);
  for (const f of filer) assert.ok(existsSync(join(APP, f)), `${f} mangler`);
});

test('alle moduler i js/ er med i service workeren', () => {
  const sw = laes('sw.js');
  for (const f of readdirSync(join(APP, 'js')).filter((n) => n.endsWith('.js'))) {
    assert.ok(sw.includes(`'js/${f}'`), `js/${f} mangler i sw.js`);
  }
});

test('Content-Security-Policy tillader serverens adresse', () => {
  const adresse = /SERVER_ADRESSE = '([^']+)'/.exec(laes('js/konfig.js'))[1];
  assert.ok(laes('index.html').includes(adresse), 'index.html og konfig.js er ikke enige om serverens adresse');
});

test('appens filer indeholder ingen nøgle', () => {
  for (const f of ['index.html', 'js/konfig.js', 'js/app.js', 'js/login.js']) {
    assert.ok(!/AIza[0-9A-Za-z_-]{30,}/.test(laes(f)), f);
    assert.ok(!laes(f).includes('GEMINI_API_KEY'), f);
  }
});

test('login-biblioteket blokerer ikke første tegning', () => {
  const html = laes('index.html');
  const msal = html.indexOf('<script defer src="js/vendor/msal-browser.min.js">');
  const app = html.indexOf('<script type="module" src="js/app.js">');
  assert.ok(msal > 0, 'MSAL hentes ikke med defer');
  // Scripts med defer og moduler køres i den rækkefølge, de står. MSAL skal være klar, når app.js starter.
  assert.ok(app > msal, 'MSAL skal stå før app.js');
});

// Ikoner og startskærme


/** Bredde, højde og første billedpunkt i en PNG. Første punkt i første række er altid ufiltreret. */
function png(navn) {
  const b = readFileSync(join(APP, navn));
  assert.equal(b.toString('latin1', 1, 4), 'PNG', navn);
  const idat = [];
  for (let p = 8; p < b.length;) {
    const laengde = b.readUInt32BE(p);
    if (b.toString('latin1', p + 4, p + 8) === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + laengde));
    p += 12 + laengde;
  }
  const raa = inflateSync(Buffer.concat(idat));
  return { bredde: b.readUInt32BE(16), hoejde: b.readUInt32BE(20), foerste: [raa[1], raa[2], raa[3]] };
}

test('manifestets ikoner findes og er delt i any og maskable', () => {
  const { icons } = JSON.parse(laes('manifest.webmanifest'));
  for (const i of icons) {
    assert.ok(existsSync(join(APP, i.src)), `${i.src} mangler`);
    // Et ikon til begge dele bliver enten beskåret for hårdt eller får for meget luft.
    assert.ok(i.purpose === 'any' || i.purpose === 'maskable', `${i.src}: ${i.purpose}`);
    const [str] = i.sizes.split('x').map(Number);
    assert.deepEqual([png(i.src).bredde, png(i.src).hoejde], [str, str], i.src);
  }
  for (const formaal of ['any', 'maskable']) {
    for (const str of ['192x192', '512x512']) assert.ok(icons.some((i) => i.purpose === formaal && i.sizes === str), `${formaal} ${str} mangler`);
  }
});

test('ikonet er hvidt Ø på knapblå', () => {
  for (const navn of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png']) {
    assert.deepEqual(png(navn).foerste, [14, 90, 163], navn);
  }
  assert.deepEqual([png('apple-touch-icon.png').bredde, png('apple-touch-icon.png').hoejde], [180, 180]);
});

test('alle startskærme i index.html findes og har rigtige mål', () => {
  const html = laes('index.html');
  const links = [...html.matchAll(/<link rel="apple-touch-startup-image" media="([^"]+)" href="([^"]+)">/g)];
  // 12 iPhone-størrelser i lys og mørk.
  assert.equal(links.length, 24);
  const set = new Set();
  for (const [, media, href] of links) {
    const [, b, h, t, skema] = /\(device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)\) and \(orientation: portrait\) and \(prefers-color-scheme: (light|dark)\)/.exec(media) ?? [];
    assert.ok(b, `uventet media: ${media}`);
    assert.equal(href, `start/${b}x${h}@${t}-${skema === 'dark' ? 'moerk' : 'lys'}.png`);
    assert.ok(existsSync(join(APP, href)), `${href} mangler`);
    const p = png(href);
    assert.deepEqual([p.bredde, p.hoejde], [b * t, h * t], href);
    assert.deepEqual(p.foerste, skema === 'dark' ? [15, 26, 38] : [243, 245, 248], href);
    set.add(`${b}x${h}@${t}-${skema}`);
  }
  assert.equal(set.size, 24, 'samme størrelse står to gange');
  for (const lille of ['320x568@2', '375x667@2', '390x844@3', '430x932@3']) assert.ok(set.has(`${lille}-light`) && set.has(`${lille}-dark`), lille);
});
