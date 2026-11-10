import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS, OPBEVARING_MS, efterGenstart, slettesOm } from '../js/tilstand.js';

test('optager bliver gemt og afbrudt efter genstart', () => {
  assert.deepEqual(efterGenstart({ id: 'a', status: STATUS.OPTAGER }), { id: 'a', status: STATUS.GEMT, afbrudt: true });
});

test('sender bliver netfejl efter genstart', () => {
  assert.deepEqual(efterGenstart({ id: 'a', status: STATUS.SENDER }), { id: 'a', status: STATUS.FEJL, fejlType: 'net' });
});

test('sender-mail bliver tekst-klar med advarsel efter genstart', () => {
  assert.deepEqual(
    efterGenstart({ id: 'a', status: STATUS.SENDER_MAIL, tekst: 'x' }),
    { id: 'a', status: STATUS.TEKST_KLAR, tekst: 'x', maaskeSendt: true },
  );
});

for (const status of [STATUS.GEMT, STATUS.TEKST_KLAR, STATUS.FEJL]) {
  test(`${status} er uændret efter genstart`, () => {
    const note = { id: 'a', status };
    assert.deepEqual(efterGenstart(note), note);
  });
}

const DAG = 24 * 60 * 60 * 1000;
const NU = Date.UTC(2026, 10, 3, 12);

test('opbevaring er 7 dage', () => {
  assert.equal(OPBEVARING_MS, 7 * DAG);
});

test('slettesOm tæller hele dage tilbage og er null for ikke-sendte', () => {
  const sendt = (siden) => ({ status: STATUS.SENDT, sendt: NU - siden });
  assert.equal(slettesOm(sendt(0), NU), 7);
  assert.equal(slettesOm(sendt(2 * DAG), NU), 5);
  assert.equal(slettesOm(sendt(6.5 * DAG), NU), 1);
  assert.equal(slettesOm(sendt(7 * DAG), NU), 0);
  assert.equal(slettesOm(sendt(30 * DAG), NU), 0);
  for (const status of [STATUS.GEMT, STATUS.FEJL, STATUS.TEKST_KLAR, STATUS.OPTAGER]) {
    assert.equal(slettesOm({ status, sendt: NU }, NU), null, status);
  }
  assert.equal(slettesOm({ status: STATUS.SENDT }, NU), null);
});

test('sendt er uændret efter genstart', () => {
  const note = { id: 'a', status: STATUS.SENDT, sendt: 1 };
  assert.deepEqual(efterGenstart(note), note);
});
