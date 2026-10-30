import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS, efterGenstart } from '../js/tilstand.js';

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
