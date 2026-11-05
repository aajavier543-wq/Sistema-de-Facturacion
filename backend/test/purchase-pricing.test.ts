import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePurchasePrice, pricingSchema } from '../src/purchase-pricing';
import { randomUUID } from 'node:crypto';
test('la ganancia se calcula sobre costo neto y el IVA se añade sobre venta, sin convertirse en ganancia', () => {
  const line = { quantity: '2', taxable_base: '180', tax_rate: '16' };
  const p = calculatePurchasePrice(line, 'VES', '1', '30');
  assert.equal(p.netCost, '90.000000');
  assert.equal(p.salePriceUsd, '117.000000');
  assert.equal(p.saleTaxUsd, '18.72');
  assert.equal(p.saleTotalUsd, '135.72');
  const exempt = calculatePurchasePrice({ ...line, tax_rate: '0' }, 'VES', '1', '30');
  assert.equal(exempt.saleTotalUsd, '117.00');
  const reduced = calculatePurchasePrice({ ...line, tax_rate: '8' }, 'VES', '1', '30');
  assert.equal(reduced.saleTotalUsd, '126.36');
  const usd = calculatePurchasePrice(line, 'USD', '40', '30');
  assert.equal(usd.salePriceUsd, '117.000000');
  const converted = calculatePurchasePrice({ ...line, taxable_base: '7200' }, 'VES', '40', '30');
  assert.equal(converted.salePriceUsd, '117.000000');
});
test('respeta el descuento redondeado de la factura y los seis decimales del catálogo', () => {
  const p = calculatePurchasePrice(
    { quantity: '3', taxable_base: '0.75', tax_rate: '16' },
    'USD',
    '40',
    '30',
  );
  assert.equal(p.netCost, '0.250000');
  assert.equal(p.salePriceUsd, '0.325000');
  assert.equal(
    calculatePurchasePrice({ quantity: '1', taxable_base: '0', tax_rate: '0' }, 'VES', '40', '30')
      .keepCurrentPrice,
    true,
  );
  assert.throws(() =>
    calculatePurchasePrice(
      { quantity: '1', taxable_base: '99999999999999999999', tax_rate: '16' },
      'USD',
      '1',
      '1000',
    ),
  );
});
test('valida porcentajes, tasa, duplicados y campos de precios no autorizados', () => {
  const line = { lineId: randomUUID(), profitPercent: '30', expectedProductVersion: 0 };
  const input = { expectedVersion: 0, idempotencyKey: randomUUID(), rate: '40', lines: [line] };
  assert.equal(pricingSchema.safeParse(input).success, true);
  for (const bad of [
    { ...input, rate: '0' },
    { ...input, rate: 'Infinity' },
    { ...input, rate: 'no es numero' },
    { ...input, lines: [{ ...line, profitPercent: 'abc' }] },
    { ...input, lines: [line, line] },
    { ...input, lines: [{ ...line, profitPercent: '-1' }] },
    { ...input, lines: [{ ...line, profitPercent: '1000.0001' }] },
    { ...input, lines: [{ ...line, salePriceUsd: '1' }] },
  ])
    assert.equal(pricingSchema.safeParse(bad).success, false);
});
