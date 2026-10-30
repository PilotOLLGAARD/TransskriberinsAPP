'use strict';

/**
 * Lokal server til udvikling og test. Den koster ikke noget og sender intet ud af computeren.
 *
 * Handler og adgangstjek er de rigtige. Login, Gemini og Microsoft Graph er falske.
 * Filen ligger uden for server/, så den aldrig kommer med på den rigtige server.
 */

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { generateKeyPairSync, createSign, randomUUID } = require('node:crypto');
const { lavHandler } = require('../server/src/handler.js');
const { lavAdgangsTjek } = require('../server/src/adgang.js');
const { GeminiFejl } = require('../server/src/gemini.js');

const WEB = path.resolve(__dirname, '..', 'web');
const TENANT = '00000000-0000-0000-0000-00000000000a';
const CLIENT = '00000000-0000-0000-0000-00000000000c';
const ANDEN_TENANT = '11111111-1111-1111-1111-111111111111';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

function lavBeviser() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

  function bevis(type) {
    const nu = Math.floor(Date.now() / 1000);
    const indhold = {
      iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      aud: CLIENT,
      tid: TENANT,
      scp: 'access_as_user',
      roles: ['Transskribering.Bruger'],
      acct: 0,
      exp: nu + 3600,
      nbf: nu - 60,
    };
    if (type === 'fremmed') {
      indhold.tid = ANDEN_TENANT;
      indhold.iss = `https://login.microsoftonline.com/${ANDEN_TENANT}/v2.0`;
    }
    if (type === 'uden-rolle') delete indhold.roles;
    if (type === 'gaest') indhold.acct = 1;
    if (type === 'udloebet') indhold.exp = nu - 3600;
    const krop = `${b64({ alg: 'RS256', kid })}.${b64(indhold)}`;
    return `${krop}.${createSign('RSA-SHA256').update(krop).sign(privateKey).toString('base64url')}`;
  }

  return { jwk, bevis };
}

function startLokal({ port = 4280 } = {}) {
  const { jwk, bevis } = lavBeviser();
  const tilstand = { geminiKald: 0, mailKald: 0, sidsteMail: null, naesteFejl: null, modtaget: null };

  const gemini = {
    async transskriber(strom, { bytes, mime }) {
      tilstand.geminiKald++;
      const dele = [];
      for await (const d of strom) dele.push(d);
      tilstand.modtaget = { bytes: Buffer.concat(dele).length, mime };
      const fejl = tilstand.naesteFejl;
      tilstand.naesteFejl = null;
      if (fejl === 'tjeneste' || fejl === 'format') throw new GeminiFejl(fejl, 'testfejl');
      if (fejl === 'tom') return { tekst: '' };
      return { tekst: `Testtekst fra lokal server. Modtog ${bytes} bytes.` };
    },
  };

  const hentNoegler = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  const handler = lavHandler({
    konfig: { tilladtOprindelse: `http://localhost:${port}`, maxBytes: 157286400 },
    tjekAdgang: lavAdgangsTjek({ tenantId: TENANT, clientId: CLIENT, hent: hentNoegler }),
    gemini,
    log: () => {},
  });

  async function testRute(url, req, res) {
    const json = (status, krop) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(krop));
    };
    if (url.pathname === '/test/tom') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>tom</title>');
      return;
    }
    if (url.pathname === '/test/bevis') return json(200, { bevis: bevis(url.searchParams.get('type')) });
    if (url.pathname === '/test/tal') {
      return json(200, {
        geminiKald: tilstand.geminiKald,
        mailKald: tilstand.mailKald,
        sidsteMail: tilstand.sidsteMail,
        modtaget: tilstand.modtaget,
      });
    }
    if (url.pathname === '/test/fejl') {
      tilstand.naesteFejl = url.searchParams.get('naeste');
      return json(200, {});
    }
    if (url.pathname === '/test/graph/v1.0/me/sendMail') {
      let krop = '';
      for await (const d of req) krop += d;
      if (tilstand.naesteFejl === 'mail') {
        tilstand.naesteFejl = null;
        return json(500, {});
      }
      tilstand.mailKald++;
      tilstand.sidsteMail = JSON.parse(krop);
      res.writeHead(202);
      res.end();
      return;
    }
    json(404, {});
  }

  async function statisk(url, res) {
    const sti = path.join(WEB, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!sti.startsWith(WEB + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const indhold = await fs.readFile(sti);
      res.writeHead(200, { 'content-type': MIME[path.extname(sti)] || 'application/octet-stream' });
      res.end(indhold);
    } catch {
      res.writeHead(404);
      res.end();
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/transskriber') return handler(req, res);
    if (url.pathname.startsWith('/test/')) return testRute(url, req, res);
    return statisk(url, res);
  });

  return new Promise((ok) => {
    server.listen(port, () => {
      const adresse = `http://localhost:${server.address().port}`;
      ok({
        adresse,
        stop: () => new Promise((faerdig) => {
          server.close(faerdig);
          server.closeAllConnections();
        }),
      });
    });
  });
}

if (require.main === module) {
  startLokal().then(({ adresse }) => console.log(`Lokal server med falsk login og falsk transskription: ${adresse}`));
}

module.exports = { startLokal };
