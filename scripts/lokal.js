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
const { generateKeyPairSync, createSign, createHash, randomUUID } = require('node:crypto');
const { lavHandler } = require('../server/src/handler.js');
const { lavAdgangsTjek } = require('../server/src/adgang.js');
const { GeminiFejl } = require('../server/src/gemini.js');
const pdf = require('../server/src/pdf.js');

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
  '.svg': 'image/svg+xml',
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
      acct: 0,
      exp: nu + 3600,
      nbf: nu - 60,
    };
    if (type === 'fremmed') {
      indhold.tid = ANDEN_TENANT;
      indhold.iss = `https://login.microsoftonline.com/${ANDEN_TENANT}/v2.0`;
    }
    if (type === 'gaest') indhold.acct = 1;
    if (type === 'udloebet') indhold.exp = nu - 3600;
    const krop = `${b64({ alg: 'RS256', kid })}.${b64(indhold)}`;
    return `${krop}.${createSign('RSA-SHA256').update(krop).sign(privateKey).toString('base64url')}`;
  }

  return { jwk, bevis };
}

function startLokal({ port = 4280 } = {}) {
  const { jwk, bevis } = lavBeviser();
  const tilstand = { geminiKald: 0, referatKald: 0, mailKald: 0, sidsteMail: null, naesteFejl: null, modtaget: null, sidsteReferat: null };

  const gemini = {
    async transskriber(strom, { bytes, mime }) {
      tilstand.geminiKald++;
      const dele = [];
      for await (const d of strom) dele.push(d);
      const krop = Buffer.concat(dele);
      tilstand.modtaget = { bytes: krop.length, mime, sha256: createHash('sha256').update(krop).digest('hex') };
      // Kun transskriptionens egne fejl bruges her. Fejl i referat og mail venter på deres tur.
      const fejl = ['tjeneste', 'format', 'tom', 'langsom'].includes(tilstand.naesteFejl) ? tilstand.naesteFejl : null;
      if (fejl) tilstand.naesteFejl = null;
      if (fejl === 'tjeneste' || fejl === 'format') throw new GeminiFejl(fejl, 'testfejl');
      if (fejl === 'tom') return { tekst: '' };
      if (fejl === 'langsom') await new Promise((ok) => setTimeout(ok, 5000));
      // Som Flash: hvert afsnit starter med tidspunktet. Serveren fjerner dem fra teksten og bruger dem kun i bilaget.
      return { tekst: `[00:00] Testtekst fra lokal server.\n[00:07] Modtog ${bytes} bytes.` };
    },
  };

  // Falsk referat. PDF'en er den rigtige.
  const referat = {
    async lav({ tekst, titel, type, varighedSek, afsnit }) {
      tilstand.referatKald++;
      tilstand.sidsteReferat = { titel, type, varighedSek };
      // referat fejler én gang, referatTo de næste to gange (fx både på /transskriber og /referat).
      if (tilstand.naesteFejl === 'referat' || tilstand.naesteFejl === 'referatTo') {
        tilstand.naesteFejl = tilstand.naesteFejl === 'referatTo' ? 'referat' : null;
        throw new GeminiFejl('tjeneste', 'testfejl');
      }
      return {
        // Automatisk bliver til Andet, som når modellen ikke kan vælge.
        titel: titel || 'Testtitel fra AI', type: !type || type === 'automatisk' ? 'andet' : type, kort: false,
        opsummering: `Testreferat af: ${tekst}`, hovedpunkter: ['Første punkt', 'Andet punkt med æøå'], beslutninger: [],
        opgaver: [], fejlOgMangler: [], maalOgMaengder: [], huskeliste: type === 'paamindelse' ? ['Huskepunkt'] : [],
        aabneSpoergsmaal: [], renTekst: '',
        // Ét emne, når teksten har tidspunkter. Bilaget i PDF'en får så tid og undertitel.
        ...(afsnit?.some((a) => a.sek !== null) ? { emner: [{ fra: 0, undertitel: 'Testemne' }] } : {}),
      };
    },
  };

  const hentNoegler = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  const handler = lavHandler({
    konfig: { tilladtOprindelse: `http://localhost:${port}`, maxBytes: 157286400 },
    tjekAdgang: lavAdgangsTjek({ tenantId: TENANT, clientId: CLIENT, hent: hentNoegler }),
    gemini,
    referat,
    pdf,
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
        referatKald: tilstand.referatKald,
        sidsteReferat: tilstand.sidsteReferat,
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

  // Forbindelsen tabes midt i upload: Efter de første 64 KB lukkes forbindelsen uden svar.
  // Gælder, til en anden fejl sættes, for browseren prøver selv igen på en ny forbindelse.
  function afbrydUpload(req) {
    let modtaget = 0;
    req.on('data', (d) => {
      modtaget += d.length;
      if (modtaget >= 64 * 1024) req.socket.destroy();
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/transskriber' && req.method === 'POST' && tilstand.naesteFejl === 'afbrydUpload') return afbrydUpload(req);
    if (url.pathname === '/transskriber' || url.pathname === '/referat') return handler(req, res);
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
