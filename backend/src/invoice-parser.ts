import Decimal from 'decimal.js';
export type InvoiceReading = {
  supplierName: string | null;
  supplierRif: string | null;
  invoiceNumber: string | null;
  controlNumber: string | null;
  documentDate: string | null;
  currency: 'VES' | 'USD';
  exchangeRate: string | null;
  declaredTotal: string | null;
  warnings: string[];
  lines: {
    name: string;
    quantity: string | null;
    unitCost: string | null;
    discountPercent: string;
    taxRate: '0' | '8' | '16' | null;
    printedTotal: string | null;
  }[];
};
const moneyPattern = '[0-9]+(?:[. ][0-9]{3})*[,.][0-9]{2}';
export function readNumber(input: string): string | null {
  let s = input.replace(/\s/g, '');
  const comma = s.lastIndexOf(','),
    dot = s.lastIndexOf('.');
  if (comma >= 0 && comma > dot) s = s.replace(/\./g, '').replace(',', '.');
  else if (comma >= 0 && dot > comma) s = s.replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,10})?$/.test(s)) return null;
  try {
    return new Decimal(s).toString();
  } catch {
    return null;
  }
}
export function parseInvoiceText(raw: string, headerText = raw): InvoiceReading {
  const text = raw
    .slice(0, 50000)
    .replace(/\r/g, '')
    .replace(/[\t\u00a0]/g, ' ');
  const fold = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase();
  const all = fold(text),
    header = fold(headerText);
  const warnings: string[] = [];
  const rifs = (s: string) =>
    [...s.matchAll(/\b([JVEGP])[-\s]*(\d{8})[-\s]*(\d)\b/g)].map((m) => m[1]! + m[2]! + m[3]!);
  const topRifs = [...new Set(rifs(header))],
    fullRifs = [...new Set(rifs(all))];
  const supplierRif =
    topRifs.length === 1 ? topRifs[0]! : fullRifs.length === 1 ? fullRifs[0]! : null;
  if (!supplierRif) warnings.push('Revisa el RIF del proveedor: no se identificó de forma única.');
  const headerLines = headerText
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const nameIndex = headerLines.findIndex((s) =>
    /DROGUER[IÍ]A|DISTRIBUIDORA|LABORATORIOS?|\b[CS]\.?\s*A\.?(?:\s|$)/i.test(s),
  );
  let supplierName = nameIndex >= 0 ? headerLines[nameIndex]! : null;
  if (
    supplierName &&
    /^(DROGUER[IÍ]A|DISTRIBUIDORA|LABORATORIOS?)$/i.test(supplierName) &&
    headerLines[nameIndex + 1]
  )
    supplierName += ' ' + headerLines[nameIndex + 1];
  // Degree signs often become '?*' or '*' in a photograph; consume only the label.
  const no = all.match(/FACTURA\s*(?:N(?:RO)?[°ºO.?*]*\s*)?[:#]?\s*([A-Z0-9][A-Z0-9-]*)/);
  const invoiceNumber = no && /\d/.test(no[1]!) ? no[1]! : null;
  const control =
    all.match(/(?:N[°ºO.]?\s*(?:DE\s*)?)?CONTROL\s*[:#]?\s*([0-9][0-9-]+)/)?.[1] ?? null;
  const date = all.match(/FECHA\s*[:.]?\s*(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  const documentDate = date
    ? `${date[3]}-${date[2]!.padStart(2, '0')}-${date[1]!.padStart(2, '0')}`
    : null;
  const totalMatch = all.match(
    new RegExp(
      '(?:^|\\n)\\s*TOTAL(?:\\s+A\\s+PAGAR|\\s+FACTURA)?\\s*[:.]?\\s*(?:BS[. ]*)?(' +
        moneyPattern +
        ')',
      'm',
    ),
  );
  const declaredTotal = totalMatch ? readNumber(totalMatch[1]!) : null;
  const exempt = all.match(new RegExp('TOTAL\\s+EXENTO\\s*[:.]?\\s*(' + moneyPattern + ')'));
  const exemptTotal = exempt ? readNumber(exempt[1]!) : null;
  const allExempt =
    declaredTotal !== null &&
    exemptTotal !== null &&
    new Decimal(declaredTotal).equals(exemptTotal);
  const currency = /(?:MONEDA|CURRENCY)\s*[:.]?\s*(?:USD|DOLAR)/.test(all) ? 'USD' : 'VES';
  let exchangeRate: string | null = currency === 'VES' ? '1' : null;
  if (currency === 'USD') {
    const fx = all.match(
      /TASA(?:\s+(?:SEGUN|BCV|DE|CAMBIO|B\.C\.V\.?))*\s*[:.]?\s*\n?\s*(\d+[.,]\d{1,10})/,
    );
    exchangeRate = fx ? readNumber(fx[1]!) : null;
  }
  const row = new RegExp(
    '^\\s*(\\d+(?:[.,]\\d{1,6})?)\\s+(.+?)\\s+(' +
      moneyPattern +
      ')\\s+(' +
      moneyPattern +
      ')\\s*$',
  );
  const rowWithoutAmounts = /^\s*(\d+[.,]\d{2})\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9 /%()+.,-]{4,})\s*$/i;
  const amountPair = new RegExp('^\\s*(' + moneyPattern + ')\\s+(' + moneyPattern + ')\\s*$');
  const lines: InvoiceReading['lines'] = [];
  let pending: { name: string; quantity: string } | null = null;
  for (const original of text.split('\n')) {
    const value = original.trim();
    const upper = fold(value);
    if (/^(SUB[- ]?TOTAL|TOTAL EXENTO|BASE IMPONIBLE|TASA|I\.?V\.?A|N[°º]?.*CONTROL)/.test(upper)) {
      if (pending) {
        lines.push({
          ...pending,
          unitCost: null,
          printedTotal: null,
          discountPercent: '0',
          taxRate: allExempt ? '0' : null,
        });
        pending = null;
      }
      continue;
    }
    const match = value.match(row);
    if (match && /[A-ZÁÉÍÓÚÑ]/i.test(match[2]!)) {
      if (pending)
        lines.push({
          ...pending,
          unitCost: null,
          printedTotal: null,
          discountPercent: '0',
          taxRate: allExempt ? '0' : null,
        });
      lines.push({
        name: match[2]!.replace(/\s+/g, ' ').trim(),
        quantity: readNumber(match[1]!),
        unitCost: readNumber(match[3]!),
        printedTotal: readNumber(match[4]!),
        discountPercent: '0',
        taxRate: allExempt ? '0' : null,
      });
      pending = null;
      continue;
    }
    const pair = value.match(amountPair);
    if (pair && pending) {
      lines.push({
        ...pending,
        unitCost: readNumber(pair[1]!),
        printedTotal: readNumber(pair[2]!),
        discountPercent: '0',
        taxRate: allExempt ? '0' : null,
      });
      pending = null;
      continue;
    }
    const partial = value.match(rowWithoutAmounts);
    if (partial && !/FECHA|TELEFONO|RIF|FACTURA|SICM|TOTAL/.test(upper)) {
      if (pending)
        lines.push({
          ...pending,
          unitCost: null,
          printedTotal: null,
          discountPercent: '0',
          taxRate: allExempt ? '0' : null,
        });
      pending = {
        name: partial[2]!.replace(/\s+/g, ' ').trim(),
        quantity: readNumber(partial[1]!) ?? '',
      };
    }
  }
  if (pending)
    lines.push({
      ...pending,
      unitCost: null,
      printedTotal: null,
      discountPercent: '0',
      taxRate: allExempt ? '0' : null,
    });
  const capped = lines.slice(0, 100);
  if (!capped.length)
    warnings.push(
      'No se reconocieron renglones completos. Puedes transcribirlos o añadirlos en la revisión.',
    );
  if (capped.some((l) => l.unitCost === null || l.quantity === null || l.taxRate === null))
    warnings.push('Hay cantidades, costos o IVA pendientes de revisión.');
  if (!declaredTotal) warnings.push('No se pudo leer el total de la factura.');
  if (!invoiceNumber || !control || !documentDate)
    warnings.push('Revisa número de factura, control y fecha; faltan datos de encabezado.');
  if (declaredTotal && capped.length && capped.every((l) => l.printedTotal !== null)) {
    const sum = capped.reduce((s, l) => s.plus(l.printedTotal!), new Decimal(0));
    if (!sum.eq(declaredTotal))
      warnings.push('La suma de los renglones no coincide con el total impreso.');
  }
  return {
    supplierName,
    supplierRif,
    invoiceNumber,
    controlNumber: control,
    documentDate,
    currency,
    exchangeRate,
    declaredTotal,
    warnings,
    lines: capped,
  };
}
