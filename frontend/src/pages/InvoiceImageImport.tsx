import { useEffect, useRef, useState } from 'react';
import Decimal from 'decimal.js';
import { ApiError, useResource } from '../api';
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
  sourceInfo?: string;
};
type Reading = {
  documentType?: 'invoice' | 'delivery_note' | 'unknown';
  dueDate?: string | null;
  paymentTerms?: 'cash' | 'credit';
  supplierName: string | null;
  supplierRif: string | null;
  invoiceNumber: string | null;
  controlNumber: string | null;
  documentDate: string | null;
  currency: 'VES' | 'USD' | 'unknown';
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
    sourceCode?: string;
    lot?: string;
    expiry?: string;
    unit?: string;
  }[];
};
type Result = {
  reading: Reading;
  rawText: string;
  imageHash: string | null;
  confidence: number | null;
  sourceKind?: 'example' | 'image';
  engine?: string;
};
type Header = {
  purchaseDocumentType: 'invoice' | 'delivery_note' | '';
  supplierName: string;
  supplierRif: string;
  invoiceNumber: string;
  controlNumber: string;
  documentDate: string;
  currency: 'VES' | 'USD' | '';
  exchangeRate: string;
  declaredTotal: string;
  paymentTerms: 'cash' | 'credit';
  dueDate: string;
};
type ReadOperation = {
  id: string;
  controller: AbortController;
  reason?: 'user' | 'timeout' | 'closed';
  cancelPromise?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
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
  const reader = useResource<{
    provider: string;
    displayName: string;
    configured: boolean;
    external: boolean;
    waitSeconds: number;
  }>('invoice-reader-status', (signal) =>
    api('/goods/invoice-images/status', 'GET', undefined, signal),
  );
  const externalReader = reader.data?.provider === 'gemini';
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [crop, setCrop] = useState<{ x: number; y: number; width: number; height: number } | null>(
    null,
  );
  const [detailed, setDetailed] = useState(false);
  const waitSeconds = externalReader ? (reader.data?.waitSeconds ?? 90) + 20 : detailed ? 110 : 80;
  const [batchTax, setBatchTax] = useState('');
  const cropStart = useRef<{ x: number; y: number } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [header, setHeader] = useState<Header | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [checking, setChecking] = useState(false);
  const checkOperation = useRef<AbortController | null>(null);
  const [isReading, setIsReading] = useState(false),
    [cancelling, setCancelling] = useState(false),
    [elapsed, setElapsed] = useState(0);
  const readOperation = useRef<ReadOperation | null>(null);
  useEffect(() => {
    if (!isReading) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [isReading]);
  useEffect(
    () => () => {
      checkOperation.current?.abort();
      checkOperation.current = null;
      const op = readOperation.current;
      if (op) {
        readOperation.current = null;
        op.reason = 'closed';
        if (op.timer) clearTimeout(op.timer);
        op.cancelPromise ??= cancelOnServer(op.id);
        op.controller.abort();
      }
    },
    [],
  );
  async function cancelOnServer(id: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      await api('/goods/invoice-images/cancel', 'POST', { requestId: id }, controller.signal);
    } catch {
    } finally {
      clearTimeout(timer);
    }
  }
  function stopReading(reason: 'user' | 'timeout') {
    const op = readOperation.current;
    if (!op || op.reason) return;
    op.reason = reason;
    setCancelling(true);
    op.cancelPromise = cancelOnServer(op.id);
    op.controller.abort();
  }

  const attempt = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => {
    if (!file) {
      setPreview('');
      return;
    }
    let cancelled = false;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      if (rotation === 0) {
        setPreview(url);
        return;
      }
      const swap = rotation === 90 || rotation === 270;
      const scale = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.round((swap ? img.naturalHeight : img.naturalWidth) * scale);
      canvas.height = Math.round((swap ? img.naturalWidth : img.naturalHeight) * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.drawImage(
        img,
        (-img.naturalWidth * scale) / 2,
        (-img.naturalHeight * scale) / 2,
        img.naturalWidth * scale,
        img.naturalHeight * scale,
      );
      setPreview(canvas.toDataURL('image/png'));
    };
    img.src = url;
    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
    };
  }, [file, rotation]);
  function cropPoint(e: React.PointerEvent<HTMLDivElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (e.clientY - box.top) / box.height)),
    };
  }
  const total = calc(rows);
  let matches = false;
  try {
    matches =
      !!total && !!header?.declaredTotal && new Decimal(total).eq(dec(header.declaredTotal));
  } catch {}
  function load(d: Result) {
    setResult(d);
    setHeader({
      purchaseDocumentType:
        d.reading.documentType === 'delivery_note'
          ? 'delivery_note'
          : d.reading.documentType === 'invoice' || d.sourceKind === 'example'
            ? 'invoice'
            : '',
      supplierName: d.reading.supplierName ?? '',
      supplierRif: d.reading.supplierRif ?? '',
      invoiceNumber: d.reading.invoiceNumber ?? '',
      controlNumber: d.reading.controlNumber ?? '',
      documentDate: d.reading.documentDate ?? '',
      currency: d.reading.currency === 'unknown' ? '' : d.reading.currency,
      exchangeRate: d.reading.exchangeRate ?? '',
      declaredTotal: d.reading.declaredTotal ?? '',
      paymentTerms: d.reading.paymentTerms ?? 'cash',
      dueDate: d.reading.dueDate ?? '',
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
        sourceInfo: [
          l.sourceCode ? 'Código proveedor: ' + l.sourceCode : '',
          l.lot ? 'Lote: ' + l.lot : '',
          l.expiry ? 'Vence: ' + l.expiry : '',
          l.unit ? 'Unidad: ' + l.unit : '',
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    );
    setReviewed(false);
    setError('');
  }
  async function checkConnection() {
    if (checkOperation.current || busy) return;
    const controller = new AbortController();
    checkOperation.current = controller;
    const timer = setTimeout(() => controller.abort(), 20000);
    setChecking(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ message: string }>(
        '/goods/invoice-images/check',
        'POST',
        {},
        controller.signal,
      );
      if (checkOperation.current === controller) setNotice(result.message);
    } catch (error) {
      if (checkOperation.current === controller)
        setError(
          controller.signal.aborted
            ? 'La comprobación agotó su tiempo de espera. Puedes volver a intentarlo.'
            : (error as Error).message,
        );
    } finally {
      clearTimeout(timer);
      if (checkOperation.current === controller) {
        checkOperation.current = null;
        setChecking(false);
      }
    }
  }
  async function read() {
    if (readOperation.current || busy || checking) return;
    if (!reader.data?.configured) {
      setError(
        'El lector aún no está conectado. El administrador debe configurar la cuenta de Gemini.',
      );
      return;
    }
    if (!file) {
      setError('Selecciona una imagen.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError('La imagen no puede superar 8 MB.');
      return;
    }
    const op: ReadOperation = { id: crypto.randomUUID(), controller: new AbortController() };
    readOperation.current = op;
    op.timer = setTimeout(() => stopReading('timeout'), waitSeconds * 1000);
    setBusy(true);
    setIsReading(true);
    setCancelling(false);
    setError('');
    setNotice('');
    try {
      const body = new FormData();
      body.append('image', file);
      body.append(
        'options',
        JSON.stringify({ rotation, crop, detailed: externalReader ? false : detailed }),
      );
      body.append('requestId', op.id);
      const result = await api<Result>(
        '/goods/invoice-images/read',
        'POST',
        body,
        op.controller.signal,
      );
      if (!op.reason && readOperation.current === op) load({ ...result, sourceKind: 'image' });
    } catch (e) {
      if (readOperation.current === op) {
        if (op.reason === 'user')
          setNotice('Lectura cancelada. Puedes volver a intentarlo o cerrar esta ventana.');
        else if (op.reason === 'timeout')
          setError(
            'Se agotó el tiempo de espera y se canceló la lectura. Puedes reintentar con la foto recortada.',
          );
        else if (e instanceof ApiError && e.code === 'OCR_BUSY')
          setError(
            'El lector está ocupado con otra imagen y tiene un tiempo límite. Puedes volver a intentarlo en unos segundos; no se registró ningún documento.',
          );
        else setError((e as Error).message);
      }
    } finally {
      if (op.timer) clearTimeout(op.timer);
      if (op.cancelPromise) await op.cancelPromise;
      if (readOperation.current === op) {
        readOperation.current = null;
        setBusy(false);
        setIsReading(false);
        setCancelling(false);
      }
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
    if (!header.purchaseDocumentType) {
      setError('Selecciona el tipo de documento antes de importar.');
      return;
    }
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
      controlNumber: header.purchaseDocumentType === 'delivery_note' ? null : header.controlNumber,
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
      subtitle={
        externalReader
          ? 'Facturas y notas de entrega · Interpretación visual con Gemini'
          : 'Facturas y notas de entrega · Lectura de documentos'
      }
      onClose={onClose}
      busy={busy}
    >
      <div className="invoice-import">
        <Feedback error={error || reader.error} notice={notice} />
        {reader.data && !reader.data.configured && (
          <div className="alert warning">
            Gemini aún no está conectado. El administrador debe configurar su cuenta en el servidor
            para habilitar la lectura. Puedes continuar registrando compras manualmente.
          </div>
        )}
        {reader.data?.configured && (
          <div className="invoice-reader-label">
            <span className="badge neutral">{reader.data.displayName}</span>
            <span>
              {externalReader
                ? 'La fotografía se enviará a Google Gemini para su interpretación.'
                : 'Lectura local configurada por el administrador.'}
            </span>
          </div>
        )}
        {externalReader && (
          <div className="invoice-reader-label">
            <Button
              onClick={() => void checkConnection()}
              disabled={checking || busy || !reader.data?.configured}
            >
              {checking ? 'Comprobando conexión…' : 'Comprobar conexión'}
            </Button>
            <span>
              Comprueba el acceso a Google sin enviar la fotografía ni generar contenido. Si Google
              está ocupado, realiza hasta dos reintentos dentro del tiempo de espera.
            </span>
          </div>
        )}
        {isReading && (
          <div className="ocr-progress">
            <div role="status" aria-live="polite">
              <strong>{cancelling ? 'Cancelando lectura…' : 'Leyendo documento…'}</strong>
              <span aria-live="off">
                {elapsed} s · Límite de espera: {waitSeconds} s
              </span>
              <progress aria-label="Lectura de documento en curso" />
              <small>
                Puedes detener la lectura y volver a intentarlo. Esta lectura no modifica el
                inventario.
                {externalReader &&
                  ' Si Google responde con un fallo temporal, se realizan hasta dos reintentos dentro de este mismo límite.'}
              </small>
            </div>
            <Button disabled={cancelling} onClick={() => stopReading('user')}>
              {cancelling ? 'Cancelando…' : 'Cancelar lectura'}
            </Button>
          </div>
        )}
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
                      setRotation(0);
                      setCrop(null);
                      setError('');
                    }}
                  />
                </label>
                <p className="form-hint">
                  Usa una foto nítida con los bordes del documento visibles.{' '}
                  {externalReader
                    ? 'Gemini interpreta encabezados, tablas y notas aunque cambie el diseño. Debes revisar los resultados antes de guardar.'
                    : 'El lector local procesa la foto en el servidor de la aplicación.'}
                </p>
                <div className="ocr-preparation">
                  {!externalReader && (
                    <label>
                      <input
                        type="checkbox"
                        checked={detailed}
                        onChange={(e) => setDetailed(e.target.checked)}
                        disabled={busy}
                      />
                      Lectura detallada para fotos difíciles
                    </label>
                  )}
                  <p>
                    Si aparece fondo alrededor del papel, arrastra sobre la vista previa para
                    seleccionar solo el documento.
                  </p>
                  <div>
                    <Button
                      disabled={busy || !file}
                      onClick={() => {
                        setRotation((r) => ((r + 90) % 360) as typeof rotation);
                        setCrop(null);
                      }}
                    >
                      Girar 90°
                    </Button>
                    <Button disabled={busy || !crop} onClick={() => setCrop(null)}>
                      Usar imagen completa
                    </Button>
                  </div>
                  {crop && (
                    <span className="badge neutral">
                      Área seleccionada: {Math.round(crop.width * 100)} % ×{' '}
                      {Math.round(crop.height * 100)} %
                    </span>
                  )}
                </div>
                <Button
                  variant="primary"
                  icon="search"
                  onClick={() => void read()}
                  disabled={busy || checking || !file || !reader.data?.configured || reader.loading}
                >
                  {busy ? 'Leyendo imagen…' : 'Leer imagen y preparar factura'}
                </Button>
              </div>
              <div className="invoice-preview">
                {preview ? (
                  <div
                    className="ocr-crop-frame"
                    style={{ touchAction: 'none' }}
                    onPointerDown={(e) => {
                      if (busy) return;
                      cropStart.current = cropPoint(e);
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }}
                    onPointerMove={(e) => {
                      if (!cropStart.current || busy) return;
                      const p = cropPoint(e),
                        a = cropStart.current;
                      setCrop({
                        x: Math.min(p.x, a.x),
                        y: Math.min(p.y, a.y),
                        width: Math.abs(p.x - a.x),
                        height: Math.abs(p.y - a.y),
                      });
                    }}
                    onPointerUp={() => {
                      cropStart.current = null;
                      setCrop((c) => (c && (c.width < 0.05 || c.height < 0.05) ? null : c));
                    }}
                    onPointerCancel={() => {
                      cropStart.current = null;
                      setCrop((c) => (c && (c.width < 0.05 || c.height < 0.05) ? null : c));
                    }}
                  >
                    <img draggable={false} src={preview} alt="Factura seleccionada para revisar" />
                    {crop && (
                      <span
                        className="ocr-crop-selection"
                        style={{
                          left: crop.x * 100 + '%',
                          top: crop.y * 100 + '%',
                          width: crop.width * 100 + '%',
                          height: crop.height * 100 + '%',
                        }}
                      />
                    )}
                  </div>
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
                    : result?.engine?.startsWith('gemini:')
                      ? 'Gemini · Revisión requerida'
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
                  Tipo de documento
                  <select
                    aria-label="Tipo de documento leído"
                    required
                    value={header.purchaseDocumentType}
                    onChange={(e) => {
                      field(
                        'purchaseDocumentType',
                        e.target.value as Header['purchaseDocumentType'],
                      );
                      if (e.target.value === 'delivery_note') field('controlNumber', '');
                    }}
                  >
                    <option value="">Revisar tipo</option>
                    <option value="invoice">Factura de compra</option>
                    <option value="delivery_note">Nota de entrega · No fiscal</option>
                  </select>
                </label>
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
                  {header.purchaseDocumentType === 'delivery_note'
                    ? 'Número de nota de entrega'
                    : 'Número de factura'}
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
                    required={header.purchaseDocumentType === 'invoice'}
                    disabled={header.purchaseDocumentType === 'delivery_note'}
                    placeholder={
                      header.purchaseDocumentType === 'delivery_note'
                        ? 'No aplica a nota de entrega'
                        : ''
                    }
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
                    required
                    value={header.currency}
                    onChange={(e) => {
                      field('currency', e.target.value as Header['currency']);
                      field('exchangeRate', e.target.value === 'VES' ? '1' : '');
                    }}
                  >
                    <option value="">Revisar moneda</option>
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
              {header.purchaseDocumentType === 'delivery_note' && (
                <div className="alert warning">
                  Nota de entrega: recepción no fiscal. No se inventará control fiscal ni crédito
                  fiscal. Revisa emisor, moneda y tratamiento de IVA antes de recibir.
                </div>
              )}
              <div className="ocr-tax-controls">
                <label>
                  IVA para todos
                  <select
                    aria-label="IVA para todos"
                    value={batchTax}
                    onChange={(e) => setBatchTax(e.target.value)}
                  >
                    <option value="">Seleccionar</option>
                    <option value="0">Exento / sin IVA</option>
                    <option value="8">8 %</option>
                    <option value="16">16 %</option>
                  </select>
                </label>
                <Button
                  disabled={!batchTax}
                  onClick={() => {
                    setRows((old) => old.map((r) => ({ ...r, taxRate: batchTax })));
                    setReviewed(false);
                  }}
                >
                  Aplicar IVA a los renglones
                </Button>
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
                              {r.sourceInfo && (
                                <small className="ocr-source-info">{r.sourceInfo}</small>
                              )}
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
                  {busy
                    ? 'Importando…'
                    : header.purchaseDocumentType === 'delivery_note'
                      ? 'Crear artículos y nota en borrador'
                      : 'Crear artículos y factura en borrador'}
                </Button>
              </div>
            </fieldset>
          </form>
        )}
      </div>
    </Dialog>
  );
}
