import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { BESKEDER, besked } from '../js/beskeder.js';
import { FEJLTYPER } from '../js/transskribering.js';

const MAPPE = new URL('../js/', import.meta.url);
const KILDER = Object.fromEntries(readdirSync(MAPPE).filter((f) => f.endsWith('.js')).map((f) => [f, readFileSync(new URL(f, MAPPE), 'utf8')]));

// Fejl, der ikke vises med deres eget navn: mailUkendt vises som advarslen om mulig dobbelt mail.
const VISES_SOM = { mailUkendt: 'maaskeSendt' };

/** Alle fejltyper, appen kan få: fundet i koden, så en ny type uden tekst får testen til at fejle. */
function alleFejltyper() {
  const typer = new Set(Object.values(FEJLTYPER));
  const moenstre = [
    /new SendFejl\('(\w+)'\)/g,
    /new OptageFejl\(\s*'(\w+)'\s*\)/g,
    /new LydfilFejl\('(\w+)'\)/g,
    /\{ ok: false, fejl: '(\w+)' \}/g,
    /new OptageFejl\([^)]*\? '(\w+)' : '(\w+)'\)/g,
    /fejlType: '(\w+)'/g,
    /fejlTypeFor\([^,]+, '(\w+)'\)/g,
    /Object\.assign\(new Error\('\w+'\), \{ type: '(\w+)' \}\)/g,
    /this\.type = '(\w+)'/g,
    /visFejl\('(\w+)'\)/g,
    /e\?\.type \|\| '(\w+)'/g,
    /\? '(plads\w*)' :/g,
  ];
  for (const kilde of Object.values(KILDER)) {
    for (const m of moenstre) for (const fund of kilde.matchAll(m)) for (const t of fund.slice(1)) if (t) typer.add(t);
  }
  // Optagerens afslutninger vises via AFSLUT_BESKEDER i app.js.
  const afslut = KILDER['app.js'].match(/const AFSLUT_BESKEDER = \{([^}]*)\}/)[1];
  for (const [, noegle] of afslut.matchAll(/:\s*'(\w+)'/g)) typer.add(noegle);
  return typer;
}

test('fundet de kendte fejltyper i koden', () => {
  const typer = alleFejltyper();
  for (const t of ['net', 'login', 'adgang', 'tjeneste', 'kanIkkeBehandles', 'ingenTale', 'mailFejl', 'mailUkendt',
    'mikrofonNaegtet', 'kanIkkeOptage', 'ingenFlereDele', 'plads', 'pladsTom', 'pladsMangler', 'maksNaaet', 'tomOptagelse', 'afbrudt',
    'ikkeLydfil', 'forStorFil', 'filKanIkkeLaeses']) {
    assert.ok(typer.has(t), `${t} blev ikke fundet`);
  }
});

test('hver fejltype, appen kan få, har en dansk tekst', () => {
  for (const type of alleFejltyper()) {
    const noegle = VISES_SOM[type] ?? type;
    assert.equal(typeof BESKEDER[noegle], 'string', `Ingen tekst til fejltypen ${type}`);
    assert.ok(BESKEDER[noegle].trim().length > 10, `Tom tekst til fejltypen ${type}`);
  }
});

test('ingen besked er tom eller engelsk', () => {
  const engelsk = /\b(the|error|failed|failure|network|please|try|again|undefined|null|NaN|object|quota|exceeded|abort(ed)?|unknown|storage)\b/i;
  for (const [noegle, tekst] of Object.entries(BESKEDER)) {
    assert.ok(tekst.trim().length > 10, `${noegle} er tom`);
    assert.doesNotMatch(tekst, engelsk, `${noegle} ser engelsk ud: ${tekst}`);
    assert.match(tekst, /\b(er|ikke|du|og|det|kan|prøv|optagelsen|telefonen)\b/i, `${noegle} ser ikke dansk ud: ${tekst}`);
  }
});

test('besked giver aldrig en tom tekst, heller ikke for en ukendt fejltype', () => {
  assert.equal(besked('net'), BESKEDER.net);
  assert.equal(besked('findesIkke'), BESKEDER.tjeneste);
  assert.equal(besked(undefined), BESKEDER.tjeneste);
  assert.equal(besked('findesIkke', 'kanIkkeOptage'), BESKEDER.kanIkkeOptage);
  assert.equal(besked('toString'), BESKEDER.tjeneste);
  assert.equal(besked('mailUkendt'), BESKEDER.maaskeSendt);
});

test('dagsgrænsen hos Google har en dansk besked, der siger, at optagelsen er gemt', () => {
  assert.match(BESKEDER.kvote, /gemt/);
  assert.match(BESKEDER.kvote, /i morgen/);
});
