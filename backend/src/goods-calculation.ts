import Decimal from 'decimal.js';
import { BadRequestException } from '@nestjs/common';
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type GoodsLineInput = {
  productId: string;
  direction: 'entry' | 'exit';
  quantity: string;
  unitCost: string;
  discountPercent: string;
  taxRate: '0' | '8' | '16';
};
const maxAmount = new Decimal('999999999999999999999999.999999');
export function amount(value: Decimal) {
  if (!value.isFinite() || value.abs().gt(maxAmount))
    throw new BadRequestException('El importe supera el límite admitido');
  return value.toFixed(6);
}
export function calculateGoods(kind: 'adjustment' | 'purchase', lines: GoodsLineInput[]) {
  const details = lines.map((line) => {
    const gross = new Decimal(line.quantity).mul(line.unitCost).toDecimalPlaces(2);
    const discount = gross.mul(line.discountPercent).div(100).toDecimalPlaces(2);
    const base = gross.minus(discount);
    const tax = base.mul(line.taxRate).div(100).toDecimalPlaces(2);
    return {
      ...line,
      gross: amount(gross),
      discountAmount: amount(discount),
      taxableBase: amount(base),
      taxAmount: amount(tax),
      total: amount(base.plus(tax)),
    };
  });
  const sum = (field: 'gross' | 'discountAmount' | 'taxAmount' | 'total') =>
    amount(
      details.reduce(
        (s, line) =>
          s.plus(
            new Decimal(line[field]).mul(
              kind === 'adjustment' && line.direction === 'exit' ? -1 : 1,
            ),
          ),
        new Decimal(0),
      ),
    );
  return {
    lines: details,
    subtotal: sum('gross'),
    discountTotal: sum('discountAmount'),
    taxTotal: sum('taxAmount'),
    total: sum('total'),
  };
}
