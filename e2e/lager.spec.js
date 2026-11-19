'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMiljoe, nyTelefon } = require('./hjaelpere.js');

let miljoe;
before(async () => { miljoe = await startMiljoe(); });
after(async () => { await miljoe.stop(); });

test('lyd bevares byte for byte over genindlæsning', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.goto(`${miljoe.adresse}/test/tom`);
  const id = await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    const noteId = await l.opretNote({ mime: 'audio/mp4' });
    await l.gemStykke(noteId, 0, new Uint8Array([0, 1, 2]).buffer);
    await l.gemStykke(noteId, 1, new Uint8Array([255, 254]).buffer);
    return noteId;
  });
  await side.reload();
  const svar = await side.evaluate(async (noteId) => {
    const l = await import('/js/lager.js');
    const blob = await l.hentLyd(noteId);
    return { bytes: [...new Uint8Array(await blob.arrayBuffer())], type: blob.type };
  }, id);
  assert.deepEqual(svar.bytes, [0, 1, 2, 255, 254]);
  assert.equal(svar.type, 'audio/mp4');
  await kontekst.close();
});

test('sletNote fjerner note og alle stykker', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.goto(`${miljoe.adresse}/test/tom`);
  const svar = await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    const a = await l.opretNote({ mime: 'audio/mp4' });
    const b = await l.opretNote({ mime: 'audio/mp4' });
    await l.gemStykke(a, 0, new Uint8Array([1]).buffer);
    await l.gemStykke(b, 0, new Uint8Array([2]).buffer);
    await l.sletNote(a);
    return {
      noter: (await l.alleNoter()).map((n) => n.id),
      lydA: (await l.hentLyd(a)).size,
      lydB: (await l.hentLyd(b)).size,
      a,
      b,
    };
  });
  assert.deepEqual(svar.noter, [svar.b]);
  assert.equal(svar.lydA, 0);
  assert.equal(svar.lydB, 1);
  await kontekst.close();
});

test('en tabt forbindelse åbnes igen', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.goto(`${miljoe.adresse}/test/tom`);
  const svar = await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    const id = await l.opretNote({ mime: 'audio/mp4' });
    (await l.aabn()).close();
    await l.gemStykke(id, 0, new Uint8Array([7]).buffer);
    return (await l.hentLyd(id)).size;
  });
  assert.equal(svar, 1);
  await kontekst.close();
});

test('opdaterNote fletter felter', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.goto(`${miljoe.adresse}/test/tom`);
  const note = await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    const id = await l.opretNote({ mime: 'audio/mp4' });
    await l.opdaterNote(id, { status: 'gemt', tekst: 'x' });
    return l.hentNote(id);
  });
  assert.equal(note.mime, 'audio/mp4');
  assert.equal(note.status, 'gemt');
  assert.equal(note.tekst, 'x');
  await kontekst.close();
});

test('opretNote gemmer titel og ingen type – typen vælges af AI', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.goto(`${miljoe.adresse}/test/tom`);
  const note = await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    return l.hentNote(await l.opretNote({ mime: 'audio/mp4', titel: 'Tagrenovering', type: 'moede' }));
  });
  assert.equal(note.titel, 'Tagrenovering');
  assert.equal('type' in note, false);
  await kontekst.close();
});

test('opretNote gemmer kilde og filnavn for en lydfil, men intet for en optagelse', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.goto(`${miljoe.adresse}/test/tom`);
  const [fil, optagelse] = await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    return [
      await l.hentNote(await l.opretNote({ mime: 'audio/mpeg', kilde: 'fil', filnavn: 'Møde.mp3' })),
      await l.hentNote(await l.opretNote({ mime: 'audio/mp4' })),
    ];
  });
  assert.equal(fil.kilde, 'fil');
  assert.equal(fil.filnavn, 'Møde.mp3');
  assert.equal('kilde' in optagelse, false);
  assert.equal('filnavn' in optagelse, false);
  await kontekst.close();
});

test('opretNote bruger et givet id, og gemStykke stempler noten som aktiv', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.goto(`${miljoe.adresse}/test/tom`);
  const svar = await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    const id = await l.opretNote({ id: 'fast-id', mime: 'audio/mp4' });
    const foer = (await l.hentNote(id)).sidstAktiv;
    await l.gemStykke(id, 0, new Uint8Array([1]).buffer);
    return { id, foer, efter: (await l.hentNote(id)).sidstAktiv };
  });
  assert.equal(svar.id, 'fast-id');
  assert.equal(svar.foer, undefined);
  assert.ok(Number.isFinite(svar.efter));
  await kontekst.close();
});

test('sletLyd fjerner stykker, men beholder noten', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.goto(`${miljoe.adresse}/test/tom`);
  const svar = await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    const id = await l.opretNote({ mime: 'audio/mp4' });
    await l.gemStykke(id, 0, new Uint8Array([1, 2, 3]).buffer);
    await l.opdaterNote(id, { pdf: 'JVBERg==' });
    await l.sletLyd(id);
    return { note: await l.hentNote(id), bytes: (await l.hentLyd(id)).size };
  });
  assert.equal(svar.bytes, 0);
  assert.equal(svar.note.pdf, 'JVBERg==');
  await kontekst.close();
});

test('hentDele giver én Blob pr. del i rækkefølge, byte for byte, og gamle stykker er del 0', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.goto(`${miljoe.adresse}/test/tom`);
  const svar = await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    const id = await l.opretNote({ mime: 'audio/mp4' });
    await l.gemStykke(id, 0, new Uint8Array([1, 2]).buffer);
    await l.gemStykke(id, 1, new Uint8Array([3]).buffer, 0);
    await l.gemStykke(id, 2, new Uint8Array([4, 5]).buffer, 1);
    await l.gemStykke(id, 3, new Uint8Array([6]).buffer, 2);
    const dele = await l.hentDele(id);
    return {
      dele: await Promise.all(dele.map(async (b) => [...new Uint8Array(await b.arrayBuffer())])),
      type: dele[0].type,
      hoejeste: await l.hoejesteNr(id),
      tom: await l.hoejesteNr('findes-ikke'),
    };
  });
  assert.deepEqual(svar.dele, [[1, 2, 3], [4, 5], [6]]);
  assert.equal(svar.type, 'audio/mp4');
  assert.equal(svar.hoejeste, 3);
  assert.equal(svar.tom, -1);
  await kontekst.close();
});

test('lavKilde læser et udsnit på tværs af stykker og holder delene adskilt', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.goto(`${miljoe.adresse}/test/tom`);
  const svar = await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    const id = await l.opretNote({ mime: 'audio/mp4' });
    const fem = (start) => new Uint8Array([0, 1, 2, 3, 4].map((x) => start + x)).buffer;
    await l.gemStykke(id, 0, fem(0), 0);
    await l.gemStykke(id, 1, fem(10), 0);
    await l.gemStykke(id, 2, fem(20), 0);
    // Del 1 af en afbrudt optagelse, og et stykke fra en uploadet fil som Blob.
    await l.gemStykke(id, 3, fem(100), 1);
    await l.gemStykke(id, 4, new Blob([new Uint8Array([200, 201])]), 1);
    const k0 = await l.lavKilde(id, 0);
    const k1 = await l.lavKilde(id, 1);
    const laest = [...await k0.laes(3, 12)];
    const udsnit = [...new Uint8Array(await (await k0.udsnit(3, 12)).arrayBuffer())];
    return {
      stoerrelse: [k0.stoerrelse, k1.stoerrelse],
      laest,
      udsnit,
      del1: [...await k1.laes(0, 7)],
      kant: [...await k0.laes(13, 99)],
    };
  });
  assert.deepEqual(svar.stoerrelse, [15, 7]);
  assert.deepEqual(svar.laest, [3, 4, 10, 11, 12, 13, 14, 20, 21]);
  assert.deepEqual(svar.udsnit, svar.laest);
  assert.deepEqual(svar.del1, [100, 101, 102, 103, 104, 200, 201]);
  assert.deepEqual(svar.kant, [23, 24]);
  await kontekst.close();
});

test('lavKilder giver en kilde for hver del med lyd i én gennemgang', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.goto(`${miljoe.adresse}/test/tom`);
  const svar = await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    const id = await l.opretNote({ mime: 'audio/mp4' });
    await l.gemStykke(id, 0, new Uint8Array([1, 2]).buffer, 0);
    await l.gemStykke(id, 1, new Uint8Array([3]).buffer, 2);
    const kilder = await l.lavKilder(id);
    return { dele: [...kilder.keys()], to: [...await kilder.get(2).laes(0, 9)], nul: kilder.get(0).stoerrelse };
  });
  assert.deepEqual(svar, { dele: [0, 2], to: [3], nul: 2 });
  await kontekst.close();
});
