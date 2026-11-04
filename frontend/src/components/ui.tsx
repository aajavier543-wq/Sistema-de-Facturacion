import { useEffect, useRef, type ReactNode } from 'react';
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    box: (
      <>
        <path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v9l9 5 9-5V8M12 13v9M7 5.8l9 5" />
      </>
    ),
    file: (
      <>
        <path d="M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 12h8M8 16h8" />
      </>
    ),
    chart: (
      <>
        <path d="M4 3v17h17M8 15v-4m5 4V7m5 8V4" />
      </>
    ),
    building: (
      <>
        <path d="M4 22V4h12v18M16 10h5v12M1 22h22M8 8h1m3 0h1M8 12h1m3 0h1M8 16h1m3 0h1" />
      </>
    ),
    arrows: (
      <>
        <path d="M3 7h17l-4-4M21 17H4l4 4M20 7l-4 4M4 17l4-4" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="7" />
        <path d="m16 16 5 5" />
      </>
    ),
    plus: <path d="M12 4v16M4 12h16" />,
    refresh: <path d="M20 7a9 9 0 1 0 1 8M20 2v6h-6" />,
    edit: (
      <>
        <path d="m15 4 5 5-11 11H4v-5L15 4Z" />
        <path d="m12 7 5 5" />
      </>
    ),
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    logout: <path d="M9 4H4v16h5m4-12 4 4-4 4M9 12h12" />,
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9 9a3 3 0 1 1 4 3c-1 .5-1 1-1 2m0 3h.01" />
      </>
    ),
    check: <path d="m5 12 4 4L20 5" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l4 2" />
      </>
    ),
    print: (
      <>
        <path d="M6 8V3h12v5M6 17H3V8h18v9h-3M6 14h12v7H6v-7Z" />
      </>
    ),
    shield: (
      <>
        <path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    wallet: (
      <>
        <rect x="3" y="5" width="18" height="15" rx="2" />
        <path d="M3 8h18m-6 4h6v5h-6v-5Z" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.file}
    </svg>
  );
}
export function Button({
  children,
  icon,
  onClick,
  disabled,
  type = 'button',
  variant = 'secondary',
  title,
}: {
  children?: ReactNode;
  icon?: string;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  title?: string;
}) {
  return (
    <button
      type={type}
      className={'btn ' + variant}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon && <Icon name={icon} size={16} />} {children}
    </button>
  );
}
export function Empty({
  title,
  description,
  icon = 'box',
}: {
  title: string;
  description: string;
  icon?: string;
}) {
  return (
    <div className="empty">
      <span>
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
export function Feedback({ error, notice }: { error?: string; notice?: string }) {
  return (
    <>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="alert success" role="status">
          <Icon name="check" />
          {notice}
        </div>
      )}
    </>
  );
}
export function Pager({
  page,
  total,
  limit = 20,
  onChange,
}: {
  page: number;
  total: number;
  limit?: number;
  onChange: (page: number) => void;
}) {
  return (
    <div className="pager">
      <span>
        {total
          ? `${page * limit + 1}–${Math.min((page + 1) * limit, total)} de ${total} registros`
          : '0 registros'}
      </span>
      <div>
        <Button disabled={!page} onClick={() => onChange(page - 1)}>
          Anterior
        </Button>
        <span>Página {page + 1}</span>
        <Button disabled={(page + 1) * limit >= total} onClick={() => onChange(page + 1)}>
          Siguiente
        </Button>
      </div>
    </div>
  );
}
export function Dialog({
  title,
  subtitle,
  onClose,
  children,
  busy = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <div>
          <span className="eyebrow">NEXO ADMINISTRATIVO</span>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Cerrar ventana"
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>
  );
}
