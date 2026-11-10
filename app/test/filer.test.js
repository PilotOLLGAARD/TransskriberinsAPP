import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

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
