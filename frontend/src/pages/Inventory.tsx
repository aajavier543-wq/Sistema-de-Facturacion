import { useEffect, useRef, useState } from 'react';
import { exportCsv, useResource } from '../api';
import { Button, Dialog, Empty, Feedback, Icon, Pager } from '../components/ui';
import {
  dateTime,
  money,
  quantity,
  taxLabels,
  type Api,
  type Movement,
  type PageResult,
  type Product,
} from '../types';
type Props = {
  api: Api;
  scope: string;
  branch: string;
  admin: boolean;
  rate: string;
  revision: number;
  onChanged: () => void;
  mode: 'articles' | 'movements';
  onQuote: (p: Product) => void;
  onAdjust: (p: Product) => void;
};
export function Inventory({
  api,
  scope,
  branch,
  admin,
  rate,
  revision,
  onChanged,
  mode,
  onQuote,
  onAdjust,
}: Props) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState('');
  const [editor, setEditor] = useState<Product | 'new' | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const path = mode === 'articles' ? '/inventory/stock' : '/inventory/movements';
  const key = [scope, branch, revision, mode, search, page].join(':');
  const data = useResource<PageResult<Product | Movement>>(
    key,
    (s) =>
      api(
        `${path}?branchId=${branch}&search=${encodeURIComponent(search)}&limit=20&offset=${page * 20}`,
        'GET',
        undefined,
        s,
      ),
    !!branch,
  );
  const rows = data.data?.items ?? [];
  const product = rows.find((r) => r.id === selected) as Product | undefined;
  useEffect(() => {
    setSearch('');
    setPage(0);
    setSelected('');
  }, [mode, branch]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (e.key === 'F2') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'F4' && admin && mode === 'articles') {
        e.preventDefault();
        setEditor('new');
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [admin, mode]);
  const articles = mode === 'articles';
  function exportPage() {
    if (articles)
      exportCsv(
        'articulos-pagina.csv',
        [
          'Código',
          'Descripción',
          'Código de barras',
          'Existencia',
          'Precio USD sin IVA',
          'Estado del precio',
          'Impuesto',
        ],
        (rows as Product[]).map((p) => [
          p.sku,
          p.name,
          p.barcode,
          p.quantity ?? '0',
          p.price_pending ? '' : p.price_usd,
          p.price_pending ? 'Pendiente' : 'Definido',
          taxLabels[p.tax_category],
        ]),
      );
    else
      exportCsv(
        'movimientos-pagina.csv',
        ['Fecha Caracas', 'Código', 'Descripción', 'Variación', 'Motivo', 'Usuario'],
        (rows as Movement[]).map((m) => [
          dateTime(m.created_at),
          m.sku,
          m.name,
          m.delta,
          m.reason,
          m.actor,
        ]),
      );
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="overline">INVENTARIO / {articles ? 'MAESTROS' : 'CONSULTAS'}</span>
          <h1>{articles ? 'Artículos y existencias' : 'Movimientos de inventario'}</h1>
          <p>
            {articles
              ? 'Administra tu catálogo, precios y disponibilidad por sucursal.'
              : 'Consulta la trazabilidad de entradas y salidas de mercancía.'}
          </p>
        </div>
        <div className="heading-actions">
          {articles && admin && (
            <Button icon="plus" variant="primary" onClick={() => setEditor('new')}>
              Nuevo artículo
            </Button>
          )}
          {!articles && (
            <Button icon="box" onClick={onChanged}>
              Actualizar consulta
            </Button>
          )}
        </div>
      </div>
      <section className="panel">
        <div className="ribbon">
          <div className="ribbon-group">
            {articles && (
              <>
                <Button
                  icon="edit"
                  disabled={!product || !admin}
                  onClick={() => setEditor(product!)}
                >
                  Editar ficha
                </Button>
                <Button
                  icon="arrows"
                  disabled={!product || !admin}
                  onClick={() => onAdjust(product!)}
                >
                  Ajustar existencia
                </Button>
                <Button
                  icon="file"
                  disabled={!product || !!product.price_pending}
                  onClick={() => onQuote(product!)}
                >
                  Cotizar
                </Button>
              </>
            )}
            <Button icon="refresh" onClick={onChanged}>
              Actualizar
            </Button>
          </div>
          <Button icon="download" disabled={!rows.length || data.loading} onClick={exportPage}>
            Exportar página
          </Button>
        </div>
        <div className="filter-bar">
          <div className="search-field">
            <Icon name="search" />
            <input
              ref={searchRef}
              aria-label="Buscar artículos o movimientos"
              placeholder={
                articles
                  ? 'Buscar por descripción, código o código de barras…'
                  : 'Buscar por artículo, código o motivo…'
              }
              value={search}
              maxLength={120}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
            <kbd>F2</kbd>
          </div>
          <span className="muted">
            {articles
              ? 'Selecciona una fila para trabajar con el artículo'
              : 'Historial registrado · Hora de Venezuela'}
          </span>
        </div>
        <Feedback error={data.error} />
        <div className="table-scroll" aria-busy={data.loading}>
          <table>
            <thead>
              <tr>
                {articles ? (
                  <>
                    <th>Código</th>
                    <th>Descripción del artículo</th>
                    <th>Código de barras</th>
                    <th className="right">Existencia</th>
                    <th className="right">Precio USD</th>
                    <th>IVA</th>
                    <th>Estado</th>
                  </>
                ) : (
                  <>
                    <th>Fecha y hora</th>
                    <th>Artículo</th>
                    <th className="right">Variación</th>
                    <th>Motivo del movimiento</th>
                    <th>Usuario</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {articles
                ? (rows as Product[]).map((p) => (
                    <tr
                      key={p.id}
                      className={selected === p.id ? 'selected selectable' : 'selectable'}
                      tabIndex={0}
                      aria-selected={selected === p.id}
                      onClick={() => setSelected(p.id)}
                      onDoubleClick={() => admin && setEditor(p)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          setSelected(p.id);
                          if (admin) setEditor(p);
                        }
                      }}
                    >
                      <td className="code">{p.sku}</td>
                      <td>
                        <strong>{p.name}</strong>
                        {!p.price_pending && Number(rate) > 0 && (
                          <small>
                            Referencia: Bs {money(Number(p.price_usd) * Number(rate))} sin IVA
                          </small>
                        )}
                      </td>
                      <td className="muted">{p.barcode || '—'}</td>
                      <td className="right number">{quantity(p.quantity ?? '0')}</td>
                      <td className="right number">
                        {p.price_pending ? 'Por definir' : '$ ' + money(p.price_usd)}
                        <small>{p.price_pending ? 'Precio de venta pendiente' : 'Sin IVA'}</small>
                      </td>
                      <td>
                        <span className="badge neutral">
                          {taxLabels[p.tax_category]}
                          {p.price_pending ? ' · Revisar' : ''}
                        </span>
                      </td>
                      <td>
                        <span className={'badge ' + (Number(p.quantity) > 0 ? 'green' : 'amber')}>
                          {Number(p.quantity) > 0 ? 'Disponible' : 'Sin existencia'}
                        </span>
                      </td>
                    </tr>
                  ))
                : (rows as Movement[]).map((m) => (
                    <tr key={m.id}>
                      <td className="date-cell">{dateTime(m.created_at)}</td>
                      <td>
                        <strong>{m.name}</strong>
                        <small>{m.sku}</small>
                      </td>
                      <td
                        className={
                          'right number ' + (Number(m.delta) > 0 ? 'positive' : 'negative')
                        }
                      >
                        {Number(m.delta) > 0 ? '+' : ''}
                        {quantity(m.delta)}
                      </td>
                      <td>{m.reason}</td>
                      <td className="muted">{m.actor}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
          {data.loading ? (
            <div className="loading">Consultando registros…</div>
          ) : (
            !rows.length && (
              <Empty
                title={
                  search
                    ? 'No encontramos coincidencias'
                    : articles
                      ? 'Tu catálogo comienza aquí'
                      : 'Todavía no hay movimientos'
                }
                description={
                  search
                    ? 'Prueba con otro código o descripción.'
                    : articles
                      ? 'Registra un artículo y luego carga su existencia inicial.'
                      : 'Los ajustes de inventario aparecerán aquí con su fecha, motivo y usuario.'
                }
              />
            )
          )}
        </div>
        <Pager page={page} total={data.data?.total ?? 0} onChange={setPage} />
      </section>
      {articles && (
        <p className="page-note">
          <Icon name="shield" size={15} /> Precios base sin IVA. Cada ajuste conserva su motivo y
          usuario. <span>F4 · Nuevo artículo</span>
        </p>
      )}
      {editor && (
        <ProductEditor
          key={typeof editor === 'string' ? editor : editor.id}
          api={api}
          product={editor === 'new' ? null : editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}
function ProductEditor({
  api,
  product,
  onClose,
  onSaved,
}: {
  api: Api;
  product: Product | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog
      title={product ? 'Ficha del artículo' : 'Nuevo artículo'}
      subtitle={
        product
          ? 'Actualiza la información comercial del artículo.'
          : 'Registra los datos principales para comenzar a operar.'
      }
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError('');
          const body = {
            name: f.get('name'),
            barcode: f.get('barcode') || null,
            priceUsd: String(f.get('price')).replace(',', '.'),
            taxCategory: f.get('tax'),
          };
          void api(
            product ? '/products/' + product.id : '/products',
            product ? 'PATCH' : 'POST',
            product
              ? { ...body, expectedVersion: product.version }
              : { ...body, barcode: body.barcode ?? undefined, sku: f.get('sku') },
          )
            .then(onSaved)
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <fieldset disabled={busy}>
          <div className="form-content">
            <Feedback error={error} />
            {product?.price_pending && (
              <div className="alert warning">
                Artículo importado. Indica el precio de venta en USD y revisa su IVA para habilitar
                las cotizaciones. Los costos de compra no se usan como precio de venta.
              </div>
            )}
            <div className="form-section-label">IDENTIFICACIÓN</div>
            <div className="form-grid">
              <label>
                Código / SKU
                <input
                  name="sku"
                  autoFocus={!product}
                  defaultValue={product?.sku}
                  required
                  maxLength={64}
                  readOnly={!!product}
                  placeholder="Ej. ART-0001"
                />
              </label>
              <label>
                Código de barras
                <input
                  name="barcode"
                  defaultValue={product?.barcode ?? ''}
                  maxLength={64}
                  placeholder="Opcional"
                />
              </label>
            </div>
            <label>
              Descripción del artículo
              <input
                name="name"
                autoFocus={!!product}
                defaultValue={product?.name}
                required
                maxLength={200}
                placeholder="Nombre comercial del producto"
              />
            </label>
            <div className="form-section-label">PRECIO E IMPUESTO</div>
            <div className="form-grid">
              <label>
                Precio USD sin IVA
                <input
                  name="price"
                  inputMode="decimal"
                  defaultValue={product?.price_usd}
                  required
                  pattern="(0|[1-9][0-9]{0,11})([.,][0-9]{1,6})?"
                  placeholder="0.00"
                />
              </label>
              <label>
                IVA
                <select
                  name="tax"
                  aria-label="IVA"
                  defaultValue={product?.tax_category ?? 'general'}
                >
                  <option value="general">General · 16 %</option>
                  <option value="reduced">Reducido · 8 %</option>
                  <option value="exempt">Exento</option>
                </select>
              </label>
            </div>
            <p className="form-hint">
              El precio se guarda en USD sin IVA. La existencia se registra mediante un movimiento
              de inventario.
            </p>
          </div>
          <footer className="dialog-footer">
            <Button onClick={onClose}>Cancelar</Button>
            <Button type="submit" variant="primary" icon="check">
              {busy ? 'Guardando…' : product ? 'Guardar cambios' : 'Crear artículo'}
            </Button>
          </footer>
        </fieldset>
      </form>
    </Dialog>
  );
}
