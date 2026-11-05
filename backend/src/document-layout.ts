import { numberCandidates, reconcileRow, readNumber } from './document-numbers';
export type OcrWord = {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
};
export type LayoutLine = {
  name: string;
  quantity: string | null;
  unitCost: string | null;
  printedTotal: string | null;
  discountPercent: string;
  taxRate: '0' | '8' | '16' | null;
  sourceCode?: string;
  lot?: string;
  expiry?: string;
  unit?: string;
  needsReview?: boolean;
};
export const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
const median = (n: number[]) => [...n].sort((a, b) => a - b)[Math.floor(n.length / 2)] ?? 12;
export function wordRows(words: OcrWord[]): OcrWord[][] {
  const selected = words.filter((w) => w.text.trim() && w.y1 > w.y0 && w.x1 > w.x0).slice(0, 15000);
  const height = median(selected.map((w) => w.y1 - w.y0));
  const rows: { y: number; words: OcrWord[] }[] = [];
  for (const w of [...selected].sort((a, b) => (a.y0 + a.y1 - b.y0 - b.y1) / 2 || a.x0 - b.x0)) {
    const y = (w.y0 + w.y1) / 2,
      last = rows[rows.length - 1];
    if (last && Math.abs(last.y - y) <= height * 0.65) {
      last.words.push(w);
      last.y = last.words.reduce((sum, v) => sum + (v.y0 + v.y1) / 2, 0) / last.words.length;
    } else rows.push({ y, words: [w] });
  }
  return rows.map((r) => r.words.sort((a, b) => a.x0 - b.x0));
}
export function spatialText(words: OcrWord[]): string {
  return wordRows(words)
    .map((r) => r.map((w) => w.text).join(' '))
    .join('\n');
}
type Role =
  | 'name'
  | 'quantity'
  | 'cost'
  | 'total'
  | 'discount'
  | 'tax'
  | 'code'
  | 'lot'
  | 'expiry'
  | 'unit'
  | 'base';
const aliases: [Role, RegExp][] = [
  [
    'name',
    /^(NOMBRE DEL ARTICULO|DESCRIPCION(?: DEL (?:ARTICULO|PRODUCTO))?|CONCEPTO(?: O DESCRIPCION)?|ARTICULO|PRODUCTO|DETALLE|DESCRIPTION|ITEM NAME)$/,
  ],
  ['quantity', /^(CANT(?:IDAD)?|CANTD|CDAD|UNIDADES|QTY|QUANTITY)$/],
  [
    'cost',
    /^(PRECIO UNIT(?:ARIO)?|COSTO UNIT(?:ARIO)?|P UNIT(?:ARIO)?|P U|C UNIT|VALOR UNITARIO|UNIT PRICE|UNIT COST|PRECIO|COSTO)$/,
  ],
  ['total', /^(TOTAL NETO|TOTAL RENGLON|TOTAL LINEA|TOTAL|IMPORTE|MONTO|AMOUNT)$/],
  ['base', /^(NETO|SUBTOTAL|BASE|BASE IMPONIBLE)$/],
  ['discount', /^(DESC(?:UENTO)?|DCTO|DTO|DESCTO|DISCOUNT)$/],
  ['tax', /^(IVA|I V A|IMPUESTO|TAX)$/],
  ['code', /^(CODIGO|COD|REFERENCIA|REF|SKU|CODE)$/],
  ['lot', /^(LOTE|LOT|BATCH)$/],
  ['expiry', /^(F VENCE|F VENC|VENCE|VENCIMIENTO|CADUCIDAD|EXP|EXPIRY)$/],
  ['unit', /^(UNIDAD|UNID|UND|UNI|UM|U M|UNIT)$/],
];
type Column = { role: Role; x: number; x0: number; x1: number };
function columns(row: OcrWord[]): Column[] {
  const found: Column[] = [];
  let i = 0;
  while (i < row.length) {
    let matched = false;
    for (let n = Math.min(5, row.length - i); n >= 1 && !matched; n--) {
      const part = row.slice(i, i + n);
      const value = fold(part.map((w) => w.text).join(' '))
        .replace(/[.%:_/-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const alias = aliases.find(([, re]) => re.test(value));
      if (alias) {
        const x0 = part[0]!.x0,
          x1 = part[part.length - 1]!.x1;
        found.push({ role: alias[0], x: (x0 + x1) / 2, x0, x1 });
        i += n;
        matched = true;
      }
    }
    if (!matched) i++;
  }
  if (!found.some((c) => c.role === 'total')) {
    const base = found.find((c) => c.role === 'base');
    if (base) base.role = 'total';
  }
  return found;
}
export function parseLayoutTable(words: OcrWord[]): {
  lines: LayoutLine[];
  warnings: string[];
  headerY: number | null;
} {
  const rows = wordRows(words),
    warnings: string[] = [];
  let header = -1,
    cols: Column[] = [];
  for (let i = 0; i < rows.length; i++) {
    const candidates = columns(rows[i]!);
    if (
      ['name', 'quantity', 'cost', 'total'].every((role) => candidates.some((c) => c.role === role))
    ) {
      header = i;
      cols = candidates;
      break;
    }
  }
  if (header < 0) return { lines: [], warnings, headerY: null };
  cols.sort((a, b) => a.x - b.x);
  const lines: LayoutLine[] = [];
  for (const row of rows.slice(header + 1)) {
    const text = fold(row.map((w) => w.text).join(' '));
    if (
      /^(SUB\s*[- ]?TOTAL|TOTAL(?: GENERAL| A PAGAR| UNIDADES| IVA| EXENTO)?\b|BASE IMPONIBLE|RECIBI CONFORME|SIN DERECHO)/.test(
        text,
      )
    )
      break;
    const claimed = new Set<OcrWord>();
    const values: Partial<Record<Role, string>> = {};
    const numeric = (s: string) => numberCandidates(s.replace(/%$/, '')).length > 0;
    const isValue = (role: Role, s: string) =>
      role === 'expiry'
        ? /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/.test(s)
        : role === 'unit'
          ? /^(?:UND?|UNI|UNID|PZA|PZ|PCS?|KG|GR|ML|LT|CAJ|CJ|TAB|CAP)$/i.test(s)
          : role === 'tax'
            ? /^(?:E|EX|EXENTO|EXENTA|0|8|16)(?:[.,]0+)?%?$/i.test(s)
            : role === 'lot' || role === 'code'
              ? /^[A-Z0-9][A-Z0-9._/-]{0,25}$/i.test(s) && /\d/.test(s)
              : numeric(s);
    // Remove metadata by its own columns. Remaining words form the full description,
    // even when the description is much wider than its centred heading.
    for (const role of [
      'code',
      'expiry',
      'unit',
      'lot',
      'total',
      'cost',
      'quantity',
      'discount',
      'tax',
      'base',
    ] as Role[]) {
      const column = cols.find((c) => c.role === role);
      if (!column) continue;
      const index = cols.indexOf(column);
      const left = index === 0 ? -Infinity : (cols[index - 1]!.x + column.x) / 2;
      const right = index === cols.length - 1 ? Infinity : (cols[index + 1]!.x + column.x) / 2;
      const candidates = row
        .filter(
          (w) =>
            !claimed.has(w) &&
            isValue(role, w.text) &&
            (w.x0 + w.x1) / 2 >= left &&
            (w.x0 + w.x1) / 2 <= right,
        )
        .sort(
          (a, b) => Math.abs((a.x0 + a.x1) / 2 - column.x) - Math.abs((b.x0 + b.x1) / 2 - column.x),
        );
      if (candidates[0]) {
        claimed.add(candidates[0]);
        values[role] = candidates[0].text;
      }
    }
    const cell = (role: Role) => values[role] ?? '';
    const name = row
        .filter((w) => !claimed.has(w))
        .map((w) => w.text)
        .join(' ')
        .trim(),
      quantity = cell('quantity'),
      cost = cell('cost'),
      total = cell('total');
    if (!/[A-ZÁÉÍÓÚÑ]/i.test(name) || ![quantity, cost, total].some(Boolean)) continue;
    const discount = readNumber(cell('discount').replace('%', '')) ?? '0';

    const tax = cell('tax');
    const taxRate = /^(?:E|EX|EXENTO|EXENTA|0(?:[.,]0+)?)%?$/i.test(tax)
      ? '0'
      : /^(?:8|16)(?:[.,]0+)?%?$/.test(tax)
        ? (String(Number(tax.replace('%', '').replace(',', '.'))) as '8' | '16')
        : null;
    const matched = reconcileRow(quantity, cost, total, discount, taxRate ?? '0');
    lines.push({
      name,
      quantity: matched.quantity,
      unitCost: matched.unitCost,
      printedTotal: matched.printedTotal,
      discountPercent: discount,
      taxRate,
      sourceCode: cell('code') || undefined,
      lot: cell('lot') || undefined,
      expiry: cell('expiry') || undefined,
      unit: cell('unit') || undefined,
      needsReview: matched.ambiguous,
    });
  }
  if (lines.some((l) => l.needsReview))
    warnings.push(
      'Hay renglones ambiguos: revisa cantidad × costo y descuentos frente al importe impreso.',
    );
  return {
    lines: lines.slice(0, 100),
    warnings,
    headerY: Math.min(...rows[header]!.map((w) => w.y0)),
  };
}
