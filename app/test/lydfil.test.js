import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAKS_BYTES, MAKS_VARIGHED_MS, STYKKE_BYTES, genkendFormat, kontrollerFil, gemFil, navnUdenEndelse, formaterMB, hentDeltFil, fjernDeltKopi } from '../js/lydfil.js';
import { STATUS } from '../js/tilstand.js';

const tekst = (s) => [...s].map((c) => c.charCodeAt(0));
const start = (...dele) => new Uint8Array(dele.flat());

test('genkender lydformater på de første bytes', () => {
  const tilfaelde = [
    ['m4a', start([0, 0, 0, 0x20], tekst('ftypM4A '))],
    ['m4a', start([0, 0, 0, 0x18], tekst('ftypmp42'))],
    ['mp3', start(tekst('ID3'), [4, 0, 0, 0, 0, 0, 0])],
    ['mp3', start([0xff, 0xfb, 0x90, 0x64])],
    ['mp3', start([0xff, 0xf3, 0x48, 0xc4])],
    ['wav', start(tekst('RIFF'), [0x24, 0, 0, 0], tekst('WAVE'), tekst('fmt '))],
    ['ogg', start(tekst('OggS'), [0, 2])],
    ['webm', start([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42])],
    ['flac', start(tekst('fLaC'), [0, 0, 0, 0x22])],
    ['aac', start([0xff, 0xf1, 0x50, 0x80])],
    ['aac', start([0xff, 0xf9, 0x50, 0x80])],
  ];
  for (const [format, bytes] of tilfaelde) assert.equal(genkendFormat(bytes), format, `${format}: ${[...bytes.slice(0, 6)]}`);
});

test('m4a fra Samsung Stemmeoptager og Pixel Optager genkendes, uanset hvilket mærke filen har', () => {
  for (const maerke of ['3gp4', 'isom', 'M4A ', 'mp42', '3gp5']) {
    assert.equal(genkendFormat(start([0, 0, 0, 0x18], tekst(`ftyp${maerke}`), [0, 0, 0, 0])), 'm4a', maerke);
  }
});

test('AMR (ældre Android-optagelser) genkendes ikke, så filen afvises med beskeden om formater', () => {
  assert.equal(genkendFormat(start(tekst('#!AMR\n'), [0x3c, 0x48])), null);
  assert.equal(genkendFormat(start(tekst('#!AMR-WB\n'), [0x3c])), null);
});

test('andet end lyd genkendes ikke', () => {
  for (const bytes of [
    new Uint8Array(0),
    start(tekst('%PDF-1.7')),
    start([0xff, 0xd8, 0xff, 0xe0]), // JPEG
    start([0x89], tekst('PNG')),
    start(tekst('RIFF'), [0, 0, 0, 0], tekst('AVI ')),
    start(tekst('PK'), [3, 4]),
    start(tekst('Hej med dig')),
    start([0xff, 0xfb, 0xf0, 0x00]), // MPEG-hoved med ugyldig bitrate
    start([0xff, 0xe0]), // for kort
  ]) assert.equal(genkendFormat(bytes), null, String([...bytes]));
});

function fil(bytes, navn = 'Ny optagelse 14.m4a', type = 'audio/x-m4a') {
  return new File([bytes], navn, { type });
}
const M4A = start([0, 0, 0, 0x20], tekst('ftypM4A '), new Array(40).fill(7));
const MP3 = start(tekst('ID3'), new Array(40).fill(1));
const altid = (ms) => async () => ms;

test('en lydfil godkendes med format, MIME og varighed', async () => {
  const k = await kontrollerFil(fil(M4A), { laesVarighed: altid(47 * 60 * 1000) });
  assert.deepEqual(k, { ok: true, format: 'm4a', mime: 'audio/x-m4a', varighedMs: 47 * 60 * 1000, bytes: M4A.length, filnavn: 'Ny optagelse 14.m4a' });
});

test('MIME udledes af formatet, når filen ikke har en brugbar type', async () => {
  for (const [type, forventet] of [['', 'audio/mpeg'], ['application/octet-stream', 'audio/mpeg'], ['audio/mp3', 'audio/mpeg'], ['video/mp4', 'audio/mpeg'], ['audio/mpeg', 'audio/mpeg']]) {
    const k = await kontrollerFil(fil(MP3, 'x.mp3', type), { laesVarighed: altid(null) });
    assert.equal(k.mime, forventet, type);
  }
  // Typen må ikke modsige indholdet.
  assert.equal((await kontrollerFil(fil(M4A, 'x.m4a', 'audio/webm'), { laesVarighed: altid(null) })).mime, 'audio/mp4');
  assert.equal((await kontrollerFil(fil(start(tekst('RIFF'), [0, 0, 0, 0], tekst('WAVE')), 'x.wav', 'audio/x-wav'), { laesVarighed: altid(null) })).mime, 'audio/wav');
});

test('m4a med de typer, Android-apps deler med, sendes som en type, serveren kender', async () => {
  const SAMSUNG = start([0, 0, 0, 0x18], tekst('ftyp3gp4'), new Array(40).fill(3));
  for (const [type, forventet] of [
    ['audio/mp4', 'audio/mp4'], ['audio/x-m4a', 'audio/x-m4a'], ['audio/m4a', 'audio/mp4'], ['audio/mp4a-latm', 'audio/mp4'],
    ['audio/3gpp', 'audio/mp4'], ['audio/aac', 'audio/mp4'], ['', 'audio/mp4'], ['application/octet-stream', 'audio/mp4'],
  ]) {
    const k = await kontrollerFil(fil(SAMSUNG, 'Stemme 001.m4a', type), { laesVarighed: altid(null) });
    assert.equal(k.ok, true, type);
    assert.equal(k.format, 'm4a', type);
    assert.equal(k.mime, forventet, type);
  }
});

test('en tom delt fil afvises som ikke-lyd', async () => {
  assert.deepEqual(await kontrollerFil(fil(new Uint8Array(0), 'tom.m4a'), { laesVarighed: altid(null) }), { ok: false, fejl: 'ikkeLydfil' });
});

test('ukendt varighed er tilladt', async () => {
  const k = await kontrollerFil(fil(M4A), { laesVarighed: altid(null) });
  assert.equal(k.ok, true);
  assert.equal(k.varighedMs, null);
});

test('varigheden får en tidsgrænse og må ikke stoppe kontrollen', async () => {
  const k = await kontrollerFil(fil(M4A), { laesVarighed: () => new Promise(() => {}), tidsgraenseMs: 30 });
  assert.equal(k.ok, true);
  assert.equal(k.varighedMs, null);
  const k2 = await kontrollerFil(fil(M4A), { laesVarighed: async () => { throw new Error('x'); } });
  assert.equal(k2.varighedMs, null);
});

test('en fil over 2½ time afvises med forLang, og præcis 2½ time godtages', async () => {
  assert.equal(MAKS_VARIGHED_MS, 9000 * 1000);
  assert.deepEqual(await kontrollerFil(fil(M4A), { laesVarighed: altid(MAKS_VARIGHED_MS + 1000) }), { ok: false, fejl: 'forLang' });
  assert.equal((await kontrollerFil(fil(M4A), { laesVarighed: altid(MAKS_VARIGHED_MS) })).ok, true);
});

test('andet end lyd afvises, før noget gemmes', async () => {
  let laest = false;
  const k = await kontrollerFil(fil(start(tekst('%PDF-1.7')), 'tegning.pdf', 'application/pdf'), { laesVarighed: async () => { laest = true; return 1; } });
  assert.deepEqual(k, { ok: false, fejl: 'ikkeLydfil' });
  assert.equal(laest, false);
});

test('over 500 MB afvises uden at læse filen', async () => {
  const stor = { name: 'lang.wav', type: 'audio/wav', size: MAKS_BYTES + 1, slice: () => { throw new Error('må ikke læses'); } };
  assert.deepEqual(await kontrollerFil(stor, { laesVarighed: altid(1) }), { ok: false, fejl: 'forStorFil' });
  assert.equal(MAKS_BYTES, 500 * 1024 * 1024);
});

test('en fil, der ikke kan læses, giver en forståelig fejl', async () => {
  const daarlig = { name: 'x.m4a', type: 'audio/mp4', size: 100, slice: () => ({ arrayBuffer: async () => { throw new DOMException('nej', 'NotReadableError'); } }) };
  assert.deepEqual(await kontrollerFil(daarlig, { laesVarighed: altid(1) }), { ok: false, fejl: 'filKanIkkeLaeses' });
});

test('navnet uden endelse', () => {
  assert.equal(navnUdenEndelse('Ny optagelse 14.m4a'), 'Ny optagelse 14');
  assert.equal(navnUdenEndelse('møde.v2.mp3'), 'møde.v2');
  assert.equal(navnUdenEndelse('uden endelse'), 'uden endelse');
  assert.equal(navnUdenEndelse('.m4a'), '');
  assert.equal(navnUdenEndelse(''), '');
});

test('MB vises som i telefonens Filer', () => {
  assert.equal(formaterMB(36 * 1000 * 1000), '36');
  assert.equal(formaterMB(14.4 * 1000 * 1000), '14');
  assert.equal(formaterMB(512 * 1024), '0,5');
  assert.equal(formaterMB(2.25 * 1000 * 1000), '2,3');
  assert.equal(formaterMB(0), '0');
});

// Gemning

function falskLager({ fuldVed = null } = {}) {
  const noter = new Map();
  const stykker = [];
  return {
    noter,
    stykker,
    async opretNote({ id = 'n1', mime, titel = '', kilde, filnavn, oprettet = 1 }) {
      noter.set(id, { id, mime, titel, kilde, filnavn, status: STATUS.OPTAGER, oprettet });
      return id;
    },
    async gemStykke(id, nr, bytes, del = 0) {
      if (fuldVed !== null && nr >= fuldVed) throw new DOMException('fuld', 'QuotaExceededError');
      // Et Blob-udsnit af filen: browseren lægger det på disk, så en stor fil aldrig ligger i hukommelsen.
      assert.ok(bytes instanceof Blob, 'stykket gemmes som Blob');
      stykker.push({ id, nr, bytes, del });
    },
    async opdaterNote(id, felter) { Object.assign(noter.get(id), felter); },
    async sletNote(id) { noter.delete(id); for (let i = stykker.length - 1; i >= 0; i--) if (stykker[i].id === id) stykker.splice(i, 1); },
  };
}

test('filen gemmes byte for byte i stykker, før noget sendes', async () => {
  const bytes = new Uint8Array(2.5 * STYKKE_BYTES);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 255;
  bytes.set(M4A);
  const f = fil(bytes);
  const lager = falskLager();
  const kontrol = await kontrollerFil(f, { laesVarighed: altid(90_000) });
  const id = await gemFil({ lager, fil: f, kontrol, titel: 'Ny optagelse 14' });
  assert.equal(lager.stykker.length, 3);
  assert.deepEqual(lager.stykker.map((s) => s.nr), [0, 1, 2]);
  assert.deepEqual(lager.stykker.map((s) => s.del), [0, 0, 0]);
  const samlet = new Uint8Array(await new Blob(lager.stykker.map((s) => s.bytes)).arrayBuffer());
  assert.deepEqual(samlet, bytes);
  const n = lager.noter.get(id);
  assert.equal(n.status, STATUS.GEMT);
  assert.equal(n.kilde, 'fil');
  assert.equal(n.filnavn, 'Ny optagelse 14.m4a');
  assert.equal(n.bytes, bytes.length);
  assert.equal(n.varighedMs, 90_000);
  assert.equal(n.mime, 'audio/x-m4a');
  assert.equal(n.titel, 'Ny optagelse 14');
  assert.equal(n.navngivet, undefined);
});

test('ukendt varighed gemmes ikke som et tal', async () => {
  const lager = falskLager();
  const f = fil(M4A);
  const id = await gemFil({ lager, fil: f, kontrol: await kontrollerFil(f, { laesVarighed: altid(null) }) });
  assert.equal('varighedMs' in lager.noter.get(id) && lager.noter.get(id).varighedMs !== undefined, false);
});

test('gemningen holder låsen, så andre faner ikke tager den halve fil, og slipper den bagefter', async () => {
  const raekke = [];
  const lager = falskLager();
  const gem = lager.gemStykke.bind(lager);
  lager.gemStykke = async (...a) => { raekke.push('stykke'); return gem(...a); };
  const f = fil(M4A);
  await gemFil({
    lager, fil: f, kontrol: await kontrollerFil(f, { laesVarighed: altid(null) }), id: 'x',
    laas: async (navn) => { raekke.push(`laas ${navn}`); return () => raekke.push('frigiv'); },
  });
  assert.deepEqual(raekke, ['laas optag-x', 'stykke', 'frigiv']);
});

test('fuldt lager: intet halvt gemt bliver liggende, og fejlen er pladsTom', async () => {
  const lager = falskLager({ fuldVed: 1 });
  const f = fil(new Uint8Array(2 * STYKKE_BYTES).fill(3));
  let frigivet = false;
  await assert.rejects(
    gemFil({ lager, fil: f, kontrol: { ok: true, format: 'm4a', mime: 'audio/mp4', varighedMs: null, bytes: f.size, filnavn: f.name }, laas: async () => () => { frigivet = true; } }),
    (e) => e.type === 'pladsTom',
  );
  assert.equal(lager.noter.size, 0);
  assert.equal(lager.stykker.length, 0);
  assert.equal(frigivet, true);
});

test('stykkerne læses ikke ind i hukommelsen, når de gemmes', async () => {
  const f = fil(new Uint8Array(2 * STYKKE_BYTES + 5).fill(9));
  const laest = [];
  const vagt = {
    name: f.name, type: f.type, size: f.size, lastModified: f.lastModified,
    slice: (...a) => {
      const b = f.slice(...a);
      for (const m of ['arrayBuffer', 'text', 'stream', 'bytes']) b[m] = () => { laest.push(m); throw new Error('læst'); };
      return b;
    },
  };
  const lager = falskLager();
  await gemFil({ lager, fil: vagt, kontrol: { ok: true, format: 'm4a', mime: 'audio/mp4', varighedMs: null, bytes: f.size, filnavn: f.name } });
  assert.deepEqual(laest, []);
  assert.deepEqual(lager.stykker.map((s) => s.bytes.size), [STYKKE_BYTES, STYKKE_BYTES, 5]);
});

test('en fil, der ikke kan læses undervejs, efterlader intet', async () => {
  const lager = falskLager();
  // Browseren læser filen, når stykket skrives til lageret. Kan den ikke, fejler skrivningen.
  const gem = lager.gemStykke.bind(lager);
  lager.gemStykke = async (id, nr, ...rest) => { if (nr > 0) throw new DOMException('nej', 'NotReadableError'); return gem(id, nr, ...rest); };
  const daarlig = fil(new Uint8Array(2 * STYKKE_BYTES).fill(3));
  await assert.rejects(
    gemFil({ lager, fil: daarlig, kontrol: { ok: true, format: 'm4a', mime: 'audio/mp4', varighedMs: null, bytes: daarlig.size, filnavn: 'x.m4a' } }),
    (e) => e.type === 'filKanIkkeLaeses',
  );
  assert.equal(lager.noter.size, 0);
  assert.equal(lager.stykker.length, 0);
});

test('en fil, der ændrer størrelse under læsningen, gemmes ikke', async () => {
  const lager = falskLager();
  const kort = { name: 'x.m4a', type: 'audio/mp4', size: 100, slice: () => new Blob([new Uint8Array(60)]) };
  await assert.rejects(
    gemFil({ lager, fil: kort, kontrol: { ok: true, format: 'm4a', mime: 'audio/mp4', varighedMs: null, bytes: 100, filnavn: 'x.m4a' } }),
    (e) => e.type === 'filKanIkkeLaeses',
  );
  assert.equal(lager.noter.size, 0);
});

// Fil fra del-menuen (Android), lagt i Cache Storage af service workeren

function falskeCaches(indhold = {}) {
  const lagre = new Map();
  const slettet = [];
  return {
    slettet,
    lagre,
    async open(navn) {
      if (!lagre.has(navn)) lagre.set(navn, new Map(Object.entries(indhold[navn] || {})));
      const l = lagre.get(navn);
      return {
        match: async (n) => l.get(String(n)) ?? undefined,
        delete: async (n) => { slettet.push(String(n)); return l.delete(String(n)); },
      };
    },
  };
}

const APP = 'https://pilotollgaard.github.io/TransskriberinsAPP/?delt=1';
const NOEGLE = 'https://pilotollgaard.github.io/TransskriberinsAPP/delt-fil';

test('den delte fil hentes med navn og type, og kopien fjernes først, når appen beder om det', async () => {
  const caches = falskeCaches({ 'delt-lydfil': { [NOEGLE]: new Response(new Uint8Array([9, 8, 7]), { headers: { 'content-type': 'audio/mpeg', 'x-filnavn': encodeURIComponent('Møde på pladsen.mp3') } }) } });
  const delt = await hentDeltFil({ caches, adresse: APP });
  assert.equal(delt.fil.name, 'Møde på pladsen.mp3');
  assert.equal(delt.fil.type, 'audio/mpeg');
  assert.deepEqual([...new Uint8Array(await delt.fil.arrayBuffer())], [9, 8, 7]);
  assert.deepEqual(caches.slettet, []);
  await delt.fjern();
  assert.deepEqual(caches.slettet, [NOEGLE]);
});

test('ingen delt fil giver null, også uden Cache Storage', async () => {
  assert.equal(await hentDeltFil({ caches: falskeCaches(), adresse: APP }), null);
  assert.equal(await hentDeltFil({ caches: undefined, adresse: APP }), null);
});

// Den midlertidige kopi fra del-menuen fjernes kun, når den ikke skal bruges igen

test('kopien fjernes efter gemning, Annullér og fejl, der ikke kan rettes ved at prøve igen', () => {
  for (const udfald of ['gemt', 'annulleret', 'ikkeLydfil', 'forStorFil', 'forLang']) assert.equal(fjernDeltKopi(udfald), true, udfald);
});

test('kopien bevares ved fuldt lager og læsefejl, så brugeren kan prøve igen', () => {
  for (const udfald of ['pladsTom', 'filKanIkkeLaeses', undefined, 'ukendt']) assert.equal(fjernDeltKopi(udfald), false, String(udfald));
});

// Optagedato

const DAG = 24 * 60 * 60 * 1000;
const NU_TID = Date.UTC(2026, 10, 6, 12, 0);
const filFra = (lastModified) => new File([M4A], 'x.m4a', { type: 'audio/mp4', lastModified });

test('en uploadet fil får filens ændringsdato som optagedato', async () => {
  const lager = falskLager();
  const f = filFra(NU_TID - 3 * DAG);
  const id = await gemFil({ lager, fil: f, kontrol: await kontrollerFil(f, { laesVarighed: altid(null) }), nu: () => NU_TID });
  assert.equal(lager.noter.get(id).oprettet, NU_TID - 3 * DAG);
});

test('en dato i fremtiden eller uden værdi giver nu som optagedato', async () => {
  for (const lastModified of [NU_TID + DAG, 0, -5]) {
    const lager = falskLager();
    const f = filFra(lastModified);
    const id = await gemFil({ lager, fil: f, kontrol: await kontrollerFil(f, { laesVarighed: altid(null) }), nu: () => NU_TID });
    assert.equal(lager.noter.get(id).oprettet, NU_TID, String(lastModified));
  }
  const lager = falskLager();
  const udenDato = { name: 'x.m4a', type: 'audio/mp4', size: M4A.length, lastModified: undefined, slice: (...a) => new Blob([M4A]).slice(...a) };
  const id = await gemFil({ lager, fil: udenDato, kontrol: { ok: true, format: 'm4a', mime: 'audio/mp4', varighedMs: null, bytes: M4A.length, filnavn: 'x.m4a' }, nu: () => NU_TID });
  assert.equal(lager.noter.get(id).oprettet, NU_TID);
});
