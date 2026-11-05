import { useEffect, useRef, useState } from 'react';
import Decimal from 'decimal.js';
import { Button, Dialog, Feedback, Icon } from '../components/ui';
import { money, type Api } from '../types';
import type { GoodsDocument } from '../goods-types';
type Row = {
  key: string;
  name: string;
  quantity: string;
  unitCost: string;
  discountPercent: string;
  taxRate: string;
  existingSku: string;
  sourceKey?: string | null;
};
type Reading = {
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
    taxRate: string | null;
    sourceKey?: string | null;
  }[];
};
type Result = {
  reading: Reading;
  rawText: string;
  imageHash: string | null;
  confidence: number | null;
  sourceKind?: 'example' | 'image';
};
type Header = {
  supplierName: string;
  supplierRif: string;
  invoiceNumber: string;
  controlNumber: string;
  documentDate: string;
  currency: 'VES' | 'USD';
  exchangeRate: string;
  declaredTotal: string;
  paymentTerms: 'cash' | 'credit';
  dueDate: string;
};
const dec = (v: string) => v.replace(',', '.');
function calc(rows: Row[]) {
  try {
    let sum = new Decimal(0);
    for (const r of rows) {
      if (!r.quantity || !r.unitCost || !r.taxRate) return null;
      const gross = new Decimal(r.quantity).mul(r.unitCost).toDecimalPlaces(2);
      const net = gross.minus(gross.mul(r.discountPercent).div(100).toDecimalPlaces(2));
      sum = sum.plus(net).plus(net.mul(r.taxRate).div(100).toDecimalPlaces(2));
    }
    return sum.toFixed(2);
  } catch {
    return null;
  }
}
export function InvoiceImageImport({
  api,
  branch,
  onClose,
  onImported,
  onCatalogChanged,
}: {
  api: Api;
  branch: string;
  onClose: () => void;
  onImported: (d: GoodsDocument & { createdProducts: number; linkedProducts: number }) => void;
  onCatalogChanged: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [header, setHeader] = useState<Header | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => {
    if (!file) {
      setPreview('');
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const total = calc(rows);
  let matches = false;
  try {
    matches =
      !!total && !!header?.declaredTotal && new Decimal(total).eq(dec(header.declaredTotal));
  } catch {}
  function load(d: Result) {
    setResult(d);
    setHeader({
      supplierName: d.reading.supplierName ?? '',
      supplierRif: d.reading.supplierRif ?? '',
      invoiceNumber: d.reading.invoiceNumber ?? '',
      controlNumber: d.reading.controlNumber ?? '',
      documentDate: d.reading.documentDate ?? '',
      currency: d.reading.currency,
      exchangeRate: d.reading.exchangeRate ?? '',
      declaredTotal: d.reading.declaredTotal ?? '',
      paymentTerms: 'cash',
      dueDate: '',
    });
    setRows(
      d.reading.lines.map((l) => ({
        key: crypto.randomUUID(),
        name: l.name,
        quantity: l.quantity ?? '',
        unitCost: l.unitCost ?? '',
        discountPercent: l.discountPercent ?? '0',
        taxRate: l.taxRate ?? '',
        existingSku: '',
        sourceKey: l.sourceKey,
      })),
    );
    setReviewed(false);
    setError('');
  }
  async function read() {
    if (!file) {
      setError('Selecciona una imagen.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError('La imagen no puede superar 8 MB.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const body = new FormData();
      body.append('image', file);
      load({
        ...(await api<Result>('/goods/invoice-images/read', 'POST', body)),
        sourceKind: 'image',
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function example() {
    setFile(null);
    setBusy(true);
    setError('');
    try {
      load(await api<Result>('/goods/invoice-images/example'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function seed() {
    setBusy(true);
    setError('');
    try {
      const d = await api<{ created: number; existing: number }>(
        '/goods/invoice-images/example/catalog',
        'POST',
        {},
      );
      setNotice(
        `${d.created} artículos creados y ${d.existing} ya existentes. Sin stock recibido; los precios nuevos quedan pendientes.`,
      );
      onCatalogChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function field<K extends keyof Header>(key: K, value: Header[K]) {
    setHeader((h) => (h ? { ...h, [key]: value } : h));
    setReviewed(false);
  }
  function line(index: number, key: keyof Row, value: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [key]: value } : r)));
    setReviewed(false);
  }
  async function apply() {
    if (!header || !result) return;
    if (!reviewed) {
      setError('Confirma la revisión de los datos de la imagen.');
      return;
    }
    if (!matches) {
      setError('Corrige los renglones o el total declarado para que coincidan.');
      return;
    }
    const body = {
      ...header,
      exchangeRate: header.currency === 'VES' ? '1' : dec(header.exchangeRate),
      declaredTotal: dec(header.declaredTotal),
      dueDate: header.dueDate || null,
      branchId: branch,
      reviewed: true,
      sourceKind: result.sourceKind ?? 'image',
      imageHash: result.imageHash,
      rawText: result.rawText,
      lines: rows.map(
        ({ name, quantity, unitCost, discountPercent, taxRate, existingSku, sourceKey }) => ({
          name,
          quantity: dec(quantity),
          unitCost: dec(unitCost),
          discountPercent: dec(discountPercent),
          taxRate,
          existingSku: existingSku || null,
          sourceKey: sourceKey ?? null,
        }),
      ),
    };
    const signature = JSON.stringify(body);
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      onImported(
        await api<GoodsDocument & { createdProducts: number; linkedProducts: number }>(
          '/goods/invoice-images/apply',
          'POST',
          { ...body, idempotencyKey: attempt.current.key },
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Importar factura desde imagen"
      subtitle="Lectura automática, revisión y creación de un borrador de compra"
      onClose={onClose}
      busy={busy}
    >
      <div className="invoice-import">
        <Feedback error={error} notice={notice} />
        {!header ? (
          <>
            <div className="invoice-upload-grid">
              <div>
                <label className="invoice-drop">
                  <Icon name="file" size={30} />
                  <strong>Selecciona una fotografía de la factura</strong>
                  <span>JPEG, PNG o WebP · Hasta 8 MB y 12 megapíxeles</span>
                  <input
                    aria-label="Imagen de factura"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={busy}
                    onChange={(e) => {
                      setFile(e.target.files?.[0] ?? null);
                      setError('');
                    }}
                  />
                </label>
                <p className="form-hint">
                  Usa una foto nítida, recta y con todos los bordes visibles. La lectura se procesa
                  en el servidor de la aplicación. No se envía a un proveedor externo de OCR.
                </p>
                <Button
                  variant="primary"
                  icon="search"
                  onClick={() => void read()}
                  disabled={busy || !file}
                >
                  {busy ? 'Leyendo imagen…' : 'Leer imagen y preparar factura'}
                </Button>
              </div>
              <div className="invoice-preview">
                {preview ? (
                  <img src={preview} alt="Factura seleccionada para revisar" />
                ) : (
                  <div>
                    <Icon name="file" size={46} />
                    <p>La imagen aparecerá aquí</p>
                  </div>
                )}
              </div>
            </div>
            <div className="example-actions">
              <div>
                <strong>Factura de ejemplo enviada</strong>
                <p>
                  Puedes crear sus 18 artículos o abrir su transcripción para revisión. Es una carga
                  de referencia, no una lectura OCR de esta selección.
                </p>
              </div>
              <Button onClick={() => void seed()} disabled={busy}>
                Crear artículos del ejemplo
              </Button>
              <Button onClick={() => void example()} disabled={busy}>
                Revisar factura de ejemplo
              </Button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void apply();
            }}
          >
            <fieldset disabled={busy}>
              <div className="invoice-reading-status">
                <span
                  className={'badge ' + (result?.sourceKind === 'example' ? 'neutral' : 'green')}
                >
                  {result?.sourceKind === 'example'
                    ? 'Transcripción de ejemplo'
                    : `OCR · Confianza ${result?.confidence ?? '—'} %`}
                </span>
                <span>Revisa todos los campos antes de crear la factura</span>
              </div>
              {result?.reading.warnings.map((w, i) => (
                <div key={i} className="alert warning">
                  {w}
                </div>
              ))}
              <div className="invoice-review-header">
                <label>
                  Razón social del proveedor
                  <input
                    required
                    maxLength={200}
                    value={header.supplierName}
                    onChange={(e) => field('supplierName', e.target.value)}
                  />
                </label>
                <label>
                  RIF del proveedor
                  <input
                    required
                    maxLength={20}
                    value={header.supplierRif}
                    onChange={(e) => field('supplierRif', e.target.value)}
                  />
                </label>
                <label>
                  Número de factura
                  <input
                    required
                    maxLength={80}
                    value={header.invoiceNumber}
                    onChange={(e) => field('invoiceNumber', e.target.value)}
                  />
                </label>
                <label>
                  Número de control
                  <input
                    required
                    maxLength={80}
                    value={header.controlNumber}
                    onChange={(e) => field('controlNumber', e.target.value)}
                  />
                </label>
                <label>
                  Fecha de factura
                  <input
                    type="date"
                    required
                    value={header.documentDate}
                    onChange={(e) => field('documentDate', e.target.value)}
                  />
                </label>
                <label>
                  Moneda de factura
                  <select
                    aria-label="Moneda de factura"
                    value={header.currency}
                    onChange={(e) => {
                      field('currency', e.target.value as Header['currency']);
                      field('exchangeRate', e.target.value === 'VES' ? '1' : '');
                    }}
                  >
                    <option value="VES">Bolívares</option>
                    <option value="USD">USD</option>
                  </select>
                </label>
                <label>
                  Tasa de conversión Bs/USD
                  <input
                    required
                    readOnly={header.currency === 'VES'}
                    value={header.exchangeRate}
                    onChange={(e) => field('exchangeRate', dec(e.target.value))}
                  />
                </label>
                <label>
                  Total impreso en la factura
                  <input
                    required
                    aria-label="Total impreso en la factura"
                    inputMode="decimal"
                    value={header.declaredTotal}
                    onChange={(e) => field('declaredTotal', dec(e.target.value))}
                  />
                </label>
                <label>
                  Condición de pago
                  <select
                    aria-label="Condición de pago importada"
                    value={header.paymentTerms}
                    onChange={(e) =>
                      field('paymentTerms', e.target.value as Header['paymentTerms'])
                    }
                  >
                    <option value="cash">Contado</option>
                    <option value="credit">Crédito</option>
                  </select>
                </label>
                <label>
                  Vencimiento del crédito
                  <input
                    type="date"
                    required={header.paymentTerms === 'credit'}
                    min={header.documentDate}
                    value={header.dueDate}
                    onChange={(e) => field('dueDate', e.target.value)}
                  />
                </label>
              </div>
              <div className="invoice-review-layout">
                <div>
                  <div className="table-scroll">
                    <table className="invoice-review-lines">
                      <thead>
                        <tr>
                          <th>Descripción / código existente</th>
                          <th>Cantidad</th>
                          <th>Costo unit.</th>
                          <th>Desc. %</th>
                          <th>IVA %</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={r.key}>
                            <td>
                              <input
                                aria-label={'Descripción importada ' + (i + 1)}
                                required
                                minLength={3}
                                maxLength={200}
                                value={r.name}
                                onChange={(e) => line(i, 'name', e.target.value)}
                              />
                              <input
                                aria-label={'Código existente ' + (i + 1)}
                                value={r.existingSku}
                                maxLength={64}
                                onChange={(e) => line(i, 'existingSku', e.target.value)}
                                placeholder="Código existente (opcional)"
                              />
                            </td>
                            <td>
                              <input
                                aria-label={'Cantidad importada ' + (i + 1)}
                                required
                                inputMode="decimal"
                                value={r.quantity}
                                onChange={(e) => line(i, 'quantity', dec(e.target.value))}
                              />
                            </td>
                            <td>
                              <input
                                aria-label={'Costo importado ' + (i + 1)}
                                required
                                inputMode="decimal"
                                value={r.unitCost}
                                onChange={(e) => line(i, 'unitCost', dec(e.target.value))}
                              />
                            </td>
                            <td>
                              <input
                                aria-label={'Descuento importado ' + (i + 1)}
                                required
                                inputMode="decimal"
                                value={r.discountPercent}
                                onChange={(e) => line(i, 'discountPercent', dec(e.target.value))}
                              />
                            </td>
                            <td>
                              <select
                                aria-label={'IVA importado ' + (i + 1)}
                                required
                                value={r.taxRate}
                                onChange={(e) => line(i, 'taxRate', e.target.value)}
                              >
                                <option value="">Revisar</option>
                                <option value="0">Exento</option>
                                <option value="8">8 %</option>
                                <option value="16">16 %</option>
                              </select>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="icon-button"
                                aria-label={'Quitar artículo importado ' + (i + 1)}
                                onClick={() => {
                                  setRows((old) => old.filter((_, index) => index !== i));
                                  setReviewed(false);
                                }}
                              >
                                <Icon name="close" size={15} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Button
                    icon="plus"
                    disabled={rows.length >= 100}
                    onClick={() => {
                      setRows((old) => [
                        ...old,
                        {
                          key: crypto.randomUUID(),
                          name: '',
                          quantity: '1',
                          unitCost: '',
                          discountPercent: '0',
                          taxRate: '',
                          existingSku: '',
                        },
                      ]);
                      setReviewed(false);
                    }}
                  >
                    Agregar renglón
                  </Button>
                </div>
                {preview && (
                  <div className="invoice-preview">
                    <img src={preview} alt="Factura original para cotejar los datos" />
                  </div>
                )}
              </div>
              <div className={'invoice-reconciliation ' + (matches ? 'matched' : 'unmatched')}>
                <span>
                  Suma de renglones:{' '}
                  <strong>
                    {header.currency === 'VES' ? 'Bs' : 'USD'}{' '}
                    {total === null ? 'Datos incompletos' : money(total)}
                  </strong>
                </span>
                <span>
                  {matches
                    ? 'El total coincide con el declarado'
                    : 'Revisa los importes: el total no coincide o faltan datos'}
                </span>
              </div>
              <details className="ocr-text">
                <summary>Ver texto reconocido para cotejar la lectura</summary>
                <pre>{result?.rawText}</pre>
              </details>
              <p className="form-hint">
                Se reutilizan artículos por código o por nombre completo único. Los nuevos se crean
                con precio de venta pendiente. La importación no recibe stock: después podrás
                revisar el borrador y usar Confirmar y recibir.
              </p>
              <label className="review-check">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                  required
                />
                He revisado proveedor, artículos, cantidades, costos, IVA y total frente a la
                factura.
              </label>
              <div className="dialog-footer">
                <Button
                  onClick={() => {
                    setHeader(null);
                    setResult(null);
                    setRows([]);
                    setError('');
                  }}
                >
                  Cambiar imagen
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={!matches || !rows.length || !reviewed || busy}
                >
                  {busy ? 'Importando…' : 'Crear artículos y factura en borrador'}
                </Button>
              </div>
            </fieldset>
          </form>
        )}
      </div>
    </Dialog>
  );
}
