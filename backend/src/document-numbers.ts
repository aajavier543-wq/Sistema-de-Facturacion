import Decimal from 'decimal.js';
export function numberCandidates(input: string): string[] {
  const s = input.trim().replace(/[\u00a0\s]/g, '');
  if (!/^\d+(?:[.,]\d+)*$/.test(s)) return [];
  const values = new Set<string>();
  const add = (v: string) => {
    if (/^\d+(?:\.\d{1,10})?$/.test(v)) {
      const d = new Decimal(v);
      if (d.isFinite() && d.gte(0)) values.add(d.toString());
    }
  };
  const commas = (s.match(/,/g) ?? []).length,
    dots = (s.match(/\./g) ?? []).length;
  if (commas && dots) {
    const last = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
    const integer = s.slice(0, last),
      fraction = s.slice(last + 1);
    const sep = s[last]!;
    if (!integer.includes(sep) && /^\d{1,3}(?:[.,]\d{3})*$/.test(integer))
      add(integer.replace(/[.,]/g, '') + '.' + fraction);
  } else if (commas || dots) {
    const sep = commas ? ',' : '.',
      parts = s.split(sep);
    if (parts.length === 2) add(parts[0] + '.' + parts[1]);
    if (parts[0]!.length <= 3 && parts.slice(1).every((p) => p.length === 3)) add(parts.join(''));
  } else add(s);
  return [...values];
}
export function readNumber(input: string): string | null {
  return numberCandidates(input)[0] ?? null;
}
export function reconcileRow(
  quantity: string,
  cost: string,
  total: string,
  discount = '0',
  taxRate = '0',
): {
  quantity: string | null;
  unitCost: string | null;
  printedTotal: string | null;
  ambiguous: boolean;
} {
  const qs = numberCandidates(quantity).filter((v) => new Decimal(v).gt(0)),
    ps = numberCandidates(cost),
    ts = numberCandidates(total),
    d = readNumber(discount);
  const matches: { quantity: string; unitCost: string; printedTotal: string }[] = [];
  if (d !== null && new Decimal(d).lte(100))
    for (const q of qs)
      for (const p of ps)
        for (const t of ts) {
          const gross = new Decimal(q).mul(p).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
          const net = gross.minus(gross.mul(d).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
          const final = net.plus(
            net.mul(taxRate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
          );
          if (final.eq(t)) matches.push({ quantity: q, unitCost: p, printedTotal: t });
        }
  if (matches.length === 1) return { ...matches[0]!, ambiguous: false };
  return {
    quantity: qs.length === 1 ? qs[0]! : null,
    unitCost: ps.length === 1 ? ps[0]! : null,
    printedTotal: ts.length === 1 ? ts[0]! : null,
    ambiguous: matches.length !== 1,
  };
}
