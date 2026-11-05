import { useEffect, useRef, useState } from 'react';
import Decimal from 'decimal.js';
import { useResource } from '../api';
import { Button, Dialog, Empty, Feedback, Icon, Pager } from '../components/ui';
import { money, type Api, type PageResult, type Product } from '../types';
import type { GoodsDocument, GoodsKind, Supplier } from '../goods-types';
type Line = {
  key: string;
  productId: string;
  sku: string;
  name: string;
  direction: 'entry' | 'exit';
  quantity: string;
  unitCost: string;
  discountPercent: string;
  taxRate: '0' | '8' | '16';
};
type Header = {
  documentDate: string;
  description: string;
  currency: 'USD' | 'VES';
  exchangeRate: string;
  invoiceNumber: string;
  controlNumber: string;
  paymentTerms: 'cash' | 'credit';
  dueDate: string;
};
const today = () =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const blank = (): Header => ({
  documentDate: today(),
  description: '',
  currency: 'VES',
  exchangeRate: '1',
  invoiceNumber: '',
  controlNumber: '',
  paymentTerms: 'cash',
  dueDate: '',
});
const decimal = (s: string) => s.replace(',', '.');
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
function totals(lines: Line[], kind: GoodsKind) {
  let subtotal = new Decimal(0),
    discount = new Decimal(0),
    tax = new Decimal(0);
  const amounts = lines.map((l) => {
    try {
      const gross = new Decimal(l.quantity).mul(l.unitCost).toDecimalPlaces(2);
      const reduction = gross.mul(l.discountPercent).div(100).toDecimalPlaces(2);
      const iva = gross.minus(reduction).mul(l.taxRate).div(100).toDecimalPlaces(2);
      const sign = kind === 'adjustment' && l.direction === 'exit' ? -1 : 1;
      subtotal = subtotal.plus(gross.mul(sign));
      discount = discount.plus(reduction.mul(sign));
      tax = tax.plus(iva.mul(sign));
      return gross.minus(reduction).plus(iva).toFixed(2);
    } catch {
      return '—';
    }
  });
  return {
    subtotal: subtotal.toFixed(2),
    discount: discount.toFixed(2),
    tax: tax.toFixed(2),
    total: subtotal.minus(discount).plus(tax).toFixed(2),
    amounts,
  };
}
export function GoodsDocuments({
  api,
  scope,
  branch,
  kind,
  visible,
  admin,
  rate,
  revision,
  onChanged,
  onDirty,
  onBusy,
  pending,
  onConsumed,
}: {
  api: Api;
  scope: string;
  branch: string;
  kind: GoodsKind;
  visible: boolean;
  admin: boolean;
  rate: string;
  revision: number;
  onChanged: () => void;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
  pending: { product: Product; event: string } | null;
  onConsumed: () => void;
}) {
  const [view, setView] = useState<'list' | 'form'>('list');
  const [document, setDocument] = useState<GoodsDocument | null>(null);
  const [header, setHeader] = useState<Header>(blank);
  const [lines, setLines] = useState<Line[]>([]);
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [itemSearch, setItemSearch] = useState('');
  const [supplierSearch, setSupplierSearch] = useState('');
  const [supplierOpen, setSupplierOpen] = useState(false);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const itemRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const confirmed = document?.status === 'confirmed';
  const purchase = kind === 'purchase';
  const list = useResource<PageResult<GoodsDocument>>(
    [scope, kind, revision, search, page, 'documents'].join(':'),
    (s) =>
      api(
        `/goods/documents?branchId=${branch}&kind=${kind}&search=${encodeURIComponent(search)}&offset=${page * 20}`,
        'GET',
        undefined,
        s,
      ),
    visible && admin && !!branch,
  );
  const items = useResource<PageResult<Product>>(
    [scope, kind, itemSearch, revision, 'items'].join(':'),
    (s) =>
      api(
        '/inventory/stock?branchId=' +
          branch +
          '&search=' +
          encodeURIComponent(itemSearch) +
          '&limit=8',
        'GET',
        undefined,
        s,
      ),
    visible && view === 'form' && !confirmed && !!itemSearch && !!branch,
  );
  const suppliers = useResource<Supplier[]>(
    scope + kind + supplierSearch + revision + 'suppliers',
    (s) =>
      api('/goods/suppliers?search=' + encodeURIComponent(supplierSearch), 'GET', undefined, s),
    visible && purchase && view === 'form' && !confirmed,
  );
  const sums = totals(lines, kind);
  const currency = header.currency === 'VES' ? 'Bs' : 'USD';
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty]);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy]);
  useEffect(() => {
    if (pending) {
      newDocument(pending.product);
      onConsumed();
    }
  }, [pending]);
  useEffect(() => {
    if (!visible || view !== 'form' || confirmed) return;
    const key = (e: KeyboardEvent) => {
      if (window.document.querySelector('dialog[open]')) return;
      if (e.key === 'F2') {
        e.preventDefault();
        itemRef.current?.focus();
      }
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        if (!busy) formRef.current?.requestSubmit();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [visible, view, confirmed, busy]);
  function newDocument(initial?: Product) {
    if (dirty && !window.confirm('¿Descartar los cambios sin guardar de este documento?')) return;
    setDocument(null);
    setHeader(blank());
    setSupplier(null);
    setLines(initial ? [makeLine(initial, blank())] : []);
    setView('form');
    setDirty(!!initial);
    setError('');
    setNotice('');
    attempt.current = null;
    setItemSearch('');
    setSupplierSearch('');
  }
  function makeLine(product: Product, context: Header = header): Line {
    let cost = '0';
    if (product.average_cost_base)
      try {
        cost = new Decimal(product.average_cost_base)
          .div(context.currency === 'VES' ? '1' : context.exchangeRate || '1')
          .toFixed(6);
      } catch {}
    return {
      key: crypto.randomUUID(),
      productId: product.id,
      sku: product.sku,
      name: product.name,
      direction: 'entry',
      quantity: '1',
      unitCost: cost,
      discountPercent: '0',
      taxRate: purchase
        ? product.tax_category === 'general'
          ? '16'
          : product.tax_category === 'reduced'
            ? '8'
            : '0'
        : '0',
    };
  }
  function add(product: Product) {
    if (lines.some((l) => l.productId === product.id)) {
      setError(
        'El artículo ya está en el documento. Modifica su cantidad en el renglón existente.',
      );
      return;
    }
    if (lines.length >= 100) {
      setError('El documento admite hasta 100 renglones.');
      return;
    }
    setLines((prev) => [...prev, makeLine(product)]);
    setDirty(true);
    setItemSearch('');
    setError('');
    itemRef.current?.focus();
  }
  function changeHeader<K extends keyof Header>(key: K, value: Header[K]) {
    setHeader((h) => ({ ...h, [key]: value }));
    setDirty(true);
    setNotice('');
  }
  function changeLine(index: number, key: keyof Line, value: string) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, [key]: value } : line)));
    setDirty(true);
    setNotice('');
  }
  function hydrate(d: GoodsDocument) {
    setDocument(d);
    setHeader({
      documentDate: d.document_date,
      description: d.description,
      currency: d.currency,
      exchangeRate: new Decimal(d.exchange_rate).toString(),
      invoiceNumber: d.invoice_number ?? '',
      controlNumber: d.control_number ?? '',
      paymentTerms: d.payment_terms ?? 'cash',
      dueDate: d.due_date ?? '',
    });
    setSupplier(
      d.supplier_id
        ? { id: d.supplier_id, name: d.supplier_name ?? '', rif: d.supplier_rif ?? '' }
        : null,
    );
    setLines(
      d.lines.map((l) => ({
        key: l.id,
        productId: l.product_id,
        sku: l.sku,
        name: l.name,
        direction: l.direction,
        quantity: new Decimal(l.quantity).toString(),
        unitCost: new Decimal(l.unit_cost).toString(),
        discountPercent: new Decimal(l.discount_percent).toString(),
        taxRate: String(Number(l.tax_rate)) as Line['taxRate'],
      })),
    );
    setDirty(false);
    setView('form');
    setItemSearch('');
    setSupplierSearch('');
  }
  async function open(id: string) {
    if (
      dirty &&
      !window.confirm('¿Descartar los cambios sin guardar antes de abrir otro documento?')
    )
      return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      hydrate(await api<GoodsDocument>('/goods/documents/' + id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setError('');
    setNotice('');
    if (!lines.length) {
      setError('Agrega al menos un artículo.');
      return;
    }
    if (purchase && !supplier) {
      setError('Selecciona o registra un proveedor.');
      return;
    }
    const body = {
      kind,
      branchId: branch,
      documentDate: header.documentDate,
      description: header.description,
      currency: header.currency,
      exchangeRate: header.currency === 'VES' ? '1' : decimal(header.exchangeRate),
      supplierId: purchase ? (supplier?.id ?? null) : null,
      invoiceNumber: purchase ? header.invoiceNumber : null,
      controlNumber: purchase ? header.controlNumber : null,
      paymentTerms: purchase ? header.paymentTerms : null,
      dueDate: purchase && header.dueDate ? header.dueDate : null,
      lines: lines.map((l) => ({
        productId: l.productId,
        direction: purchase ? 'entry' : l.direction,
        quantity: decimal(l.quantity),
        unitCost: decimal(l.unitCost),
        discountPercent: purchase ? decimal(l.discountPercent) : '0',
        taxRate: purchase ? l.taxRate : '0',
      })),
    };
    const signature = JSON.stringify(body);
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    try {
      const d = await api<GoodsDocument>(
        document ? '/goods/documents/' + document.id : '/goods/documents',
        document ? 'PATCH' : 'POST',
        document
          ? { ...body, expectedVersion: document.version }
          : { ...body, idempotencyKey: attempt.current.key },
      );
      hydrate(d);
      setNotice('Borrador guardado. Las existencias no han cambiado.');
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!document || dirty) return;
    if (
      !window.confirm(
        purchase
          ? '¿Confirmar la factura y recibir todos sus artículos en la sucursal seleccionada?'
          : '¿Confirmar todas las entradas y salidas de este ajuste?',
      )
    )
      return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const d = await api<GoodsDocument>('/goods/documents/' + document.id + '/confirm', 'POST', {
        expectedVersion: document.version,
      });
      hydrate(d);
      setNotice(
        d.replayed
          ? 'Este documento ya estaba confirmado; no se duplicaron movimientos.'
          : 'Documento confirmado. Las existencias fueron actualizadas.',
      );
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!admin)
    return (
      <div hidden={!visible}>
        <Empty
          title="Acceso de administrador"
          description="Solicita al administrador el registro de compras o ajustes de mercancía."
        />
      </div>
    );
  return (
    <div hidden={!visible} className="goods-workspace">
      <div className="page-heading">
        <div>
          <span className="overline">
            {purchase ? 'COMPRAS / MERCANCÍA' : 'INVENTARIO / DOCUMENTOS'}
          </span>
          <h1>{purchase ? 'Facturas de compra' : 'Ajustes de entrada y salida'}</h1>
          <p>
            {purchase
              ? 'Registra la factura del proveedor y confirma la recepción de mercancía.'
              : 'Documenta entradas y salidas, con varios artículos en una misma operación.'}
          </p>
        </div>
        <Button
          icon="plus"
          variant="primary"
          onClick={() => newDocument()}
          disabled={busy || !branch}
        >
          {purchase ? 'Nueva factura de compra' : 'Nuevo ajuste'}
        </Button>
      </div>
      <Feedback error={error || list.error} notice={notice} />
      <section className="panel">
        <div className="document-tabs" role="tablist" aria-label="Vista del documento">
          <button role="tab" aria-selected={view === 'list'} onClick={() => setView('list')}>
            Lista
          </button>
          <button
            role="tab"
            aria-selected={view === 'form'}
            onClick={() => setView('form')}
            disabled={!document && !lines.length && !dirty && view !== 'form'}
          >
            Generales {document?.display_number && <span>{document.display_number}</span>}
          </button>
          <span className={'badge ' + (confirmed ? 'green' : 'amber')}>
            {view === 'form' ? (confirmed ? 'Confirmado' : 'Borrador') : 'Consulta de documentos'}
          </span>
        </div>
        {view === 'list' ? (
          <>
            <div className="filter-bar">
              <div className="search-field">
                <Icon name="search" />
                <input
                  aria-label="Buscar documentos de mercancía"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(0);
                  }}
                  maxLength={120}
                  placeholder={
                    purchase
                      ? 'Número interno, factura, descripción o proveedor…'
                      : 'Número de ajuste o descripción…'
                  }
                />
              </div>
              <Button icon="refresh" onClick={onChanged}>
                Actualizar
              </Button>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Número interno</th>
                    <th>Fecha</th>
                    <th>{purchase ? 'Proveedor / descripción' : 'Descripción'}</th>
                    {purchase && <th>N.º factura</th>}
                    <th className="right">Total declarado</th>
                    <th>Estado</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {list.data?.items.map((d) => (
                    <tr key={d.id} className="selectable" onDoubleClick={() => void open(d.id)}>
                      <td className="code">{d.display_number}</td>
                      <td>{d.document_date}</td>
                      <td>
                        <strong>{purchase ? d.supplier_name : d.description}</strong>
                        {purchase && <small>{d.description}</small>}
                      </td>
                      {purchase && <td>{d.invoice_number}</td>}
                      <td className="right number">
                        {d.currency === 'VES' ? 'Bs' : 'USD'} {money(d.total)}
                      </td>
                      <td>
                        <span className={'badge ' + (d.status === 'confirmed' ? 'green' : 'amber')}>
                          {d.status === 'confirmed' ? 'Confirmado' : 'Borrador'}
                        </span>
                      </td>
                      <td>
                        <Button onClick={() => void open(d.id)} disabled={busy}>
                          Abrir
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {list.loading ? (
                <div className="loading">Consultando documentos…</div>
              ) : (
                !list.data?.items.length && (
                  <Empty
                    title={purchase ? 'No hay facturas registradas' : 'No hay ajustes registrados'}
                    description="Crea un documento, guárdalo como borrador y confírmalo cuando hayas revisado sus renglones."
                    icon="file"
                  />
                )
              )}
            </div>
            <Pager page={page} total={list.data?.total ?? 0} onChange={setPage} />
          </>
        ) : (
          <form
            ref={formRef}
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="ribbon">
              <div className="ribbon-group">
                <Button
                  type="submit"
                  icon="check"
                  variant="primary"
                  disabled={busy || confirmed || (!dirty && !!document)}
                >
                  Guardar borrador
                </Button>
                <Button
                  icon="arrows"
                  onClick={() => void confirm()}
                  disabled={busy || !document || dirty || confirmed}
                >
                  {purchase ? 'Confirmar y recibir' : 'Confirmar ajuste'}
                </Button>
                {document && dirty && (
                  <Button
                    onClick={() => {
                      hydrate(document);
                      setError('');
                    }}
                  >
                    Descartar cambios
                  </Button>
                )}
              </div>
              <span className="muted">
                {confirmed
                  ? 'Documento protegido contra modificaciones'
                  : dirty
                    ? 'Cambios sin guardar'
                    : 'Ctrl + S · Guardar'}
              </span>
            </div>
            <fieldset disabled={busy || confirmed}>
              <div className="goods-header">
                <label>
                  Número interno
                  <input readOnly value={document?.display_number ?? 'Se asigna al guardar'} />
                </label>
                <label>
                  Fecha
                  <input
                    type="date"
                    required
                    value={header.documentDate}
                    onChange={(e) => changeHeader('documentDate', e.target.value)}
                  />
                </label>
                <label>
                  Moneda
                  <select
                    aria-label="Moneda"
                    value={header.currency}
                    onChange={(e) => {
                      changeHeader('currency', e.target.value as Header['currency']);
                      changeHeader(
                        'exchangeRate',
                        e.target.value === 'VES' ? '1' : Number(rate) > 0 ? rate : '',
                      );
                    }}
                  >
                    <option value="VES">Bolívares (Bs)</option>
                    <option value="USD">Dólares (USD)</option>
                  </select>
                </label>
                <label>
                  Tasa Bs / USD
                  <input
                    inputMode="decimal"
                    readOnly={header.currency === 'VES'}
                    required
                    value={header.exchangeRate}
                    onChange={(e) => changeHeader('exchangeRate', decimal(e.target.value))}
                  />
                </label>
                <label className="goods-description">
                  Descripción
                  <input
                    required
                    minLength={3}
                    maxLength={500}
                    value={header.description}
                    onChange={(e) => changeHeader('description', e.target.value)}
                    placeholder={
                      purchase
                        ? 'Descripción de la compra'
                        : 'Ej. Inventario inicial, ajuste de conteo o salida de mercancía'
                    }
                  />
                </label>
              </div>
              {purchase && (
                <div className="purchase-header">
                  <div className="supplier-field">
                    <label>
                      Proveedor seleccionado
                      <input
                        aria-label="Proveedor seleccionado"
                        readOnly
                        value={supplier ? `${supplier.rif} · ${supplier.name}` : ''}
                        placeholder="Selecciona o registra un proveedor"
                      />
                    </label>
                    {!confirmed && (
                      <>
                        <div className="supplier-search">
                          <input
                            aria-label="Buscar proveedor"
                            placeholder="Buscar proveedor por RIF o nombre"
                            value={supplierSearch}
                            maxLength={120}
                            onChange={(e) => setSupplierSearch(e.target.value)}
                          />
                          <Button icon="plus" onClick={() => setSupplierOpen(true)}>
                            Nuevo proveedor
                          </Button>
                        </div>
                        <div className="supplier-options">
                          {suppliers.data?.map((s) => (
                            <button
                              type="button"
                              key={s.id}
                              className={supplier?.id === s.id ? 'chosen' : ''}
                              onClick={() => {
                                setSupplier(s);
                                setDirty(true);
                              }}
                            >
                              {s.rif} · {s.name}
                            </button>
                          ))}
                          {suppliers.error && <p role="alert">{suppliers.error}</p>}
                          {!suppliers.loading && !suppliers.data?.length && (
                            <small>
                              No hay proveedores en esta búsqueda. Puedes registrar uno nuevo.
                            </small>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="purchase-fields">
                    <label>
                      N.º factura del proveedor
                      <input
                        required
                        value={header.invoiceNumber}
                        maxLength={80}
                        onChange={(e) => changeHeader('invoiceNumber', e.target.value)}
                      />
                    </label>
                    <label>
                      N.º control
                      <input
                        required
                        value={header.controlNumber}
                        maxLength={80}
                        onChange={(e) => changeHeader('controlNumber', e.target.value)}
                      />
                    </label>
                    <label>
                      Condición de pago
                      <select
                        value={header.paymentTerms}
                        onChange={(e) =>
                          changeHeader('paymentTerms', e.target.value as Header['paymentTerms'])
                        }
                      >
                        <option value="cash">Contado</option>
                        <option value="credit">Crédito</option>
                      </select>
                    </label>
                    <label>
                      Vencimiento
                      <input
                        type="date"
                        required={header.paymentTerms === 'credit'}
                        min={header.documentDate}
                        value={header.dueDate}
                        onChange={(e) => changeHeader('dueDate', e.target.value)}
                      />
                    </label>
                  </div>
                </div>
              )}
              {!confirmed && (
                <div className="product-search">
                  <label>Agregar artículo · F2</label>
                  <div className="search-field">
                    <Icon name="search" />
                    <input
                      ref={itemRef}
                      aria-label="Buscar artículo para documento"
                      value={itemSearch}
                      maxLength={120}
                      onChange={(e) => setItemSearch(e.target.value)}
                      placeholder="Código, código de barras o descripción…"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          if (items.data?.items.length === 1) add(items.data.items[0]);
                        }
                      }}
                    />
                    <kbd>F2</kbd>
                  </div>
                  {itemSearch && (
                    <div className="search-results">
                      {items.loading ? (
                        <p>Buscando…</p>
                      ) : items.error ? (
                        <p role="alert">{items.error}</p>
                      ) : items.data?.items.length ? (
                        items.data.items.map((p) => (
                          <button type="button" key={p.id} onClick={() => add(p)}>
                            <span>
                              <strong>
                                {p.sku} · {p.name}
                              </strong>
                              <small>Existencia: {p.quantity ?? '0'} UNI</small>
                            </span>
                            <Icon name="plus" size={15} />
                          </button>
                        ))
                      ) : (
                        <p>No hay coincidencias.</p>
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className="table-scroll">
                <table className="goods-lines">
                  <thead>
                    <tr>
                      <th>Reng.</th>
                      {!purchase && <th>Tipo</th>}
                      <th>Artículo</th>
                      <th>Unidad</th>
                      <th className="right">Cantidad</th>
                      <th className="right">Costo unit. {currency}</th>
                      {purchase && (
                        <>
                          <th>% Desc.</th>
                          <th>IVA %</th>
                        </>
                      )}
                      <th className="right">Total {currency}</th>
                      {confirmed && <th>Costo aplicado Bs</th>}
                      {!confirmed && <th></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={l.key}>
                        <td>{i + 1}</td>
                        {!purchase && (
                          <td>
                            <select
                              aria-label={'Tipo del renglón ' + (i + 1)}
                              value={l.direction}
                              onChange={(e) => changeLine(i, 'direction', e.target.value)}
                            >
                              <option value="entry">Entrada</option>
                              <option value="exit">Salida</option>
                            </select>
                          </td>
                        )}
                        <td>
                          <strong>{l.name}</strong>
                          <small>{l.sku}</small>
                        </td>
                        <td>UNI</td>
                        <td>
                          <input
                            aria-label={'Cantidad del renglón ' + (i + 1)}
                            inputMode="decimal"
                            required
                            value={l.quantity}
                            onChange={(e) => changeLine(i, 'quantity', decimal(e.target.value))}
                          />
                        </td>
                        <td>
                          <input
                            aria-label={'Costo del renglón ' + (i + 1)}
                            inputMode="decimal"
                            required
                            value={l.unitCost}
                            onChange={(e) => changeLine(i, 'unitCost', decimal(e.target.value))}
                          />
                        </td>
                        {purchase && (
                          <>
                            <td>
                              <input
                                aria-label={'Descuento del renglón ' + (i + 1)}
                                inputMode="decimal"
                                required
                                value={l.discountPercent}
                                onChange={(e) =>
                                  changeLine(i, 'discountPercent', decimal(e.target.value))
                                }
                              />
                            </td>
                            <td>
                              <select
                                aria-label={'IVA del renglón ' + (i + 1)}
                                value={l.taxRate}
                                onChange={(e) => changeLine(i, 'taxRate', e.target.value)}
                              >
                                <option value="0">Exento</option>
                                <option value="8">8 %</option>
                                <option value="16">16 %</option>
                              </select>
                            </td>
                          </>
                        )}
                        <td className="right number">
                          {sums.amounts[i] === '—' ? '—' : money(sums.amounts[i]!)}
                        </td>
                        {confirmed && (
                          <td className="right number">
                            {document?.lines[i]?.applied_cost_base == null
                              ? 'Sin costo conocido'
                              : money(document.lines[i]!.applied_cost_base!)}
                          </td>
                        )}
                        {!confirmed && (
                          <td>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={'Quitar renglón ' + (i + 1)}
                              onClick={() => {
                                setLines((rows) => rows.filter((_, index) => index !== i));
                                setDirty(true);
                              }}
                            >
                              <Icon name="close" size={16} />
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!lines.length && (
                  <Empty
                    title="Agrega los artículos del documento"
                    description="Las cantidades se introducen en positivo. En ajustes, el tipo Entrada o Salida determina el movimiento."
                    icon="box"
                  />
                )}
              </div>
            </fieldset>
            <div className="goods-footer">
              <div>
                <p>
                  <Icon name="shield" size={16} />
                  {confirmed
                    ? 'Confirmado: sus movimientos ya forman parte del inventario.'
                    : 'Guardar no afecta el inventario. Revisa los datos antes de confirmar.'}
                </p>
                <small>
                  {purchase
                    ? 'Esta recepción registra costos e IVA de compra. La condición de pago es informativa; no registra un cobro o pago bancario.'
                    : 'Un mismo ajuste puede tener entradas y salidas de artículos distintos. Los costos declarados no cambian precios de venta.'}
                </small>
                <small>
                  Se trabaja con la unidad base UNI y la sucursal seleccionada; esta versión no
                  convierte cajas, blísteres ni maneja almacenes internos separados.
                </small>
                {confirmed && (
                  <small>
                    Valoración de inventario:{' '}
                    {document?.inventory_value_base == null
                      ? 'No disponible: hay existencias previas sin costo conocido.'
                      : `Bs ${money(document.inventory_value_base)}`}
                  </small>
                )}
              </div>
              <dl>
                <div>
                  <dt>Subtotal</dt>
                  <dd>
                    {currency} {money(sums.subtotal)}
                  </dd>
                </div>
                {purchase && (
                  <>
                    <div>
                      <dt>Descuentos</dt>
                      <dd>
                        {currency} {money(sums.discount)}
                      </dd>
                    </div>
                    <div>
                      <dt>IVA</dt>
                      <dd>
                        {currency} {money(sums.tax)}
                      </dd>
                    </div>
                  </>
                )}
                <div className="goods-total">
                  <dt>{purchase ? 'Total factura' : 'Costo declarado neto'}</dt>
                  <dd>
                    {currency} {money(sums.total)}
                  </dd>
                </div>
              </dl>
            </div>
          </form>
        )}
      </section>
      {supplierOpen && (
        <SupplierEditor
          api={api}
          onClose={() => setSupplierOpen(false)}
          onCreated={(s) => {
            setSupplier(s);
            setSupplierOpen(false);
            setDirty(true);
            onChanged();
          }}
        />
      )}
    </div>
  );
}
function SupplierEditor({
  api,
  onClose,
  onCreated,
}: {
  api: Api;
  onClose: () => void;
  onCreated: (s: Supplier) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog
      title="Nuevo proveedor"
      subtitle="Datos del emisor de la factura de compra"
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError('');
          void api<Supplier>('/goods/suppliers', 'POST', { rif: f.get('rif'), name: f.get('name') })
            .then(onCreated)
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <fieldset disabled={busy}>
          <div className="form-content">
            <Feedback error={error} />
            <label>
              RIF del proveedor
              <input name="rif" autoFocus required maxLength={20} placeholder="J-12345678-9" />
            </label>
            <label>
              Razón social del proveedor
              <input name="name" required minLength={2} maxLength={200} />
            </label>
          </div>
          <footer className="dialog-footer">
            <Button onClick={onClose}>Cancelar</Button>
            <Button type="submit" variant="primary">
              Registrar proveedor
            </Button>
          </footer>
        </fieldset>
      </form>
    </Dialog>
  );
}
