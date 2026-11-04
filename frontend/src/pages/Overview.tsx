import { useResource } from '../api';
import { Button, Empty, Feedback, Icon } from '../components/ui';
import {
  dateTime,
  quantity,
  type Api,
  type Movement,
  type Page,
  type PageResult,
  type Summary,
} from '../types';
export function Overview({
  api,
  scope,
  branch,
  branchName,
  revision,
  navigate,
}: {
  api: Api;
  scope: string;
  branch: string;
  branchName: string;
  revision: number;
  navigate: (p: Page) => void;
}) {
  const stats = useResource<Summary>(
    scope + revision + 'summary',
    (s) => api('/dashboard?branchId=' + branch, 'GET', undefined, s),
    !!branch,
  );
  const activity = useResource<PageResult<Movement>>(
    scope + revision + 'activity',
    (s) => api('/inventory/movements?branchId=' + branch + '&limit=6', 'GET', undefined, s),
    !!branch,
  );
  const cards = [
    {
      title: 'Artículos activos',
      value: stats.data?.products,
      icon: 'box',
      detail: 'Catálogo de la empresa',
      color: 'blue',
    },
    {
      title: 'Con existencia',
      value: stats.data?.with_stock,
      icon: 'check',
      detail: 'Referencias en esta sucursal',
      color: 'green',
    },
    {
      title: 'Sin existencia',
      value: stats.data?.without_stock,
      icon: 'arrows',
      detail: 'Referencias con saldo cero',
      color: 'orange',
    },
    {
      title: 'Sucursales accesibles',
      value: stats.data?.branches,
      icon: 'building',
      detail: 'Según tus permisos',
      color: 'purple',
    },
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="overline">ADMINISTRATIVO / INICIO</span>
          <h1>Resumen de operaciones</h1>
          <p>Una vista del catálogo y la actividad de {branchName || 'tu sucursal'}.</p>
        </div>
        <span className="date-label">
          <Icon name="clock" />
          {new Intl.DateTimeFormat('es-VE', {
            dateStyle: 'long',
            timeZone: 'America/Caracas',
          }).format(new Date())}
        </span>
      </div>
      <Feedback error={stats.error || activity.error} />
      <div className="stats-grid">
        {cards.map((c) => (
          <section className="stat-card" key={c.title}>
            <div>
              <span>{c.title}</span>
              <strong>{c.value === undefined ? '—' : quantity(c.value)}</strong>
              <small>{c.detail}</small>
            </div>
            <span className={'stat-icon ' + c.color}>
              <Icon name={c.icon} size={23} />
            </span>
          </section>
        ))}
      </div>
      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Actividad reciente de inventario</h2>
              <p>Últimos movimientos registrados en esta sucursal</p>
            </div>
            <Button variant="ghost" onClick={() => navigate('movements')}>
              Ver movimientos <Icon name="chevron" size={14} />
            </Button>
          </div>
          <div className="activity-list">
            {activity.loading ? (
              <div className="loading">Consultando actividad…</div>
            ) : activity.data?.items.length ? (
              activity.data.items.map((m) => (
                <div className="activity-row" key={m.id}>
                  <span
                    className={
                      'activity-icon ' + (Number(m.delta) > 0 ? 'positive-bg' : 'negative-bg')
                    }
                  >
                    <Icon name="arrows" />
                  </span>
                  <div>
                    <strong>{m.name}</strong>
                    <p>{m.reason}</p>
                    <small>
                      {dateTime(m.created_at)} · {m.sku}
                    </small>
                  </div>
                  <strong className={'number ' + (Number(m.delta) > 0 ? 'positive' : 'negative')}>
                    {Number(m.delta) > 0 ? '+' : ''}
                    {quantity(m.delta)}
                  </strong>
                </div>
              ))
            ) : (
              <Empty
                title="Aún no hay actividad"
                description="Los ajustes de inventario aparecerán aquí cuando registres el primer movimiento."
              />
            )}
          </div>
        </section>
        <section className="panel shortcuts">
          <div className="panel-header">
            <div>
              <h2>Accesos de trabajo</h2>
              <p>Continúa con una operación</p>
            </div>
          </div>
          {[
            {
              page: 'articles' as Page,
              icon: 'box',
              title: 'Administrar artículos',
              description: 'Catálogo, precios y existencias',
            },
            {
              page: 'quote' as Page,
              icon: 'file',
              title: 'Preparar una cotización',
              description: 'Productos, IVA y pagos mixtos',
            },
            {
              page: 'branches' as Page,
              icon: 'building',
              title: 'Consultar sucursales',
              description: 'Establecimientos de la empresa',
            },
          ].map((s) => (
            <button className="shortcut" key={s.page} onClick={() => navigate(s.page)}>
              <span>
                <Icon name={s.icon} size={22} />
              </span>
              <div>
                <strong>{s.title}</strong>
                <small>{s.description}</small>
              </div>
              <Icon name="chevron" size={16} />
            </button>
          ))}
          <div className="workspace-tip">
            <Icon name="help" />
            <p>
              Selecciona la empresa y sucursal en la barra superior. Las consultas respetan el
              ámbito de trabajo seleccionado.
            </p>
          </div>
        </section>
      </div>
      <div className="info-strip">
        <Icon name="shield" />
        <div>
          <strong>Una operación con trazabilidad</strong>
          <span>
            Los cambios en artículos y los ajustes de inventario conservan su registro de auditoría.
          </span>
        </div>
        <span className="badge neutral">Administrativo</span>
      </div>
    </>
  );
}
