import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
type Session = { accessToken: string; tenants: { id: string; name: string; role: string }[] };
type Product = {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  price_usd: string;
  tax_category: string;
};
type Branch = { id: string; name: string };
type Stock = { product_id: string; quantity: string };
type Quote = {
  purchaseTotalBase: string;
  purchaseTotalUsd: string;
  igtfTotalBase: string;
  dueTotalBase: string;
  remainingPrincipalBase: string;
  note: string;
};
const money = (value: string | number) =>
  new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number(value),
  );
function App() {
  // Tokens remain in memory; a reload requires login. No localStorage credentials.
  const [session, setSession] = useState<Session | null>(null);
  const [tenant, setTenant] = useState('');
  const [tab, setTab] = useState<'catalog' | 'quote'>('catalog');
  const [products, setProducts] = useState<Product[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branch, setBranch] = useState('');
  const [stock, setStock] = useState<Stock[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [rate, setRate] = useState('');
  const [cart, setCart] = useState<{ product: Product; quantity: string }[]>([]);
  const [eligible, setEligible] = useState('0');
  const [other, setOther] = useState('0');
  const [quote, setQuote] = useState<Quote | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const adjustment = useRef<{ signature: string; key: string } | null>(null);
  const admin = session?.tenants.find((t) => t.id === tenant)?.role === 'admin';
  async function api(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
    const response = await fetch('/api' + path, {
      method,
      signal,
      headers: {
        'content-type': 'application/json',
        ...(session
          ? { authorization: 'Bearer ' + session.accessToken, 'x-tenant-id': tenant }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && session) {
        setSession(null);
        setCart([]);
        setQuote(null);
      }
      throw new Error(
        typeof data.message === 'string' ? data.message : JSON.stringify(data.message ?? data),
      );
    }
    return data;
  }
  async function action(fn: () => Promise<void>) {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadStock() {
    if (branch) setStock(await api(`/branches/${branch}/stock`));
  }
  useEffect(() => {
    if (!session || !tenant) return;
    const controller = new AbortController();
    api('/branches', 'GET', undefined, controller.signal)
      .then((data: Branch[]) => {
        setBranches(data);
        setBranch(data[0]?.id ?? '');
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, [session, tenant]);
  useEffect(() => {
    if (!session || !tenant) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      api('/products?search=' + encodeURIComponent(search), 'GET', undefined, controller.signal)
        .then(setProducts)
        .catch((e) => {
          if (e.name !== 'AbortError') setError(e.message);
        });
    }, 150);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [session, tenant, search]);
  useEffect(() => {
    if (!session || !branch) return;
    const controller = new AbortController();
    api(`/branches/${branch}/stock`, 'GET', undefined, controller.signal)
      .then(setStock)
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, [session, tenant, branch]);
  useEffect(() => {
    setQuote(null);
  }, [cart, rate, eligible, other]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  function add(p: Product) {
    setCart((c) =>
      c.some((l) => l.product.id === p.id)
        ? c.map((l) =>
            l.product.id === p.id ? { ...l, quantity: String(Number(l.quantity) + 1) } : l,
          )
        : [...c, { product: p, quantity: '1' }],
    );
    setTab('quote');
    setSearch('');
    searchRef.current?.focus();
  }
  if (!session)
    return (
      <main className="login-page">
        <section className="intro">
          <span className="wordmark">
            nexo<span>↗</span>
          </span>
          <p className="eyebrow">ADMINISTRACIÓN · INVENTARIO · POS</p>
          <h1>
            Tu operación,
            <br />
            en un solo lugar.
          </h1>
          <p>Una base clara para administrar tu negocio y preparar cada venta.</p>
          <div className="intro-note">Primera versión · Entorno de desarrollo</div>
        </section>
        <section className="login-card">
          <span className="eyebrow">BIENVENIDO</span>
          <h2>Accede a tu empresa</h2>
          <p>Usa la cuenta de administrador creada durante la instalación.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void action(async () => {
                const result: Session = await api('/auth/login', 'POST', {
                  email: form.get('email'),
                  password: form.get('password'),
                });
                if (!result.tenants.length)
                  throw new Error('Esta cuenta no tiene empresas asignadas');
                setTenant(result.tenants[0].id);
                setSession(result);
                setError('');
              });
            }}
          >
            <label>
              Correo electrónico
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder="tu@empresa.com"
              />
            </label>
            <label>
              Contraseña
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button disabled={busy}>{busy ? 'Ingresando…' : 'Ingresar →'}</button>
          </form>
          <p className="small">
            No hay credenciales predeterminadas. Consulta la guía de instalación.
          </p>
        </section>
      </main>
    );
  return (
    <div className="shell" inert={busy}>
      <aside>
        <span className="wordmark">
          nexo<span>↗</span>
        </span>
        <span className="eyebrow">ESPACIO DE TRABAJO</span>
        <button
          className={tab === 'catalog' ? 'nav active' : 'nav'}
          onClick={() => setTab('catalog')}
        >
          ▦ Catálogo e inventario
        </button>
        <button className={tab === 'quote' ? 'nav active' : 'nav'} onClick={() => setTab('quote')}>
          ＋ Vista previa de venta <span>{cart.length}</span>
        </button>
        <div className="sidebar-bottom">
          <span className="status-dot" /> Backend conectado<p>Versión 0.1 · Desarrollo</p>
          <button
            className="nav"
            onClick={() =>
              void action(async () => {
                await api('/auth/session', 'DELETE');
                setSession(null);
                setCart([]);
                setQuote(null);
                setProducts([]);
                setStock([]);
              })
            }
          >
            Cerrar sesión ↗
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header>
          <div>
            <span className="eyebrow">OPERACIÓN COMERCIAL</span>
            <h1>{tab === 'catalog' ? 'Catálogo e inventario' : 'Vista previa de venta'}</h1>
          </div>
          <div className="context">
            <label>
              Empresa
              <select
                value={tenant}
                onChange={(e) => {
                  setTenant(e.target.value);
                  setProducts([]);
                  setBranches([]);
                  setBranch('');
                  setStock([]);
                  setCart([]);
                  setQuote(null);
                  setSearch('');
                }}
              >
                {session.tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Sucursal
              <select value={branch} onChange={(e) => setBranch(e.target.value)}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </header>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        <div className="banner">
          <strong>Primera entrega</strong>
          <span>
            Catálogo y ajustes reales. Cotizaciones de prueba: no registran ventas ni emiten
            facturas fiscales.
          </span>
        </div>
        <section className="toolbar">
          <label className="search">
            Buscar producto <kbd>F2</kbd>
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Nombre, SKU o código de barras"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && products.length === 1) add(products[0]);
              }}
            />
          </label>
          <label>
            Tasa manual · Bs / USD
            <input
              inputMode="decimal"
              placeholder="Ej. 40.000000"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </label>
        </section>
        <div className={tab === 'quote' ? 'content-grid' : 'content-grid catalog'}>
          <section className="panel">
            <div className="panel-heading">
              <h2>Productos</h2>
              <span>Hasta 30 resultados</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th>Precio sin IVA</th>
                    <th>Existencia</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.name}</strong>
                        <small>
                          {p.sku} ·{' '}
                          {p.tax_category === 'general'
                            ? 'IVA 16 %'
                            : p.tax_category === 'reduced'
                              ? 'IVA 8 %'
                              : 'Exento'}
                        </small>
                      </td>
                      <td>
                        <strong>$ {money(p.price_usd)}</strong>
                        <small>
                          {Number(rate) > 0
                            ? `Bs ${money(Number(p.price_usd) * Number(rate))}`
                            : 'Ingresa una tasa'}
                        </small>
                      </td>
                      <td>{stock.find((s) => s.product_id === p.id)?.quantity ?? '—'}</td>
                      <td>
                        <button className="secondary compact" onClick={() => add(p)}>
                          Agregar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!products.length && (
                <div className="empty">
                  No hay productos para mostrar.
                  <br />
                  {admin
                    ? 'Crea el primero con el formulario inferior.'
                    : 'Consulta al administrador para cargar el catálogo.'}
                </div>
              )}
            </div>
            <p className="small panel-foot">
              Precios de referencia sin IVA. La API calcula los impuestos y totales. La vista de
              existencias está limitada a 500 registros.
            </p>
          </section>
          {tab === 'quote' && (
            <section className="panel cart">
              <div className="panel-heading">
                <h2>Cotización de prueba</h2>
                <span>{cart.length} productos</span>
              </div>
              <div className="cart-body">
                {!cart.length && <p className="empty">Agrega productos para calcular una venta.</p>}
                {cart.map((l) => (
                  <div className="cart-line" key={l.product.id}>
                    <div>
                      <strong>{l.product.name}</strong>
                      <small>$ {money(l.product.price_usd)} sin IVA</small>
                    </div>
                    <input
                      aria-label={'Cantidad de ' + l.product.name}
                      inputMode="decimal"
                      value={l.quantity}
                      onChange={(e) =>
                        setCart((c) =>
                          c.map((x) =>
                            x.product.id === l.product.id ? { ...x, quantity: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    <button
                      className="icon"
                      aria-label={'Quitar ' + l.product.name}
                      onClick={() => setCart((c) => c.filter((x) => x.product.id !== l.product.id))}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <hr />
                <h3>Distribución del principal · USD</h3>
                <p className="small">
                  Incluye el IVA de la compra. La elegibilidad del IGTF es una hipótesis de esta
                  simulación.
                </p>
                <label>
                  Principal no gravado por IGTF
                  <input
                    inputMode="decimal"
                    value={other}
                    onChange={(e) => setOther(e.target.value)}
                  />
                </label>
                <label>
                  Principal elegible para IGTF al 3 %
                  <input
                    inputMode="decimal"
                    value={eligible}
                    onChange={(e) => setEligible(e.target.value)}
                  />
                </label>
                <button
                  disabled={busy || !cart.length || !rate}
                  onClick={() =>
                    void action(async () => {
                      setQuote(null);
                      setQuote(
                        await api('/quotes/preview', 'POST', {
                          rate,
                          lines: cart.map((l) => ({
                            productId: l.product.id,
                            quantity: l.quantity,
                          })),
                          payments: [
                            { principalUsd: other, eligibleForIgtf: false },
                            { principalUsd: eligible, eligibleForIgtf: true },
                          ],
                        }),
                      );
                    })
                  }
                >
                  Calcular vista previa
                </button>
                {quote && (
                  <div className="totals" aria-live="polite">
                    <p>
                      Compra con IVA <strong>Bs {money(quote.purchaseTotalBase)}</strong>
                    </p>
                    <p>
                      Equivalente <strong>$ {money(quote.purchaseTotalUsd)}</strong>
                    </p>
                    <p>
                      IGTF simulado <strong>Bs {money(quote.igtfTotalBase)}</strong>
                    </p>
                    <p className="grand-total">
                      Total <strong>Bs {money(quote.dueTotalBase)}</strong>
                    </p>
                    <p>
                      Principal pendiente <strong>Bs {money(quote.remainingPrincipalBase)}</strong>
                    </p>
                    <small>{quote.note}</small>
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
        {admin && tab === 'catalog' && (
          <section className="admin-grid">
            <section className="panel">
              <div className="panel-heading">
                <h2>Nuevo producto</h2>
              </div>
              <form
                className="admin-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const f = new FormData(form);
                  void action(async () => {
                    await api('/products', 'POST', {
                      sku: f.get('sku'),
                      name: f.get('name'),
                      priceUsd: f.get('price'),
                      taxCategory: f.get('tax'),
                      ...(f.get('barcode') ? { barcode: f.get('barcode') } : {}),
                    });
                    setProducts(await api('/products?search=' + encodeURIComponent(search)));
                    form.reset();
                    setNotice('Producto creado.');
                  });
                }}
              >
                <label>
                  Nombre
                  <input name="name" required maxLength={200} />
                </label>
                <div className="two">
                  <label>
                    SKU
                    <input name="sku" required maxLength={64} />
                  </label>
                  <label>
                    Código de barras
                    <input name="barcode" maxLength={64} />
                  </label>
                </div>
                <div className="two">
                  <label>
                    Precio USD sin IVA
                    <input name="price" inputMode="decimal" required placeholder="10.50" />
                  </label>
                  <label>
                    IVA
                    <select name="tax" aria-label="IVA">
                      <option value="general">General · 16 %</option>
                      <option value="reduced">Reducido · 8 %</option>
                      <option value="exempt">Exento</option>
                    </select>
                  </label>
                </div>
                <button disabled={busy}>Crear producto</button>
              </form>
            </section>
            <section className="panel">
              <div className="panel-heading">
                <h2>Ajustar existencia</h2>
                <span>Solo administrador</span>
              </div>
              <form
                className="admin-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const f = new FormData(form);
                  const payload = {
                    branchId: branch,
                    productId: f.get('product'),
                    delta: f.get('delta'),
                    reason: f.get('reason'),
                  };
                  const signature = JSON.stringify(payload);
                  if (adjustment.current?.signature !== signature)
                    adjustment.current = { signature, key: crypto.randomUUID() };
                  const key = adjustment.current!.key;
                  void action(async () => {
                    await api('/inventory/adjustments', 'POST', {
                      ...payload,
                      idempotencyKey: key,
                    });
                    adjustment.current = null;
                    form.reset();
                    setNotice('Ajuste registrado con su movimiento de auditoría.');
                    try {
                      await loadStock();
                    } catch {
                      setError(
                        'El ajuste se guardó, pero no se pudo refrescar la existencia. Recarga la página antes de otro ajuste.',
                      );
                    }
                  });
                }}
              >
                <label>
                  Producto
                  <select name="product" aria-label="Producto" required>
                    <option value="">Selecciona un producto</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.sku} · {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Cantidad a sumar o restar
                  <input name="delta" required inputMode="decimal" placeholder="Ej. 10 o -2" />
                </label>
                <label>
                  Motivo
                  <input
                    name="reason"
                    required
                    minLength={5}
                    maxLength={250}
                    placeholder="Recepción inicial, corrección de conteo…"
                  />
                </label>
                <button disabled={busy || !branch}>Registrar ajuste</button>
                <p className="small">
                  No sustituye una recepción de compra. No se permiten existencias negativas.
                </p>
              </form>
            </section>
          </section>
        )}
        <footer>
          Nexo · Base de desarrollo del sistema de facturación
          <span>Tasa manual · Sin conexión al BCV</span>
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
