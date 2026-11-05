import { useEffect, useRef, useState } from 'react';
import { useResource } from '../api';
import { Button, Empty, Feedback, Icon } from '../components/ui';
import { money, quantity, type Api, type Product, type Quote } from '../types';
export function Quotation({
  api,
  scope,
  visible,
  company,
  branchName,
  rate,
  pending,
  onConsumed,
  onDirty,
  onBusy,
  revision,
}: {
  api: Api;
  scope: string;
  visible: boolean;
  company: string;
  branchName: string;
  rate: string;
  pending: { product: Product; event: string } | null;
  onConsumed: () => void;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
  revision: number;
}) {
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<{ product: Product; quantity: string }[]>([]);
  const [client, setClient] = useState('');
  const [eligible, setEligible] = useState('0');
  const [other, setOther] = useState('0');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const found = useResource<Product[]>(
    scope + ':quote:' + search + ':' + revision,
    (s) => api('/products?limit=8&search=' + encodeURIComponent(search), 'GET', undefined, s),
    visible && !!search,
  );
  function add(product: Product) {
    setCart((rows) =>
      rows.some((l) => l.product.id === product.id)
        ? rows.map((l) =>
            l.product.id === product.id ? { ...l, quantity: String(Number(l.quantity) + 1) } : l,
          )
        : [...rows, { product, quantity: '1' }],
    );
    setSearch('');
    searchRef.current?.focus();
  }
  useEffect(() => {
    if (pending) {
      add(pending.product);
      onConsumed();
    }
  }, [pending]);
  useEffect(() => {
    setQuote(null);
  }, [cart, rate, eligible, other, revision]);
  useEffect(() => {
    onDirty(cart.length > 0 || client.trim().length > 0);
    return () => onDirty(false);
  }, [cart.length, client]);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy]);
  useEffect(() => {
    if (!visible) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        if (!busy) formRef.current?.requestSubmit();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [visible, busy]);
  function reset() {
    if (cart.length && !window.confirm('¿Descartar el contenido de esta cotización?')) return;
    setCart([]);
    setClient('');
    setEligible('0');
    setOther('0');
    setQuote(null);
    setError('');
  }
  return (
    <div hidden={!visible} className="quotation-page">
      <div className="page-heading">
        <div>
          <span className="overline">COMERCIAL / DOCUMENTOS</span>
          <h1>Cotizaciones</h1>
          <p>Prepara una propuesta con precios vigentes y distribución de pagos.</p>
        </div>
        <span className="badge amber">
          <Icon name="file" size={14} /> Documento sin emitir
        </span>
      </div>
      <Feedback error={error} />
      <div className="quote-layout">
        <section className="panel document-panel">
          <div className="ribbon">
            <div className="ribbon-group">
              <Button icon="plus" onClick={reset} disabled={busy}>
                Nueva cotización
              </Button>
              <Button icon="print" disabled={!quote || busy} onClick={() => window.print()}>
                Imprimir cotización
              </Button>
            </div>
            <span className="muted">Ctrl + Enter · Calcular</span>
          </div>
          <fieldset disabled={busy}>
            <div className="document-header">
              <div>
                <span className="overline">DOCUMENTO COMERCIAL</span>
                <h2>Cotización de productos</h2>
              </div>
              <span className="badge neutral">{quote ? 'Calculada' : 'Borrador'}</span>
            </div>
            <div className="document-fields">
              <label>
                Cliente / razón social
                <input
                  value={client}
                  onChange={(e) => setClient(e.target.value)}
                  maxLength={180}
                  placeholder="Nombre del cliente (opcional)"
                />
              </label>
              <div className="document-date">
                <span>Fecha de elaboración</span>
                <strong>
                  {new Intl.DateTimeFormat('es-VE', {
                    dateStyle: 'medium',
                    timeZone: 'America/Caracas',
                  }).format(new Date())}
                </strong>
              </div>
            </div>
            <div className="product-search">
              <label>Agregar artículo · código, código de barras o descripción</label>
              <div className="search-field">
                <Icon name="search" />
                <input
                  ref={searchRef}
                  aria-label="Buscar artículo para cotizar"
                  value={search}
                  maxLength={120}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Escribe para buscar o escanea un código…"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && found.data?.length === 1) {
                      e.preventDefault();
                      add(found.data[0]);
                    }
                  }}
                />
                <kbd>F2</kbd>
              </div>
              {search && (
                <div className="search-results">
                  {found.loading ? (
                    <p>Buscando artículos…</p>
                  ) : found.error ? (
                    <p role="alert">{found.error}</p>
                  ) : found.data?.length ? (
                    found.data.map((p) => (
                      <button key={p.id} disabled={p.price_pending} onClick={() => add(p)}>
                        <span>
                          <strong>{p.name}</strong>
                          <small>
                            {p.sku} · {p.barcode || 'Sin código de barras'}
                          </small>
                        </span>
                        <span className="number">
                          {p.price_pending ? 'Precio pendiente' : '$ ' + money(p.price_usd)}{' '}
                          <Icon name="plus" size={15} />
                        </span>
                      </button>
                    ))
                  ) : (
                    <p>No hay coincidencias. Prueba otra descripción o código.</p>
                  )}
                </div>
              )}
            </div>
            <div className="table-scroll">
              <table className="document-table">
                <thead>
                  <tr>
                    <th>Artículo</th>
                    <th className="right">Cantidad</th>
                    <th className="right">P. unit. USD</th>
                    <th className="right">Total Bs</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {cart.map((l, index) => (
                    <tr key={l.product.id}>
                      <td>
                        <strong>{l.product.name}</strong>
                        <small>{l.product.sku}</small>
                      </td>
                      <td className="right">
                        <input
                          className="quantity-input"
                          aria-label={'Cantidad de ' + l.product.name}
                          value={l.quantity}
                          inputMode="decimal"
                          onChange={(e) =>
                            setCart((rows) =>
                              rows.map((row, i) =>
                                i === index
                                  ? { ...row, quantity: e.target.value.replace(',', '.') }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="right number">
                        {money(quote?.lines[index]?.priceUsd ?? l.product.price_usd)}
                        <small>Sin IVA</small>
                      </td>
                      <td className="right number">
                        {quote?.lines[index] ? money(quote.lines[index].total) : '—'}
                        <small>Con IVA</small>
                      </td>
                      <td>
                        <button
                          className="icon-button"
                          aria-label={'Quitar ' + l.product.name}
                          onClick={() => setCart((rows) => rows.filter((_, i) => i !== index))}
                        >
                          <Icon name="close" size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!cart.length && (
                <Empty
                  title="Comienza agregando un artículo"
                  description="Busca por código o descripción. También puedes seleccionar un artículo desde Inventario."
                  icon="file"
                />
              )}
            </div>
            <div className="document-bottom">
              <Icon name="help" size={16} />
              <span>
                Precios e impuestos confirmados por el servidor al calcular. Este borrador no
                reserva inventario ni registra una venta.
              </span>
            </div>
          </fieldset>
        </section>
        <section className="panel settlement-panel">
          <div className="panel-header">
            <div>
              <h2>Resumen y distribución</h2>
              <p>{cart.length} referencias en el documento</p>
            </div>
            <Icon name="wallet" />
          </div>
          <form
            ref={formRef}
            onSubmit={(e) => {
              e.preventDefault();
              if (!cart.length) return;
              setBusy(true);
              setError('');
              setQuote(null);
              void api<Quote>('/quotes/preview', 'POST', {
                rate,
                lines: cart.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
                payments: [
                  { principalUsd: other.replace(',', '.'), eligibleForIgtf: false },
                  { principalUsd: eligible.replace(',', '.'), eligibleForIgtf: true },
                ],
              })
                .then(setQuote)
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <fieldset disabled={busy}>
              <div className="settlement-body">
                <div className="rate-summary">
                  <span>Tasa manual aplicada</span>
                  <strong>
                    {Number(rate) > 0
                      ? `Bs ${money(rate)} / USD`
                      : 'Ingresa una tasa en la barra superior'}
                  </strong>
                </div>
                <div className="form-section-label">PRINCIPAL APLICADO · USD</div>
                <label>
                  Principal no gravado por IGTF
                  <input
                    inputMode="decimal"
                    value={other}
                    onChange={(e) => setOther(e.target.value)}
                    required
                  />
                </label>
                <label>
                  Principal elegible para IGTF al 3 %
                  <input
                    inputMode="decimal"
                    value={eligible}
                    onChange={(e) => setEligible(e.target.value)}
                    required
                  />
                </label>
                <p className="form-hint">
                  Los importes corresponden a la compra con IVA, sin incluir el IGTF adicional. La
                  elegibilidad es declarada para esta simulación.
                </p>
                <Button
                  type="submit"
                  variant="primary"
                  icon="chart"
                  disabled={!cart.length || !Number(rate) || busy}
                >
                  {busy ? 'Calculando…' : 'Calcular cotización'}
                </Button>
                {quote && (
                  <div className="totals" aria-live="polite">
                    <p>
                      Compra con IVA<strong>Bs {money(quote.purchaseTotalBase)}</strong>
                    </p>
                    <p>
                      Equivalente en USD<strong>$ {money(quote.purchaseTotalUsd)}</strong>
                    </p>
                    <p>
                      IGTF simulado<strong>Bs {money(quote.igtfTotalBase)}</strong>
                    </p>
                    <p className="grand-total">
                      Total del documento<strong>Bs {money(quote.dueTotalBase)}</strong>
                    </p>
                    <p>
                      Principal pendiente<strong>Bs {money(quote.remainingPrincipalBase)}</strong>
                    </p>
                  </div>
                )}
              </div>
            </fieldset>
          </form>
          <div className="document-disclaimer">
            <Icon name="shield" size={17} />
            <div>
              <strong>Cotización de prueba</strong>
              <p>
                No es una factura fiscal ni un comprobante de cobro. La tasa es manual; la
                aplicabilidad tributaria debe verificarse antes de facturar.
              </p>
            </div>
          </div>
        </section>
      </div>
      {quote && (
        <section className="print-document">
          <header>
            <div>
              <h1>{company}</h1>
              <p>Sucursal: {branchName}</p>
            </div>
            <strong>
              COTIZACIÓN
              <br />
              NO ES FACTURA FISCAL
            </strong>
          </header>
          <p>Cliente: {client || 'No especificado'}</p>
          <p>
            Fecha:{' '}
            {new Intl.DateTimeFormat('es-VE', {
              dateStyle: 'long',
              timeZone: 'America/Caracas',
            }).format(new Date())}{' '}
            · Tasa manual: Bs {money(rate)} / USD
          </p>
          <table>
            <thead>
              <tr>
                <th>Código</th>
                <th>Descripción</th>
                <th>Cantidad</th>
                <th>Base Bs</th>
                <th>IVA Bs</th>
                <th>Total Bs</th>
              </tr>
            </thead>
            <tbody>
              {quote.lines.map((l, index) => (
                <tr key={l.productId + index}>
                  <td>{l.sku}</td>
                  <td>{l.name}</td>
                  <td>{quantity(l.quantity)}</td>
                  <td>{money(l.base)}</td>
                  <td>{money(l.vat)}</td>
                  <td>{money(l.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="print-totals">
            <p>Compra con IVA: Bs {money(quote.purchaseTotalBase)}</p>
            <p>IGTF simulado: Bs {money(quote.igtfTotalBase)}</p>
            <strong>Total: Bs {money(quote.dueTotalBase)}</strong>
          </div>
          <p>
            Documento de referencia. No acredita pago, no reserva mercancía y no sustituye una
            factura fiscal.
          </p>
        </section>
      )}
    </div>
  );
}
