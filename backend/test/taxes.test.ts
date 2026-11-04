import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateQuote } from '../src/taxes';
test('IVA por categoría y sin errores binarios', () => {
  const q = calculateQuote(
    [
      { quantity: '1', priceUsd: '10', taxCategory: 'general' },
      { quantity: '1', priceUsd: '10', taxCategory: 'reduced' },
      { quantity: '1', priceUsd: '10', taxCategory: 'exempt' },
    ],
    '40',
    [],
  );
  assert.deepEqual(
    q.lines.map((l) => l.vat),
    ['64.00', '32.00', '0.00'],
  );
  assert.equal(q.purchaseTotalBase, '1296.00');
  assert.equal(q.remainingPrincipalBase, '1296.00');
});
test('IGTF solo sobre principal elegible: 40 + 60, impuesto 1.80 USD', () => {
  const q = calculateQuote([{ quantity: '1', priceUsd: '100', taxCategory: 'exempt' }], '40', [
    { principalUsd: '40', eligibleForIgtf: false },
    { principalUsd: '60', eligibleForIgtf: true },
  ]);
  assert.equal(q.igtfTotalBase, '72.00');
  assert.equal(q.dueTotalBase, '4072.00');
  assert.equal(q.remainingPrincipalBase, '0.00');
});
test('cálculo decimal exacto y rechazo de sobrepago y tasa cero', () => {
  assert.equal(
    calculateQuote([{ quantity: '3', priceUsd: '0.1', taxCategory: 'exempt' }], '1', [])
      .purchaseTotalBase,
    '0.30',
  );
  assert.throws(
    () =>
      calculateQuote([{ quantity: '1', priceUsd: '1', taxCategory: 'exempt' }], '1', [
        { principalUsd: '2', eligibleForIgtf: false },
      ]),
    /excede/,
  );
  assert.throws(() => calculateQuote([], '0', []), /mayor/);
});
