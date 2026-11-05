import { useEffect, useRef, useState } from 'react';
import Decimal from 'decimal.js';
import { useResource } from '../api';
import { Button, Dialog, Feedback } from '../components/ui';
import { money, type Api } from '../types';
import type { GoodsDocument, GoodsLine } from '../goods-types';
type Catalogue = {
  id: string;
  version: number;
  price_usd: string;
  profit_percent: string | null;
  price_pending: boolean;
  active: boolean;
};
type Context = { document: GoodsDocument; products: Catalogue[] };
const clean = (s: string) => s.replace(',', '.');
const validPercent = (s: string) =>
  /^(0|[1-9]\d{0,3})(\.\d{1,4})?$/.test(s) && new Decimal(s).lte(1000);
function proposal(line: GoodsLine, currency: 'VES' | 'USD', rate: string, percent: string) {
  try {
    const net = new Decimal(line.taxable_base).div(line.quantity);
    if (
      !validPercent(percent) ||
      !/^(0|[1-9]\d{0,11})(\.\d{1,10})?$/.test(rate) ||
      !new Decimal(rate).gt(0)
    )
      return { net: net.toFixed(6), price: null, tax: null, total: null, baseTotal: null };
    const cost = currency === 'VES' ? net.div(rate) : net;
    const price = cost
      .mul(new Decimal(1).plus(new Decimal(percent).div(100)))
      .toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
    const base = price.toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
      tax = base.mul(line.tax_rate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    return {
      net: net.toFixed(6),
      price: price.toFixed(6),
      tax: tax.toFixed(2),
      total: base.plus(tax).toFixed(2),
      baseTotal: price
        .mul(rate)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .mul(new Decimal(1).plus(new Decimal(line.tax_rate).div(100)))
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toFixed(2),
    };
  } catch {
    return { net: null, price: null, tax: null, total: null, baseTotal: null };
  }
}
export function PurchasePricing({
  api,
  document,
  rate,
  onBusy,
  onClose,
  onSaved,
}: {
  api: Api;
  document: GoodsDocument;
  rate: string;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onSaved: (d: GoodsDocument) => void;
}) {
  const query = useResource<Context>(document.id + ':' + document.version + ':pricing', (s) =>
    api('/goods/documents/' + document.id + '/pricing', 'GET', undefined, s),
  );
  const [fx, setFx] = useState(''),
    [margins, setMargins] = useState<Record<string, string>>({}),
    [common, setCommon] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const d = query.data?.document ?? document;
  const readonly = d.status === 'confirmed';
  useEffect(() => {
    if (!query.data) return;
    const { document: doc, products } = query.data;
    setFx(
      doc.pricing_rate
        ? new Decimal(doc.pricing_rate).toString()
        : doc.currency === 'USD'
          ? new Decimal(doc.exchange_rate).toString()
          : rate,
    );
    setMargins(
      Object.fromEntries(
        doc.lines.map((l) => {
          const value =
            l.profit_percent ??
            (readonly ? null : products.find((p) => p.id === l.product_id)?.profit_percent);
          return [l.id, value === null || value === undefined ? '' : new Decimal(value).toString()];
        }),
      ),
    );
  }, [query.data]);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy]);
  const results = d.lines.map((l) => proposal(l, d.currency, fx, margins[l.id] ?? ''));
  const valid =
    !!query.data &&
    d.lines.length > 0 &&
    results.every((r) => r.price !== null) &&
    d.lines.every(
      (l) =>
        validPercent(margins[l.id] ?? '') &&
        query.data!.products.some((p) => p.id === l.product_id && p.active),
    );
  async function save() {
    if (!valid || !query.data) {
      setError('Indica la tasa y el porcentaje de cada artículo.');
      return;
    }
    const body = {
      expectedVersion: d.version,
      rate: fx,
      lines: d.lines.map((l) => ({
        lineId: l.id,
        profitPercent: margins[l.id],
        expectedProductVersion: query.data!.products.find((p) => p.id === l.product_id)!.version,
      })),
    };
    const signature = JSON.stringify(body);
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      onSaved(
        await api<GoodsDocument>('/goods/documents/' + d.id + '/pricing', 'POST', {
          ...body,
          idempotencyKey: attempt.current.key,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={readonly ? 'Márgenes de la compra' : 'Márgenes de ganancia'}
      subtitle={d.display_number + ' · Ganancia sobre costo neto, antes de IVA'}
      onClose={onClose}
      busy={busy}
    >
      <form
        className="purchase-pricing"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Feedback error={error || query.error} />
        {query.loading ? (
          <p>Leyendo costos y precios actuales…</p>
        ) : (
          <>
            <div className="pricing-explanation">
              <strong>Costo neto × (1 + ganancia %) = precio sin IVA</strong>
              <p>
                El costo neto incluye el descuento individual de la factura. El IVA se añade al
                precio de venta después de la ganancia.
              </p>
              <p>
                Ejemplo: costo Bs 100 − 10 % de descuento = Bs 90; + 30 % de ganancia = Bs 117; + 16
                % de IVA = <strong>Bs 135,72</strong>.
              </p>
            </div>
            <fieldset disabled={busy || readonly || !query.data}>
              <div className="pricing-controls">
                <label>
                  Tasa para fijar precios (Bs/USD)
                  <input
                    aria-label="Tasa para fijar precios"
                    required
                    inputMode="decimal"
                    readOnly={d.currency === 'USD'}
                    value={fx}
                    onChange={(e) => setFx(clean(e.target.value))}
                  />
                  <small>
                    {d.currency === 'VES'
                      ? 'Indica la tasa de conversión a USD. No es el factor 1 de la factura en Bs.'
                      : 'Se utiliza la tasa registrada en la factura en USD.'}
                  </small>
                </label>
                <div>
                  <label>
                    Ganancia inicial para todos
                    <input
                      aria-label="Ganancia inicial para todos"
                      inputMode="decimal"
                      placeholder="Ej. 30"
                      value={common}
                      onChange={(e) => setCommon(clean(e.target.value))}
                    />
                  </label>
                  <Button
                    disabled={!validPercent(common)}
                    onClick={() => {
                      setMargins(Object.fromEntries(d.lines.map((l) => [l.id, common])));
                      setError('');
                    }}
                  >
                    Aplicar a todos
                  </Button>
                </div>
              </div>
            </fieldset>
            <p className="form-hint">
              Puedes modificar cada porcentaje individualmente. Los precios del catálogo se guardan
              en USD sin IVA y se actualizarán al confirmar la recepción.
            </p>
            <div className="table-scroll">
              <table className="purchase-pricing-lines">
                <thead>
                  <tr>
                    <th>Artículo</th>
                    <th>Costo neto unit. {d.currency === 'VES' ? 'Bs' : 'USD'}</th>
                    <th>Ganancia %</th>
                    <th>Venta sin IVA USD</th>
                    <th>IVA</th>
                    <th>Precio final USD</th>
                    <th>Referencia Bs</th>
                  </tr>
                </thead>
                <tbody>
                  {d.lines.map((l, i) => {
                    const r = results[i]!,
                      p = query.data?.products.find((x) => x.id === l.product_id),
                      zero = r.price !== null && new Decimal(r.price).isZero();
                    return (
                      <tr key={l.id}>
                        <td>
                          <strong>{l.name}</strong>
                          <small>
                            {l.sku} · Desc. {new Decimal(l.discount_percent).toString()} %
                          </small>
                          <small>
                            Precio actual:{' '}
                            {p?.price_pending
                              ? 'Pendiente'
                              : p
                                ? 'USD ' + money(p.price_usd)
                                : 'No disponible'}
                          </small>
                        </td>
                        <td className="right number">{r.net === null ? '—' : money(r.net)}</td>
                        <td>
                          <input
                            aria-label={'Ganancia del artículo ' + (i + 1)}
                            inputMode="decimal"
                            required
                            disabled={busy || readonly || !query.data}
                            value={margins[l.id] ?? ''}
                            onChange={(e) =>
                              setMargins((old) => ({ ...old, [l.id]: clean(e.target.value) }))
                            }
                          />
                        </td>
                        <td className="right number">
                          {zero
                            ? 'Conserva precio actual'
                            : r.price === null
                              ? '—'
                              : money(r.price)}
                        </td>
                        <td className="right number">
                          <span>
                            {Number(l.tax_rate) === 0
                              ? 'Exento'
                              : new Decimal(l.tax_rate).toString() + ' %'}
                          </span>
                          <small>{r.tax === null ? '—' : 'USD ' + money(r.tax)}</small>
                        </td>
                        <td className="right number pricing-final">
                          {r.total === null || zero ? '—' : '$ ' + money(r.total)}
                        </td>
                        <td className="right number">
                          {r.baseTotal === null || zero ? '—' : 'Bs ' + money(r.baseTotal)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {results.some((r) => r.price !== null && new Decimal(r.price).isZero()) && (
              <div className="alert warning">
                Los artículos con costo neto cero conservan su precio actual. Si eran nuevos,
                continuarán con precio de venta pendiente para evitar habilitarlos a precio cero.
              </div>
            )}
            <div className="dialog-footer">
              <Button onClick={onClose} disabled={busy}>
                {readonly ? 'Cerrar' : 'Volver a factura'}
              </Button>
              {!readonly && (
                <Button type="submit" variant="primary" disabled={busy || !valid}>
                  {busy ? 'Guardando…' : 'Guardar márgenes'}
                </Button>
              )}
            </div>
          </>
        )}
      </form>
    </Dialog>
  );
}
