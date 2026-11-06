'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { talIKilde, kontrollerTal } = require('../src/tal.js');

const U = '[uklart]';

/** Kun ét tekstfelt: det gør fælderne lette at læse. */
function tjek(kilde, tekst) {
  return kontrollerTal({ opsummering: tekst }, kilde).referat.opsummering;
}

/** Alle tal skrevet med cifre i et referat. */
function cifre(tekst) {
  return tekst.match(/\d+(?:[.,]\d+)*/g) ?? [];
}

// Tal i transskriptionen

test('talIKilde finder cifre, decimaler og tusinder', () => {
  const t = talIKilde('Revnen er 60 cm lang, 2,5 meter fra hjørnet, og det koster 1.500 kr. eller 12 500 kr.');
  for (const v of [60, 2.5, 1500, 12500]) assert.ok(t.has(v), String(v));
});

test('talIKilde forstår danske talord', () => {
  const t = talIKilde('fire sække, niogfirs procent, to hundrede og halvtreds meter, tre tusind fem hundrede kroner, femten hundrede, halvanden time, en komma fem meter, tolv');
  for (const v of [4, 89, 250, 3500, 1500, 1.5, 12]) assert.ok(t.has(v), String(v));
});

test('talIKilde forstår ordenstal og klokkeslæt', () => {
  const t = talIKilde('den tredje november klokken halv otte, og fredag den enogtyvende');
  for (const v of [3, 8, 7, 30, 21]) assert.ok(t.has(v), String(v));
});

test('et talord, der ikke findes, giver intet tal', () => {
  const t = talIKilde('nittenogfirs procent');
  assert.equal(t.has(89), false);
  assert.equal(t.has(84), false);
});

// Fælder: tal i referatet, der ikke blev sagt

test('fælde: forkert talord bliver ikke til et gættet tal', () => {
  assert.equal(tjek('Genbrugte mursten sparer op mod nittenogfirs procent.', 'Genbrugte mursten sparer op mod 89 procent.'), `Genbrugte mursten sparer op mod ${U} procent.`);
});

test('fælde: et sagt tal og et talord bliver stående', () => {
  assert.equal(tjek('Bestil fire sække fugemørtel, cirka 3 kvadratmeter.', 'Bestil 4 sække til 3 m².'), 'Bestil 4 sække til 3 m².');
});

test('fælde: rettelse undervejs — kun sagte tal står, et tredje tal markeres', () => {
  const kilde = 'Hullet skal være tre meter, nej fire meter bredt.';
  assert.equal(tjek(kilde, 'Hullet skal være 4 meter bredt.'), 'Hullet skal være 4 meter bredt.');
  assert.equal(tjek(kilde, 'Hullet skal være 7 meter bredt.'), `Hullet skal være ${U} meter bredt.`);
});

test('fælde: datoer — årstal og dage, der ikke blev sagt, markeres', () => {
  const kilde = 'Leverancen kommer den tredje november.';
  assert.equal(tjek(kilde, 'Leverance 3. november.'), 'Leverance 3. november.');
  assert.equal(tjek(kilde, 'Leverance 3. november 2026.'), `Leverance 3. november ${U}.`);
  assert.equal(tjek(kilde, 'Leverance 4. november.'), `Leverance ${U}. november.`);
});

test('fælde: klokkeslæt skrevet på flere måder', () => {
  assert.equal(tjek('Ring til Kim klokken otte.', 'Ring til Kim kl. 8.00.'), 'Ring til Kim kl. 8.00.');
  assert.equal(tjek('Ring til Kim klokken otte.', 'Ring til Kim kl. 08:00.'), 'Ring til Kim kl. 08:00.');
  assert.equal(tjek('Mødet er halv otte.', 'Møde kl. 7.30.'), 'Møde kl. 7.30.');
  assert.equal(tjek('Ring til Kim klokken otte.', 'Ring til Kim kl. 9.00.'), `Ring til Kim kl. ${U}.`);
});

test('fælde: mål med enheder og decimaler', () => {
  const kilde = 'Revnen er cirka 60 centimeter lang og en til to millimeter bred, og bjælken er 2,5 meter.';
  assert.equal(tjek(kilde, 'Revne på 60 cm, 1-2 mm bred. Bjælke 2,5 m.'), 'Revne på 60 cm, 1-2 mm bred. Bjælke 2,5 m.');
  assert.equal(tjek(kilde, 'Bjælke 2,6 m.'), `Bjælke ${U} m.`);
  // Omregnet enhed er ikke det, der blev sagt.
  assert.equal(tjek(kilde, 'Revne på 0,6 m.'), `Revne på ${U} m.`);
});

test('fælde: tusinder og beløb', () => {
  const kilde = 'Det koster femten hundrede kroner.';
  assert.equal(tjek(kilde, 'Pris 1.500 kr.'), 'Pris 1.500 kr.');
  assert.equal(tjek(kilde, 'Pris 1 500 kr.'), 'Pris 1 500 kr.');
  assert.equal(tjek(kilde, 'Pris 15.000 kr.'), `Pris ${U} kr.`);
});

test('fælde: en sum, modellen selv har lagt sammen, markeres', () => {
  assert.equal(tjek('To sække og tre sække.', 'I alt 5 sække (2 og 3).'), `I alt ${U} sække (2 og 3).`);
});

test('fælde: tal skrevet med bogstaver i referatet kontrolleres også', () => {
  assert.equal(tjek('Bestil fire sække.', 'Bestil fem sække.'), `Bestil ${U} sække.`);
  assert.equal(tjek('Bestil fire sække.', 'Bestil fire sække.'), 'Bestil fire sække.');
  // Ord, der kun ligner tal, røres ikke.
  assert.equal(tjek('Vi taler om det.', 'Vi talte om tilbuddet til den anden entreprenør.'), 'Vi talte om tilbuddet til den anden entreprenør.');
});

test('fælde: betegnelser med tal som lejlighed F 2.3 og CO2', () => {
  assert.equal(tjek('Døren i lejlighed F 2.3 skal flyttes. CO2 er vigtigt.', 'Dør i F 2.3 flyttes. CO2.'), 'Dør i F 2.3 flyttes. CO2.');
  assert.equal(tjek('Døren i lejlighed F to tre skal flyttes.', 'Dør i F 2.3 flyttes.'), 'Dør i F 2.3 flyttes.');
  assert.equal(tjek('Døren i lejlighed F 2.3 skal flyttes.', 'Dør i F 2.4 flyttes.'), `Dør i F ${U} flyttes.`);
});

// Hele referatet

test('alle felter kontrolleres, også opgaver, og antallet af rettelser tælles', () => {
  const kilde = 'Peter bestiller fire sække til fredag.';
  const { referat, rettet } = kontrollerTal({
    titel: 'Bestil 9 sække',
    opsummering: 'Peter bestiller 4 sække.',
    hovedpunkter: ['6 sække'],
    opgaver: [{ hvem: 'Peter', hvad: 'bestille 4 sække', hvornaar: 'fredag kl. 10' }],
    huskeliste: [],
    renTekst: '',
    type: 'moede',
    kort: false,
  }, kilde);
  assert.equal(referat.titel, `Bestil ${U} sække`);
  assert.equal(referat.opsummering, 'Peter bestiller 4 sække.');
  assert.deepEqual(referat.hovedpunkter, [`${U} sække`]);
  assert.deepEqual(referat.opgaver, [{ hvem: 'Peter', hvad: 'bestille 4 sække', hvornaar: `fredag kl. ${U}` }]);
  assert.equal(referat.type, 'moede');
  assert.equal(referat.kort, false);
  assert.equal(rettet, 3);
});

test('brugerens egen titel røres ikke, og dens tal tæller som sagt', () => {
  const { referat } = kontrollerTal(
    { titel: 'Byggemøde 7', opsummering: 'Byggemøde 7 på Nørrehus. Næste møde 8.' },
    'Ja, så er vi i gang på Nørrehus.',
    { brugerTitel: 'Byggemøde 7' },
  );
  assert.equal(referat.titel, 'Byggemøde 7');
  assert.equal(referat.opsummering, `Byggemøde 7 på Nørrehus. Næste møde ${U}.`);
});

test('intet tal i noget referat kan stå tilbage, uden at det blev sagt', () => {
  const kilde = 'Vi mødes den tredje klokken otte. Revnen er 60 centimeter. Fire sække. Tre meter, nej fire meter.';
  const opfundet = 'Den 3. kl. 8.00 og 9.15, revne 60 cm og 65 cm, 4 sække, 3 m, 4 m, 12 % og 1.250 kr. i 2026.';
  const ud = tjek(kilde, opfundet);
  const sagt = talIKilde(kilde);
  for (const c of cifre(ud)) {
    const dele = c.split(/[.,]/).map(Number);
    assert.ok(sagt.has(Number(c.replace(',', '.'))) || dele.every((d) => sagt.has(d)), `opfundet tal står tilbage: ${c}`);
  }
  for (const v of ['65', '12', '1.250', '2026', '9.15']) assert.ok(!ud.includes(v), v);
});

test('snes og dusin er tal', () => {
  const t = talIKilde('en snes plader og et dusin skruer');
  assert.ok(t.has(20));
  assert.ok(t.has(12));
});

test('fælde: et talord, der ikke er et gyldigt dansk tal, bliver [uklart] i referatet', () => {
  const kilde = 'Tagrenden er sænket nittenogtres millimeter, og der mangler niogfirs sten.';
  assert.equal(tjek(kilde, 'Sænket nittenogtres millimeter.'), `Sænket ${U} millimeter.`);
  assert.equal(tjek(kilde, 'Mangler niogfirs sten.'), 'Mangler niogfirs sten.');
  assert.equal(tjek(kilde, 'Sænket tolvogtyve millimeter.'), `Sænket ${U} millimeter.`);
});

// Fund fra gennemgangen

test('talord afsluttes ved tegnsætning og ved en ny størrelsesorden', () => {
  assert.equal(tjek('Vi har fem tusind. To tusind til stilladset.', '5.000 kr og 2.000 kr.'), '5.000 kr og 2.000 kr.');
  assert.equal(tjek('Vi har fem tusind. To tusind til stilladset.', 'I alt 7.000 kr.'), `I alt ${U} kr.`);
  assert.equal(tjek('fem hundrede, tre hundrede', '500 og 300'), '500 og 300');
  assert.equal(tjek('to hundrede og to hundrede', '200 og 200, ikke 20200'), `200 og 200, ikke ${U}`);
  assert.equal(tjek('fem tusind to tusind', '5000 og 2000, ikke 7000'), `5000 og 2000, ikke ${U}`);
});

test('talord med hundrede og tusind i referatet kontrolleres som hele tal', () => {
  assert.equal(tjek('Det koster fem hundrede kroner.', 'Det koster fem tusind kroner.'), `Det koster ${U} kroner.`);
  assert.equal(tjek('Det koster fem hundrede kroner.', 'Det koster fem millioner kroner.'), `Det koster ${U} kroner.`);
  assert.equal(tjek('tre hundrede og to sten', 'to hundrede sten'), `${U} sten`);
  assert.equal(tjek('tre hundrede og to sten', 'tre hundrede og to sten'), 'tre hundrede og to sten');
});

test('enheder med eksponent og CO2 er ikke tal', () => {
  assert.equal(tjek('tolv kvadratmeter og fem kubikmeter CO to', '12 m2 og 5 m3 CO2, 12 cm2'), '12 m2 og 5 m3 CO2, 12 cm2');
  // Et tal med bogstaver foran, som ikke er en enhed, er stadig et tal.
  assert.equal(tjek('opgang tolv', 'Opgang B13'), `Opgang B${U}`);
});

test('målestok som 1:100', () => {
  assert.equal(tjek('tegningen er i en til hundrede', 'Tegning i 1:100'), 'Tegning i 1:100');
  assert.equal(tjek('tegningen er i en til hundrede', 'Tegning i 1:50'), `Tegning i ${U}`);
});

test('årstal sagt i par og datoer med måned som tal', () => {
  assert.equal(tjek('det var i tyve seksogtyve', 'I 2026.'), 'I 2026.');
  assert.equal(tjek('bygget i nitten seksoghalvfems', 'Bygget 1996.'), 'Bygget 1996.');
  assert.equal(tjek('den tredje november', 'Den 3/11 og 3.11.'), 'Den 3/11 og 3.11.');
  assert.equal(tjek('den tredje november', 'Den 3/12.'), `Den 3/${U}.`);
});

test('klokkeslæt efter middag og halve timer', () => {
  assert.equal(tjek('vi mødes halv tre', 'Møde kl. 14.30.'), 'Møde kl. 14.30.');
  assert.equal(tjek('vi mødes klokken to', 'Møde kl. 14.00.'), 'Møde kl. 14.00.');
  assert.equal(tjek('vi mødes halv et', 'Møde kl. 12.30.'), 'Møde kl. 12.30.');
  assert.equal(tjek('vi mødes kvart i en', 'Møde kl. 12.45.'), 'Møde kl. 12.45.');
  // "halv tre" er 2.30, ikke 2.50.
  assert.equal(tjek('vi mødes halv tre', 'Møde kl. 2.50.'), `Møde kl. ${U}.`);
});

test('telefonnumre med og uden mellemrum er det samme tal', () => {
  assert.equal(tjek('Ring på 12 34 56 78.', 'Tlf. 12345678.'), 'Tlf. 12345678.');
  assert.equal(tjek('Ring på 12345678.', 'Tlf. 12 34 56 78.'), 'Tlf. 12 34 56 78.');
  assert.equal(tjek('Ring på 12 34 56 78.', 'Tlf. 12345679.'), `Tlf. ${U}.`);
});
