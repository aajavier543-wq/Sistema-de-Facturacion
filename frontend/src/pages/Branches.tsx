import { useState } from 'react';
import { Button, Dialog, Empty, Feedback, Icon } from '../components/ui';
import type { Api, Branch } from '../types';
export function Branches({
  api,
  branches,
  branch,
  admin,
  onSelect,
  onChanged,
}: {
  api: Api;
  branches: Branch[];
  branch: string;
  admin: boolean;
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="overline">ORGANIZACIÓN / ESTABLECIMIENTOS</span>
          <h1>Sucursales</h1>
          <p>Organiza los establecimientos y cambia tu ámbito de trabajo.</p>
        </div>
        {admin && (
          <Button
            icon="plus"
            variant="primary"
            onClick={() => {
              setError('');
              setOpen(true);
            }}
          >
            Nueva sucursal
          </Button>
        )}
      </div>
      <div className="branch-grid">
        {branches.map((b, index) => (
          <section className={'panel branch-card ' + (b.id === branch ? 'current' : '')} key={b.id}>
            <div className="branch-card-top">
              <span className="stat-icon blue">
                <Icon name="building" size={25} />
              </span>
              <span className={'badge ' + (b.id === branch ? 'green' : 'neutral')}>
                {b.id === branch ? 'En uso' : 'Disponible'}
              </span>
            </div>
            <small className="overline">ESTABLECIMIENTO {String(index + 1).padStart(2, '0')}</small>
            <h2>{b.name}</h2>
            <p>Inventario y movimientos independientes por sucursal.</p>
            <Button icon="check" disabled={b.id === branch} onClick={() => onSelect(b.id)}>
              {b.id === branch ? 'Sucursal seleccionada' : 'Trabajar en esta sucursal'}
            </Button>
          </section>
        ))}
      </div>
      {!branches.length && (
        <section className="panel">
          <Empty
            title="No tienes sucursales accesibles"
            description={
              admin
                ? 'Crea la primera sucursal para comenzar.'
                : 'Solicita al administrador que te asigne una sucursal.'
            }
            icon="building"
          />
        </section>
      )}
      {open && (
        <Dialog
          title="Nueva sucursal"
          subtitle="Agregar un establecimiento a la empresa actual"
          onClose={() => setOpen(false)}
          busy={busy}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              setBusy(true);
              setError('');
              void api('/branches', 'POST', { name: f.get('name') })
                .then(() => {
                  setOpen(false);
                  onChanged();
                })
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <fieldset disabled={busy}>
              <div className="form-content">
                <Feedback error={error} />
                <label>
                  Nombre de la sucursal
                  <input
                    name="name"
                    autoFocus
                    required
                    maxLength={120}
                    placeholder="Ej. Sucursal Centro"
                  />
                </label>
                <p className="form-hint">
                  La sucursal se crea sin existencias. Los permisos de otros usuarios se administran
                  por separado.
                </p>
              </div>
              <footer className="dialog-footer">
                <Button onClick={() => setOpen(false)}>Cancelar</Button>
                <Button variant="primary" type="submit">
                  {busy ? 'Guardando…' : 'Crear sucursal'}
                </Button>
              </footer>
            </fieldset>
          </form>
        </Dialog>
      )}
    </>
  );
}
