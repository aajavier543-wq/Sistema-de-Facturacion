import { useEffect, useMemo, useRef, useState } from 'react';
import { makeApi, useResource } from './api';
import { Button, Dialog, Feedback, Icon } from './components/ui';
import { Branches } from './pages/Branches';
import { Inventory } from './pages/Inventory';
import { Overview } from './pages/Overview';
import { Quotation } from './pages/Quotation';
import { GoodsDocuments } from './pages/GoodsDocuments';
import type { Branch, Page, Product, Session } from './types';
const navigation: {
  section: string;
  items: { id: Page; label: string; icon: string; adminOnly?: boolean }[];
}[] = [
  {
    section: 'GENERAL',
    items: [{ id: 'overview' as Page, label: 'Resumen de operaciones', icon: 'grid' }],
  },
  {
    section: 'INVENTARIO',
    items: [
      { id: 'articles' as Page, label: 'Artículos y existencias', icon: 'box' },
      { id: 'movements' as Page, label: 'Movimientos', icon: 'arrows' },
      { id: 'adjustments', label: 'Ajustes de entrada y salida', icon: 'arrows', adminOnly: true },
    ],
  },
  {
    section: 'COMPRAS',
    items: [{ id: 'purchases', label: 'Facturas de compra', icon: 'file', adminOnly: true }],
  },
  { section: 'COMERCIAL', items: [{ id: 'quote' as Page, label: 'Cotizaciones', icon: 'file' }] },
  {
    section: 'ORGANIZACIÓN',
    items: [{ id: 'branches' as Page, label: 'Sucursales', icon: 'building' }],
  },
];
const titles: Record<Page, string> = {
  overview: 'Resumen de operaciones',
  articles: 'Artículos y existencias',
  movements: 'Movimientos de inventario',
  quote: 'Cotizaciones',
  branches: 'Sucursales',
  adjustments: 'Ajustes de entrada y salida',
  purchases: 'Facturas de compra',
};
export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [tenant, setTenant] = useState('');
  const [branch, setBranch] = useState('');
  const [page, setPage] = useState<Page>('overview');
  const [rate, setRate] = useState('');
  const [revision, setRevision] = useState(0);
  const [help, setHelp] = useState(false);
  const [error, setError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [documentBusy, setDocumentBusy] = useState(false);
  const [pending, setPending] = useState<{ product: Product; event: string } | null>(null);
  const [adjustmentPending, setAdjustmentPending] = useState<{
    product: Product;
    event: string;
  } | null>(null);
  const documentDirty = useRef({ quote: false, adjustments: false, purchases: false });
  const api = useMemo(
    () =>
      makeApi(session, tenant, () => {
        setSession(null);
        setBranch('');
        setPending(null);
        setAdjustmentPending(null);
        documentDirty.current = { quote: false, adjustments: false, purchases: false };
        setError('La sesión venció. Ingresa nuevamente.');
      }),
    [session, tenant],
  );
  const [branchRevision, setBranchRevision] = useState(0);
  const branchScope = (session?.accessToken ?? '') + tenant;
  const branchCache = useRef<{ scope: string; items: Branch[] }>({ scope: '', items: [] });
  const branchQuery = useResource<Branch[]>(
    branchScope + ':' + branchRevision,
    (s) => api('/branches', 'GET', undefined, s),
    !!session && !!tenant,
  );
  useEffect(() => {
    if (branchQuery.data) branchCache.current = { scope: branchScope, items: branchQuery.data };
  }, [branchQuery.data, branchScope]);
  const branches =
    branchQuery.data ??
    (branchCache.current.scope === branchScope ? branchCache.current.items : []);
  const loadingBranches = branchQuery.loading && !branches.length;
  const activeBranch = branches.some((b) => b.id === branch) ? branch : (branches[0]?.id ?? '');
  const company = session?.tenants.find((t) => t.id === tenant);
  const branchName = branches.find((b) => b.id === activeBranch)?.name ?? '';
  const scope = (session?.accessToken ?? '') + ':' + tenant + ':' + activeBranch;
  const admin = company?.role === 'admin';
  function mayDiscard() {
    return (
      !Object.values(documentDirty.current).some(Boolean) ||
      window.confirm(
        'Al cambiar el ámbito de trabajo se descartarán los cambios de documentos sin guardar y las cotizaciones en preparación. ¿Deseas continuar?',
      )
    );
  }
  function refresh() {
    setRevision((r) => r + 1);
  }
  if (!session)
    return (
      <Login
        error={error}
        onLogin={(result) => {
          setError('');
          setSession(result);
          setTenant(result.tenants[0].id);
          setBranch('');
          setBranchRevision(0);
          setPage('overview');
          setPending(null);
          setAdjustmentPending(null);
          setRate('');
          documentDirty.current = { quote: false, adjustments: false, purchases: false };
        }}
      />
    );
  return (
    <div className="erp-shell" inert={documentBusy}>
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage('overview');
          }}
          aria-label="Nexo inicio"
        >
          <span className="brand-mark">n</span>
          <span>
            nexo<small>ADMINISTRATIVO</small>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-avatar">{company?.name.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{company?.name}</strong>
            <small>Espacio de trabajo</small>
          </div>
        </div>
        <nav aria-label="Módulos">
          {navigation
            .filter((group) => group.items.some((item) => !item.adminOnly || admin))
            .map((group) => (
              <div className="nav-group" key={group.section}>
                <span>{group.section}</span>
                {group.items
                  .filter((item) => !item.adminOnly || admin)
                  .map((item) => (
                    <button
                      key={item.id}
                      className={page === item.id ? 'nav-item active' : 'nav-item'}
                      aria-current={page === item.id ? 'page' : undefined}
                      onClick={() => setPage(item.id)}
                    >
                      <Icon name={item.icon} />
                      <span>{item.label}</span>
                      {page === item.id && <span className="nav-indicator" />}
                    </button>
                  ))}
              </div>
            ))}
        </nav>
        <div className="sidebar-footer">
          <span className="sidebar-user">
            <Icon name="shield" />
            <span>
              {admin ? 'Administrador' : 'Cajero'}
              <small>{session.email}</small>
            </span>
          </span>
          <button
            className="nav-item"
            disabled={loggingOut}
            onClick={() => {
              if (!mayDiscard()) return;
              setLoggingOut(true);
              setError('');
              void api('/auth/session', 'DELETE')
                .then(() => {
                  setSession(null);
                  setPending(null);
                  setAdjustmentPending(null);
                  documentDirty.current = { quote: false, adjustments: false, purchases: false };
                })
                .catch((e) => setError(e.message))
                .finally(() => setLoggingOut(false));
            }}
          >
            <Icon name="logout" />
            <span>{loggingOut ? 'Cerrando sesión…' : 'Cerrar sesión'}</span>
          </button>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Administrativo</span>
            <Icon name="chevron" size={13} />
            <strong>{titles[page]}</strong>
          </div>
          <div className="topbar-actions">
            <span className="edition">ERP · Desarrollo</span>
            <button
              className="icon-button"
              aria-label="Ayuda y atajos"
              onClick={() => setHelp(true)}
            >
              <Icon name="help" />
            </button>
            <span className="user-avatar">{session.email.slice(0, 1).toUpperCase()}</span>
          </div>
        </header>
        <div className="context-bar">
          <label>
            Empresa
            <select
              aria-label="Empresa"
              value={tenant}
              onChange={(e) => {
                if (!mayDiscard()) return;
                setTenant(e.target.value);
                setBranch('');
                setBranchRevision(0);
                setPending(null);
                setAdjustmentPending(null);
                setRate('');
                documentDirty.current = { quote: false, adjustments: false, purchases: false };
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
            <select
              aria-label="Sucursal"
              value={activeBranch}
              onChange={(e) => {
                if (!mayDiscard()) return;
                setBranch(e.target.value);
                setPending(null);
                setAdjustmentPending(null);
                documentDirty.current = { quote: false, adjustments: false, purchases: false };
              }}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
              {!branches.length && (
                <option value="">{loadingBranches ? 'Consultando…' : 'Sin sucursales'}</option>
              )}
            </select>
          </label>
          <div className="context-divider" />
          <label className="exchange-field">
            Tasa manual · Bs / USD
            <input
              aria-label="Tasa manual Bs por USD"
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(e.target.value.replace(',', '.'))}
              placeholder="Ingresar tasa"
            />
          </label>
          <span className="context-note">
            <Icon name="clock" size={14} /> Tasa de referencia ingresada por el usuario
          </span>
        </div>
        <main className="workspace">
          <Feedback error={error || branchQuery.error} />
          {loadingBranches ? (
            <section className="panel loading">Cargando tu espacio de trabajo…</section>
          ) : (
            <>
              {page === 'overview' && (
                <Overview
                  api={api}
                  scope={scope}
                  branch={activeBranch}
                  branchName={branchName}
                  revision={revision}
                  navigate={setPage}
                />
              )}{' '}
              {(page === 'articles' || page === 'movements') && (
                <Inventory
                  key={tenant}
                  api={api}
                  scope={scope}
                  branch={activeBranch}
                  admin={admin}
                  rate={rate}
                  revision={revision}
                  onChanged={refresh}
                  mode={page}
                  onAdjust={(product) => {
                    setAdjustmentPending({ product, event: crypto.randomUUID() });
                    setPage('adjustments');
                  }}
                  onQuote={(product) => {
                    setPending({ product, event: crypto.randomUUID() });
                    setPage('quote');
                  }}
                />
              )}
              {page === 'branches' && (
                <Branches
                  api={api}
                  branches={branches}
                  branch={activeBranch}
                  admin={admin}
                  onChanged={() => {
                    setBranchRevision((r) => r + 1);
                    refresh();
                  }}
                  onSelect={(id) => {
                    if (mayDiscard()) {
                      setBranch(id);
                      setPending(null);
                      setAdjustmentPending(null);
                      documentDirty.current = {
                        quote: false,
                        adjustments: false,
                        purchases: false,
                      };
                    }
                  }}
                />
              )}
            </>
          )}
          {admin &&
            (['adjustment', 'purchase'] as const).map((kind) => (
              <GoodsDocuments
                key={scope + kind}
                api={api}
                scope={scope}
                branch={activeBranch}
                kind={kind}
                visible={
                  page === (kind === 'adjustment' ? 'adjustments' : 'purchases') && !loadingBranches
                }
                admin={admin}
                rate={rate}
                revision={revision}
                onChanged={refresh}
                onDirty={(dirty) => {
                  documentDirty.current[kind === 'adjustment' ? 'adjustments' : 'purchases'] =
                    dirty;
                }}
                onBusy={setDocumentBusy}
                pending={kind === 'adjustment' ? adjustmentPending : null}
                onConsumed={() => setAdjustmentPending(null)}
              />
            ))}
          <Quotation
            key={scope}
            api={api}
            scope={scope}
            visible={page === 'quote' && !loadingBranches}
            company={company?.name ?? ''}
            branchName={branchName}
            rate={rate}
            pending={pending}
            onConsumed={() => setPending(null)}
            onDirty={(dirty) => {
              documentDirty.current.quote = dirty;
            }}
            onBusy={setDocumentBusy}
            revision={revision}
          />
        </main>
        <footer className="statusbar">
          <span>
            <span className="status-dot" />
            {company?.name} <i>/</i> {branchName || 'Sin sucursal'}
          </span>
          <span>
            Moneda de referencia: USD <i>·</i> Operación en bolívares <i>·</i> Nexo 0.2
          </span>
        </footer>
      </div>
      {help && (
        <Dialog
          title="Tu espacio de trabajo"
          subtitle="Herramientas para una operación más ágil"
          onClose={() => setHelp(false)}
        >
          <div className="form-content">
            <div className="shortcut-help">
              <kbd>F2</kbd>
              <span>Buscar artículos en catálogo o cotizaciones</span>
            </div>
            <div className="shortcut-help">
              <kbd>F4</kbd>
              <span>Crear un artículo desde Inventario (administrador)</span>
            </div>
            <div className="shortcut-help">
              <kbd>Ctrl + Enter</kbd>
              <span>Calcular la cotización actual</span>
            </div>
            <div className="shortcut-help">
              <kbd>Esc</kbd>
              <span>Cerrar una ventana sin guardar</span>
            </div>
            <p className="form-hint">
              El inventario y los artículos se guardan en la empresa seleccionada. Las cotizaciones
              son borradores de trabajo y no se conservan al cerrar sesión o recargar.
            </p>
          </div>
          <footer className="dialog-footer">
            <Button variant="primary" onClick={() => setHelp(false)}>
              Entendido
            </Button>
          </footer>
        </Dialog>
      )}
    </div>
  );
}
function Login({
  error: sessionError,
  onLogin,
}: {
  error: string;
  onLogin: (session: Session) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const api = useMemo(() => makeApi(null, '', () => {}), []);
  return (
    <main className="login-page">
      <section className="login-intro">
        <a className="brand" href="#">
          <span className="brand-mark">n</span>
          <span>
            nexo<small>ADMINISTRATIVO</small>
          </span>
        </a>
        <div className="login-pitch">
          <span className="overline">CONTROL Y VISIBILIDAD PARA TU EMPRESA</span>
          <h1>
            La información correcta.
            <br />
            Una operación más clara.
          </h1>
          <p>
            Gestiona artículos, consulta existencias y prepara tus documentos desde un solo espacio
            de trabajo.
          </p>
          <div className="login-features">
            <span>
              <Icon name="box" />
              Control de inventario
            </span>
            <span>
              <Icon name="building" />
              Gestión por sucursal
            </span>
            <span>
              <Icon name="file" />
              Cotizaciones multimoneda
            </span>
          </div>
        </div>
        <div className="login-caption">
          Nexo Administrativo <span>Versión de desarrollo · 0.2</span>
        </div>
      </section>
      <section className="login-form-section">
        <div className="login-form-card">
          <span className="login-emblem">
            <Icon name="shield" size={27} />
          </span>
          <span className="overline">ACCESO AL SISTEMA</span>
          <h2>Bienvenido a tu empresa</h2>
          <p>Ingresa tus credenciales para continuar.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              setBusy(true);
              setError('');
              const email = String(f.get('email')).trim();
              void api<Omit<Session, 'email'>>('/auth/login', 'POST', {
                email,
                password: f.get('password'),
              })
                .then((result) => {
                  if (!result.tenants.length)
                    throw new Error('Esta cuenta no tiene empresas asignadas.');
                  onLogin({ ...result, email });
                })
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <fieldset disabled={busy}>
              <Feedback error={error || sessionError} />
              <label>
                Correo electrónico
                <input
                  name="email"
                  autoFocus
                  type="email"
                  autoComplete="username"
                  required
                  placeholder="nombre@empresa.com"
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
                  placeholder="Ingresa tu contraseña"
                />
              </label>
              <Button variant="primary" type="submit">
                {busy ? 'Validando acceso…' : 'Ingresar al sistema'}
                <Icon name="chevron" size={16} />
              </Button>
            </fieldset>
          </form>
          <div className="login-security">
            <Icon name="shield" size={14} /> Acceso limitado a tus empresas y sucursales autorizadas
          </div>
          <p className="login-support">
            ¿Necesitas acceso? Contacta al administrador de tu empresa.
          </p>
        </div>
      </section>
    </main>
  );
}
