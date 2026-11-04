import Decimal from 'decimal.js';
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type QuoteLine = {
  quantity: string;
  priceUsd: string;
  taxCategory: 'general' | 'reduced' | 'exempt';
};
export type QuotePayment = { principalUsd: string; eligibleForIgtf: boolean };
const VAT = { general: '0.16', reduced: '0.08', exempt: '0' };
export function calculateQuote(lines: QuoteLine[], rate: string, payments: QuotePayment[]) {
  const fx = new Decimal(rate);
  if (!fx.isFinite() || fx.lte(0)) throw new Error('La tasa debe ser mayor que cero');
  const details = lines.map((line) => {
    const base = new Decimal(line.priceUsd).mul(line.quantity).mul(fx).toDecimalPlaces(2);
    const vat = base.mul(VAT[line.taxCategory]).toDecimalPlaces(2);
    return { base: base.toFixed(2), vat: vat.toFixed(2), total: base.plus(vat).toFixed(2) };
  });
  const total = details.reduce((sum, line) => sum.plus(line.total), new Decimal(0));
  const applied = payments.map((p) => {
    const principal = new Decimal(p.principalUsd).mul(fx).toDecimalPlaces(2);
    const tax = p.eligibleForIgtf ? principal.mul('0.03').toDecimalPlaces(2) : new Decimal(0);
    return {
      principal: principal.toFixed(2),
      igtf: tax.toFixed(2),
      due: principal.plus(tax).toFixed(2),
    };
  });
  const principal = applied.reduce((sum, p) => sum.plus(p.principal), new Decimal(0));
  const igtf = applied.reduce((sum, p) => sum.plus(p.igtf), new Decimal(0));
  if (principal.gt(total))
    throw new Error('El principal aplicado excede la compra; el vuelto aún no está implementado');
  return {
    simulation: true,
    fiscalDocument: false,
    policy: 'SIMULATION-VE-IVA16-8-IGTF3-v1',
    note: 'Tasa manual y elegibilidad declarada: no valida aplicabilidad tributaria ni consulta el BCV.',
    rate: fx.toFixed(6),
    lines: details,
    purchaseTotalBase: total.toFixed(2),
    purchaseTotalUsd: total.div(fx).toFixed(2),
    payments: applied,
    igtfTotalBase: igtf.toFixed(2),
    dueTotalBase: total.plus(igtf).toFixed(2),
    remainingPrincipalBase: total.minus(principal).toFixed(2),
  };
}
