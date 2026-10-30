'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, createSign, createHmac } = require('node:crypto');
const { lavAdgangsTjek } = require('../src/adgang.js');

const TENANT = '0aefac4e-4313-4168-9865-27d269eaeff8';
const ANDEN_TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT = '792bac2e-d895-4c24-9a58-7466eb8d03a3';
const KID = 'testnoegle';
const NU = 1_800_000_000_000;

let privat;
let jwk;

before(() => {
  const par = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privat = par.privateKey;
  jwk = { ...par.publicKey.export({ format: 'jwk' }), kid: KID };
});

function b64(o) {
  return Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
}

function medarbejder(ekstra = {}) {
  const sekunder = NU / 1000;
  return {
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    aud: CLIENT,
    tid: TENANT,
    scp: 'access_as_user',
    roles: ['Transskribering.Bruger'],
    acct: 0,
    exp: sekunder + 3600,
    nbf: sekunder - 60,
    ...ekstra,
  };
}

function bevis(indhold, hoved = { alg: 'RS256', kid: KID }, noegle = privat) {
  const krop = `${b64(hoved)}.${b64(indhold)}`;
  const signatur = createSign('RSA-SHA256').update(krop).sign(noegle).toString('base64url');
  return `Bearer ${krop}.${signatur}`;
}

function lavTjek(ekstra = {}) {
  const hentninger = { antal: 0 };
  const hent = async () => {
    hentninger.antal++;
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  };
  return { tjek: lavAdgangsTjek({ tenantId: TENANT, clientId: CLIENT, hent, nu: () => NU, ...ekstra }), hentninger };
}

async function forventAfvist(autorisation, status) {
  const svar = await lavTjek().tjek(autorisation);
  assert.equal(svar.ok, false);
  assert.equal(svar.status, status);
  assert.equal(typeof svar.grund, 'string');
}

test('medarbejder med rolle får adgang', async () => {
  assert.deepEqual(await lavTjek().tjek(bevis(medarbejder())), { ok: true });
});

test('401 uden bevis', () => forventAfvist(undefined, 401));
test('401 med vrøvl', () => forventAfvist('Bearer vrøvl', 401));
test('401 med anden type end Bearer', () => forventAfvist('Basic abc.def.ghi', 401));

test('401 ved forkert signatur', async () => {
  const anden = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await forventAfvist(bevis(medarbejder(), undefined, anden), 401);
});

test('401 ved ændret indhold', async () => {
  const [hoved, , signatur] = bevis(medarbejder()).slice(7).split('.');
  await forventAfvist(`Bearer ${hoved}.${b64(medarbejder({ roles: ['Admin'] }))}.${signatur}`, 401);
});

test('401 ved alg none', () => {
  const krop = `${b64({ alg: 'none', kid: KID })}.${b64(medarbejder())}`;
  return forventAfvist(`Bearer ${krop}.`, 401);
});

test('401 ved HS256 med den offentlige nøgle som hemmelighed', () => {
  const krop = `${b64({ alg: 'HS256', kid: KID })}.${b64(medarbejder())}`;
  const signatur = createHmac('sha256', JSON.stringify(jwk)).update(krop).digest('base64url');
  return forventAfvist(`Bearer ${krop}.${signatur}`, 401);
});

test('401 når beviset er udløbet', () => forventAfvist(bevis(medarbejder({ exp: NU / 1000 - 3600 })), 401));
test('401 når beviset ikke er gyldigt endnu', () => forventAfvist(bevis(medarbejder({ nbf: NU / 1000 + 3600 })), 401));
test('401 uden exp', () => forventAfvist(bevis(medarbejder({ exp: undefined })), 401));
test('401 ved ukendt nøgle', () => forventAfvist(bevis(medarbejder(), { alg: 'RS256', kid: 'ukendt' }), 401));

test('401 ved for langt bevis', () => {
  const langt = 'a'.repeat(20000);
  return forventAfvist(`Bearer ${langt}.${langt}.${langt}`, 401);
});

test('403 ved anden tenant', () => forventAfvist(bevis(medarbejder({
  iss: `https://login.microsoftonline.com/${ANDEN_TENANT}/v2.0`,
  tid: ANDEN_TENANT,
})), 403));

test('403 ved rigtig tid, men forkert udsteder', () => forventAfvist(bevis(medarbejder({
  iss: `https://login.microsoftonline.com/${ANDEN_TENANT}/v2.0`,
})), 403));

test('403 ved v1-bevis', () => forventAfvist(bevis(medarbejder({ iss: `https://sts.windows.net/${TENANT}/` })), 403));
test('403 ved forkert aud', () => forventAfvist(bevis(medarbejder({ aud: 'anden-app' })), 403));
test('403 når scope mangler', () => forventAfvist(bevis(medarbejder({ scp: 'User.Read' })), 403));
test('403 for app-bevis uden scp', () => forventAfvist(bevis(medarbejder({ scp: undefined })), 403));
test('403 når rolle mangler', () => forventAfvist(bevis(medarbejder({ roles: undefined })), 403));
test('403 ved anden rolle', () => forventAfvist(bevis(medarbejder({ roles: ['Andet'] })), 403));
test('403 for gæst (acct=1)', () => forventAfvist(bevis(medarbejder({ acct: 1 })), 403));
test('403 når acct mangler', () => forventAfvist(bevis(medarbejder({ acct: undefined })), 403));

test('mailadresse giver ikke adgang', () => forventAfvist(bevis(medarbejder({
  roles: undefined,
  preferred_username: 'x@ollgaard.dk',
})), 403));

test('hamrer ikke Microsoft', async () => {
  const { tjek, hentninger } = lavTjek();
  for (let i = 0; i < 20; i++) await tjek(bevis(medarbejder(), { alg: 'RS256', kid: `falsk-${i}` }));
  assert.equal(hentninger.antal, 1);
});

test('kendt nøgle hentes kun én gang', async () => {
  const { tjek, hentninger } = lavTjek();
  await tjek(bevis(medarbejder()));
  await tjek(bevis(medarbejder()));
  assert.equal(hentninger.antal, 1);
});

test('Microsoft nede afviser med 503, ikke krav om login', async () => {
  const hent = async () => { throw new Error('nede'); };
  const svar = await lavTjek({ hent }).tjek(bevis(medarbejder()));
  assert.deepEqual([svar.ok, svar.status], [false, 503]);
});

test('samtidige kald ved koldstart deler én hentning og får begge adgang', async () => {
  const { tjek, hentninger } = lavTjek();
  const svar = await Promise.all([tjek(bevis(medarbejder())), tjek(bevis(medarbejder()))]);
  assert.deepEqual(svar, [{ ok: true }, { ok: true }]);
  assert.equal(hentninger.antal, 1);
});

test('fejlet hentning prøves igen efter kort tid', async () => {
  let tid = NU;
  let nede = true;
  const hent = async () => {
    if (nede) throw new Error('nede');
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  };
  const { tjek } = lavTjek({ hent, nu: () => tid });
  assert.equal((await tjek(bevis(medarbejder()))).status, 503);
  nede = false;
  tid += 31 * 1000;
  assert.deepEqual(await tjek(bevis(medarbejder())), { ok: true });
});

test('fejlet hentning hamrer ikke Microsoft', async () => {
  let antal = 0;
  const hent = async () => { antal++; throw new Error('nede'); };
  const { tjek } = lavTjek({ hent });
  for (let i = 0; i < 10; i++) await tjek(bevis(medarbejder()));
  assert.equal(antal, 1);
});

test('uden tenant eller client afvises alt', async () => {
  const svar = await lavTjek({ tenantId: '' }).tjek(bevis(medarbejder()));
  assert.equal(svar.ok, false);
});
