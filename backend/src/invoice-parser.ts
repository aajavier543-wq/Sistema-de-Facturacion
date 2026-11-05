import Decimal from 'decimal.js';
import { numberCandidates, readNumber, reconcileRow } from './document-numbers';
import { fold, parseLayoutTable, type OcrWord, type LayoutLine } from './document-layout';
export { readNumber } from './document-numbers';
export type InvoiceReading = {
  documentType: 'invoice' | 'delivery_note' | 'unknown';
  supplierName: string | null;
  supplierRif: string | null;
  invoiceNumber: string | null;
  controlNumber: string | null;
  documentDate: string | null;
  dueDate: string | null;
  paymentTerms: 'cash' | 'credit';
  currency: 'VES' | 'USD';
  exchangeRate: string | null;
  declaredTotal: string | null;
  declaredQuantity: string | null;
  warnings: string[];
  lines: LayoutLine[];
};
const amountToken = '[0-9]+(?:[.,][0-9]+)*';
function labelledAmount(lines: string[], label: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    const line = fold(lines[i]!);
    const found = line.match(label);
    if (!found) continue;
    const value = line
      .slice((found.index ?? 0) + found[0].length)
      .replace(/^\s*[:=]\s*/, '')
      .replace(/^(?:BS\.?|USD|US\$|\$)\s*/, '')
      .trim();
    const match = value.match(/(\d[\d., ]*)\s*(?:BS\.?|USD|US\$|\$)?$/);
    if (match) {
      const n = readNumber(match[1]!.trim());
      if (n !== null) return n;
    }
    const next = lines[i + 1]?.trim();
    if (!value && next && /^\d[\d., ]*$/.test(next)) return readNumber(next);
  }
  return null;
}
function labelledDate(all: string, label: string): string | null {
  const match = all.match(
    new RegExp('(?:' + label + ')\\s*[:.]?\\s*(\\d{1,2})[/-](\\d{1,2})[/-](\\d{4})'),
  );
  if (!match) return null;
  const value = `${match[3]}-${match[2]!.padStart(2, '0')}-${match[1]!.padStart(2, '0')}`;
  const date = new Date(value + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? value
    : null;
}
function parseTextRows(text: string, allExempt: boolean): LayoutLine[] {
  const lines: LayoutLine[] = [];
  let pending: { name: string; quantity: string } | null = null;
  const row = new RegExp(
    '^\\s*(' + amountToken + ')\\s+(.+?)\\s+(' + amountToken + ')\\s+(' + amountToken + ')\\s*$',
  );
  const suffix = new RegExp(
    '^\\s*(.+?)\\s+(' + amountToken + ')\\s+(' + amountToken + ')\\s+(' + amountToken + ')\\s*$',
  );
  const pair = new RegExp('^\\s*(' + amountToken + ')\\s+(' + amountToken + ')\\s*$');
  let sawTable = false;
  const pushPending = () => {
    if (pending) {
      lines.push({
        ...pending,
        unitCost: null,
        printedTotal: null,
        discountPercent: '0',
        taxRate: allExempt ? '0' : null,
        needsReview: true,
      });
      pending = null;
    }
  };
  for (const original of text.split('\n')) {
    const value = original.trim(),
      upper = fold(value);
    if (
      /(?:DESCRIPCION|NOMBRE DEL ARTICULO|CONCEPTO|PRODUCTO).*?(?:PRECIO|COSTO|CANT|TOTAL)|CANTIDAD.*DESCRIPCION/.test(
        upper,
      )
    ) {
      sawTable = true;
      continue;
    }
    if (
      /^(SUB[- ]?TOTAL|TOTAL\b|BASE IMPONIBLE|TASA|I\.?V\.?A|N[°º]?.*CONTROL|SIN DERECHO|RECIBI CONFORME)/.test(
        upper,
      )
    ) {
      pushPending();
      continue;
    }
    // Quantity-first documents, including the original invoice format.
    const match = value.match(row);
    if (
      match &&
      /[A-ZÁÉÍÓÚÑ]/i.test(match[2]!) &&
      !/^(?:FECHA|TELEFONO|RIF|FACTURA|SICM)\b/.test(upper)
    ) {
      const calculated = reconcileRow(match[1]!, match[3]!, match[4]!);
      pushPending();
      lines.push({
        name: match[2]!.replace(/\s+/g, ' ').trim(),
        ...calculated,
        discountPercent: '0',
        taxRate: allExempt ? '0' : null,
        needsReview: calculated.ambiguous,
      });
      continue;
    }
    // Name/code-first tables: identify the quantity, unit cost and amount from the right,
    // then remove explicitly identifiable unit, expiry and lot metadata from the prefix.
    const tail = sawTable ? value.match(suffix) : null;
    if (tail && /[A-ZÁÉÍÓÚÑ]/i.test(tail[1]!)) {
      const calculated = reconcileRow(tail[2]!, tail[3]!, tail[4]!);
      let name = tail[1]!,
        sourceCode: string | undefined,
        lot: string | undefined,
        expiry: string | undefined,
        unit: string | undefined;
      const code = name.match(/^([A-Z0-9][A-Z0-9._/-]*\d[A-Z0-9._/-]*|\d[A-Z0-9._/-]*)\s+(.+)$/i);
      if (code) {
        sourceCode = code[1];
        name = code[2]!;
      }
      const metadata = name.match(
        /\s+([A-Z0-9./-]+)\s+(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4})\s+(UND?|UNI|UNID|PZA|PCS?|KG|GR|ML|LT|CAJ|TAB|CAP)\s*$/i,
      );
      if (metadata) {
        lot = metadata[1];
        expiry = metadata[2];
        unit = metadata[3];
        name = name.slice(0, metadata.index).trim();
      } else {
        name = name.replace(
          /\s+(UND?|UNI|UNID|PZA|PCS?|KG|GR|ML|LT|CAJ|TAB|CAP)\s*$/i,
          (_, u: string) => {
            unit = u;
            return '';
          },
        );
      }
      pushPending();
      lines.push({
        name,
        ...calculated,
        discountPercent: '0',
        taxRate: allExempt ? '0' : null,
        sourceCode,
        lot,
        expiry,
        unit,
        needsReview: calculated.ambiguous,
      });
      continue;
    }
    const amounts = value.match(pair);
    if (amounts && pending) {
      const calculated = reconcileRow(pending.quantity, amounts[1]!, amounts[2]!);
      lines.push({
        name: pending.name,
        ...calculated,
        discountPercent: '0',
        taxRate: allExempt ? '0' : null,
        needsReview: calculated.ambiguous,
      });
      pending = null;
      continue;
    }
    const partial = value.match(
      /^\s*(\d+[.,]\d{2,6})\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9 /%()+.,-]{4,})\s*$/i,
    );
    if (partial && !/FECHA|TELEFONO|RIF|FACTURA|SICM|TOTAL/.test(upper)) {
      pushPending();
      pending = {
        name: partial[2]!.replace(/\s+/g, ' ').trim(),
        quantity: numberCandidates(partial[1]!).length === 1 ? readNumber(partial[1]!)! : '',
      };
    }
  }
  pushPending();
  return lines.slice(0, 100);
}
export function readingScore(d: InvoiceReading): number {
  const complete = d.lines.filter(
    (l) => l.quantity !== null && l.unitCost !== null && l.printedTotal !== null && !l.needsReview,
  ).length;
  const sum =
    d.lines.length && d.lines.every((l) => l.printedTotal !== null)
      ? d.lines.reduce((s, l) => s.plus(l.printedTotal!), new Decimal(0))
      : null;
  return (
    complete * 12 +
    d.lines.length * 2 +
    (d.declaredTotal !== null && sum?.eq(d.declaredTotal) ? 30 : 0) +
    [d.supplierName, d.supplierRif, d.invoiceNumber, d.documentDate, d.declaredTotal].filter(
      Boolean,
    ).length *
      3
  );
}
export function parseInvoiceText(
  raw: string,
  headerText = raw,
  words: OcrWord[] = [],
): InvoiceReading {
  const text = raw
      .slice(0, 50000)
      .replace(/\r/g, '')
      .replace(/[\t\u00a0]/g, ' '),
    all = fold(text),
    warnings: string[] = [];
  const rows = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const delivery = all.match(
    /\bNOTA\s+(?:DE\s+)?ENTREGA\s*(?:N(?:RO)?[°ºO.?*]*\s*)?[:#]?\s*([A-Z0-9][A-Z0-9-]*\d[A-Z0-9-]*|\d[A-Z0-9-]*)/,
  );
  const invoice = all.match(/\bFACTURA\b\s*(?:N(?:RO)?[°ºO.?*]*\s*)?[:#]?\s*([A-Z0-9][A-Z0-9-]*)/);
  const documentType = delivery
    ? 'delivery_note'
    : invoice && /\d/.test(invoice[1]!)
      ? 'invoice'
      : 'unknown';
  const invoiceNumber = delivery?.[1] ?? (invoice && /\d/.test(invoice[1]!) ? invoice[1]! : null);
  if (documentType === 'delivery_note')
    warnings.push(
      'Se reconoció una nota de entrega. Se registrará como recepción no fiscal, sin inventar número de control ni crédito fiscal.',
    );
  if (documentType === 'unknown')
    warnings.push(
      'Selecciona el tipo de documento; no se reconoció con certeza factura o nota de entrega.',
    );
  const control =
    all.match(/(?:N[°ºO.]?\s*(?:DE\s*)?)?CONTROL\s*[:#]?\s*([0-9][0-9-]+)/)?.[1] ?? null;
  const documentDate =
    labelledDate(all, 'FECHA(?:\\s+DE)?(?:\\s+EMISION)?') ?? labelledDate(all, 'EMISION');
  const dueDate = labelledDate(all, 'FECHA(?:\\s+DE)?\\s+VENCIMIENTO|VENCIMIENTO|VENCE EL');
  const paymentTerms =
    /(?:CONDICION(?:ES)?(?:\s+DE)?\s+PAGO|FORMA\s+DE\s+PAGO)\s*:?\s*CREDITO|\bCREDITO\s+(?:A\s+)?\d+\s+DIAS/.test(
      all,
    )
      ? 'credit'
      : 'cash';
  // Restrict issuer identity to the area before recipient labels; never choose a customer's RIF.
  const recipient =
    /\b(?:RAZON SOCIAL|CLIENTE\s*:|DATOS DEL CLIENTE|DESTINATARIO|FACTURAR A|SENORES)\b/i;
  const issuerText = recipient.test(fold(headerText))
    ? headerText.slice(0, fold(headerText).search(recipient))
    : headerText;
  const fullIssuer = recipient.test(all) ? text.slice(0, all.search(recipient)) : text;
  const rifs = (s: string) =>
    [...fold(s).matchAll(/\b([JVEGP])[-\s]*(\d{8})[-\s]*(\d)\b/g)].map(
      (m) => m[1]! + m[2]! + m[3]!,
    );
  const candidates = [...new Set(rifs(issuerText))],
    fallback = [...new Set(rifs(fullIssuer))];
  const supplierRif =
    candidates.length === 1 ? candidates[0]! : fallback.length === 1 ? fallback[0]! : null;
  if (!supplierRif) warnings.push('Revisa el RIF del emisor: no se identificó de forma única.');
  const issuerLines = fullIssuer
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const corporate = issuerLines.find(
    (s) =>
      /DROGUER[IÍ]A|DISTRIBUIDORA|LABORATORIOS?|\b[CS]\.?\s*A\.?(?:\s|$)/i.test(s) &&
      !/^RAZON/i.test(s),
  );
  const brand = issuerLines.find(
    (s) =>
      /[A-ZÁÉÍÓÚÑ]{3}/i.test(s) &&
      s.length >= 4 &&
      !/FACTURA|ENTREGA|FECHA|RIF|DIRECCION|TELEFONO|SISTEMA|NEXO|IMPORTAR|GUARDAR|PRECIO|CANTIDAD|CODIGO|TOTAL|CLIENTE/i.test(
        s,
      ) &&
      !rifs(s).length,
  );
  let supplierName = corporate ?? brand ?? null;
  if (supplierName && /^(DROGUER[IÍ]A|DISTRIBUIDORA|LABORATORIOS?)$/i.test(supplierName)) {
    const i = issuerLines.indexOf(supplierName);
    if (issuerLines[i + 1]) supplierName += ' ' + issuerLines[i + 1];
  }
  const declaredTotal =
    labelledAmount(rows, /(?:^|\s)TOTAL\s+(?:GENERAL|A\s+PAGAR|FACTURA)\b\s*[:.]?\s*/i) ??
    labelledAmount(rows, /^TOTAL\s*[:.]?\s*(?=\d|BS\b|USD\b|\$|$)/i);
  const exemptTotal = labelledAmount(rows, /^TOTAL\s+EXENTO\b\s*[:.]?\s*/i);
  const allExempt =
    declaredTotal !== null && exemptTotal !== null && new Decimal(declaredTotal).eq(exemptTotal);
  const dollar =
    /(?:MONEDA|CURRENCY)\s*[:.]?\s*(?:USD|DOLAR)|(?:EXPRESAD[AO]S?|EN|MONEDA)\s+(?:EN\s+)?DOLARES?(?:\s+AMERICANOS)?|\bUSD\b|US\$/.test(
      all,
    );
  const currency = dollar ? 'USD' : 'VES';
  let exchangeRate: string | null = currency === 'VES' ? '1' : null;
  if (currency === 'USD') {
    const fx = all.match(
      /TASA(?:\s+(?:SEGUN|BCV|DE|CAMBIO|B\.?C\.?V\.?))*\s*[:=]?\s*(\d+(?:[.,]\d{1,10})?)/,
    );
    exchangeRate = fx ? readNumber(fx[1]!) : null;
    if (exchangeRate === null)
      warnings.push(
        'El documento está en USD y no indica una tasa numérica. Introduce la tasa Bs/USD para valorar la recepción.',
      );
  }
  const layout = parseLayoutTable(words);
  const plain = parseTextRows(text, allExempt);
  const quality = (ls: LayoutLine[]) =>
    ls.filter(
      (l) =>
        l.quantity !== null && l.unitCost !== null && l.printedTotal !== null && !l.needsReview,
    ).length *
      10 +
    ls.length;
  const useLayout = layout.lines.length > 0 && quality(layout.lines) >= quality(plain);
  const lines = (useLayout ? layout.lines : plain).map((l) => ({
    ...l,
    taxRate: l.taxRate ?? (allExempt ? '0' : null),
  }));
  if (useLayout) warnings.push(...layout.warnings);
  if (!lines.length)
    warnings.push(
      'No se pudieron reconstruir los artículos. Revisa el texto reconocido y la nitidez o recorta el documento.',
    );
  if (lines.some((l) => l.needsReview || l.quantity === null || l.unitCost === null))
    warnings.push(
      'Hay cantidades o importes ambiguos. No se inferirán valores que no concuerden con el renglón.',
    );
  if (lines.some((l) => l.taxRate === null))
    warnings.push(
      'Revisa el IVA de cada artículo. IVA total cero no acredita por sí solo que todos los productos sean exentos.',
    );
  if (declaredTotal === null) warnings.push('No se pudo leer el total del documento.');
  if (!invoiceNumber || !documentDate || (documentType === 'invoice' && !control))
    warnings.push('Revisa número, fecha y, para facturas, número de control.');
  let declaredQuantity: string | null = null;
  const quantityLabel = all.match(/TOTAL\s+(?:DE\s+)?UNIDADES\s*[:.]?\s*([0-9][0-9.,]*)/);
  if (
    quantityLabel &&
    lines.length &&
    lines.every((l) => l.quantity !== null && l.quantity !== '')
  ) {
    const sum = lines.reduce((s, l) => s.plus(l.quantity!), new Decimal(0));
    const candidates = numberCandidates(quantityLabel[1]!);
    const matching = candidates.filter((n) => sum.eq(n));
    if (matching.length === 1) declaredQuantity = matching[0]!;
    else {
      declaredQuantity = candidates.length === 1 ? candidates[0]! : null;
      warnings.push(
        'El total de unidades no coincide con los renglones; revisa separadores de miles y cantidades.',
      );
    }
  }
  if (lines.some((l) => l.unit && !/^(?:UN|UND|UNI|UNID|PZA|PZ|PCS?|TAB|CAP)$/i.test(l.unit)))
    warnings.push(
      'El documento incluye unidades diferentes de UNI. Revisa cantidades y equivalencias; no se convierten cajas, peso o volumen automáticamente.',
    );
  if (declaredTotal !== null && lines.length && lines.every((l) => l.printedTotal !== null)) {
    const sum = lines.reduce((s, l) => s.plus(l.printedTotal!), new Decimal(0));
    if (!sum.eq(declaredTotal))
      warnings.push(
        'La suma de renglones no coincide con el total impreso; revisa IVA, descuentos y renglones faltantes.',
      );
  }
  return {
    documentType,
    supplierName,
    supplierRif,
    invoiceNumber,
    controlNumber: documentType === 'delivery_note' ? null : control,
    documentDate,
    dueDate,
    paymentTerms,
    currency,
    exchangeRate,
    declaredTotal,
    declaredQuantity,
    warnings,
    lines,
  };
}
