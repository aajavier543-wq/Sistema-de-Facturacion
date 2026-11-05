import type { GeminiDocument } from '../src/gemini-document';
import { deliveryRows, deliveryText } from './invoice-fixture';
export function geminiDelivery(): GeminiDocument {
  return {
    documentType: 'delivery_note',
    issuerName: 'VIPSalud',
    issuerRif: 'J-50270625-9',
    documentNumber: '0000-1197',
    controlNumber: null,
    documentDate: '2026-11-03',
    dueDate: '2026-11-10',
    paymentTerms: 'credit',
    currency: 'USD',
    exchangeRateRaw: null,
    declaredTotalRaw: '3,098.00',
    declaredQuantityRaw: '26,420',
    text: deliveryText,
    warnings: [],
    lines: deliveryRows.map((r) => ({
      sourceCode: r[0]!,
      name: r[1]!,
      lot: r[2]!,
      expiry: r[3]!,
      unit: r[4]!,
      quantityRaw: r[5]!,
      unitCostRaw: r[6]!,
      printedTotalRaw: r[7]!,
      discountPercentRaw: null,
      taxRate: 'unknown',
      printedTotalBasis: 'net',
    })),
  };
}
