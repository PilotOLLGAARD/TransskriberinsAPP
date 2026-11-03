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

test('opretNote gemmer titel og type', async () => {
  const { kontekst, side } = await nyTelefon(miljoe);
  await side.goto(`${miljoe.adresse}/test/tom`);
  const note = await side.evaluate(async () => {
    const l = await import('/js/lager.js');
    return l.hentNote(await l.opretNote({ mime: 'audio/mp4', titel: 'Tagrenovering', type: 'moede' }));
  });
  assert.equal(note.titel, 'Tagrenovering');
  assert.equal(note.type, 'moede');
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
