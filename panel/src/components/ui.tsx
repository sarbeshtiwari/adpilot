import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

// ------------------------------------------------------------------ surfaces

export function Card({ children, className, pad = true }: { children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <div className={cx('rounded-xl border border-hairline bg-panel shadow-card', pad && 'p-5', className)}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h3 className="truncate text-sm font-semibold text-ink">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-ink-mute">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-mute">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

// ------------------------------------------------------------------ controls

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  loading?: boolean;
};

export function Button({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }: ButtonProps) {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50';
  const sizes = { sm: 'h-8 px-2.5 text-xs', md: 'h-9 px-3.5 text-sm' };
  const variants = {
    primary: 'bg-brand text-white hover:brightness-110 active:brightness-95',
    secondary: 'border border-hairline bg-panel text-ink hover:bg-surface',
    ghost: 'text-ink-soft hover:bg-surface hover:text-ink',
    danger: 'bg-bad text-white hover:brightness-110',
  };
  return (
    <button className={cx(base, sizes[size], variants[variant], className)} disabled={disabled || loading} {...rest}>
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-soft">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-bad">{error}</span>
        : hint ? <span className="mt-1 block text-xs text-ink-mute">{hint}</span> : null}
    </label>
  );
}

const inputCls = 'w-full rounded-lg border border-hairline bg-panel px-3 py-2 text-sm text-ink placeholder:text-ink-mute focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:opacity-60';

export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => (
  <input {...p} className={cx(inputCls, p.className)} />
);

export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} className={cx(inputCls, 'appearance-none bg-no-repeat pr-8', p.className)}
    style={{ backgroundImage: 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 12 12\'><path d=\'M3 4.5 6 8l3-3.5\' fill=\'none\' stroke=\'%23888\' stroke-width=\'1.5\'/></svg>")', backgroundPosition: 'right .6rem center', backgroundSize: '12px', ...p.style }} />
);

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2.5 text-sm text-ink">
      <span className={cx('relative h-5 w-9 rounded-full transition', checked ? 'bg-brand' : 'bg-hairline')}>
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-[1.125rem]' : 'left-0.5')} />
      </span>
      {label}
    </button>
  );
}

// ------------------------------------------------------------------ feedback

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx('animate-spin', className ?? 'h-4 w-4')} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-ink-mute">
      <Spinner /> {label}…
    </div>
  );
}

export function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className="rounded-lg border border-bad/30 bg-bad/5 px-4 py-3 text-sm text-bad">
      <div className="flex items-center justify-between gap-3">
        <span>{msg}</span>
        {retry && <Button size="sm" variant="ghost" onClick={retry}>Retry</Button>}
      </div>
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-hairline py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="max-w-sm text-xs text-ink-mute">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'brand';
const TONES: Record<Tone, string> = {
  neutral: 'bg-surface text-ink-soft border-hairline',
  good: 'bg-good/10 text-good border-good/25',
  warn: 'bg-warn/10 text-warn border-warn/30',
  bad: 'bg-bad/10 text-bad border-bad/25',
  brand: 'bg-brand-soft text-brand border-brand/25',
};

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-2xs font-medium', TONES[tone])}>
      {children}
    </span>
  );
}

/** Status colours are reserved — they always ship with the label, never colour alone. */
const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: 'good', COMPLETED: 'neutral', PAUSED: 'warn', DRAFT: 'neutral',
  PENDING_REVIEW: 'warn', PENDING: 'warn', REJECTED: 'bad', SUSPENDED: 'bad',
  VIEWED: 'neutral', CLICKED: 'good', SERVED: 'brand', EXPIRED: 'neutral', VOID: 'bad',
  REQUESTED: 'warn', APPROVED: 'brand', PAID: 'good', FAILED: 'bad', healthy: 'good', degraded: 'warn',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{status.replace(/_/g, ' ').toLowerCase()}</Badge>;
}

// ------------------------------------------------------------------ data

export function StatTile({
  label, value, sub, delta, tone,
}: { label: string; value: ReactNode; sub?: ReactNode; delta?: number | null; tone?: Tone }) {
  return (
    <Card className="min-w-0">
      <p className="truncate text-xs font-medium text-ink-mute">{label}</p>
      <p className={cx('tnum mt-1.5 truncate text-2xl font-semibold tracking-tight', tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-bad' : 'text-ink')}>
        {value}
      </p>
      <div className="mt-1 flex items-center gap-2">
        {delta !== undefined && delta !== null && (
          <span className={cx('tnum text-xs font-medium', delta >= 0 ? 'text-good' : 'text-bad')}>
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}%
          </span>
        )}
        {sub && <span className="truncate text-xs text-ink-mute">{sub}</span>}
      </div>
    </Card>
  );
}

export function Table({ head, children, empty, minWidth }: {
  head: ReactNode[]; children: ReactNode; empty?: boolean; minWidth?: string;
}) {
  // Cells carry their own px-5, which lines the table up with the card padding —
  // it must not be pulled outside the card. The floor scales with the column
  // count so a ten-column log scrolls instead of crushing every cell.
  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth: minWidth ?? `${Math.max(head.length * 6.5, 34)}rem` }}>
        <thead>
          <tr className="border-y border-hairline bg-surface/60 text-left">
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-5 py-2.5 text-2xs font-semibold uppercase tracking-wide text-ink-mute">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {empty ? (
            <tr><td colSpan={head.length} className="px-5 py-10 text-center text-sm text-ink-mute">Nothing here yet</td></tr>
          ) : children}
        </tbody>
      </table>
    </div>
  );
}

export const Td = ({ children, className, title }: { children: ReactNode; className?: string; title?: string }) => (
  <td className={cx('px-5 py-3 align-middle text-ink-soft', className)} title={title}>{children}</td>
);

export function Pagination({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-hairline px-5 py-3 text-xs text-ink-mute">
      <span className="tnum">Page {page} of {pages}</span>
      <div className="flex gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string; count?: number }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-hairline">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)}
          className={cx('relative whitespace-nowrap px-3 py-2 text-sm font-medium transition',
            active === t.id ? 'text-brand' : 'text-ink-mute hover:text-ink')}>
          {t.label}
          {t.count !== undefined && <span className="tnum ml-1.5 text-xs text-ink-mute">{t.count}</span>}
          {active === t.id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand" />}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ overlay

export function Modal({ open, onClose, title, children, footer, wide }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.documentElement.classList.add('modal-open');
    return () => { document.removeEventListener('keydown', onKey); document.documentElement.classList.remove('modal-open'); };
  }, [open, onClose]);

  if (!open) return null;

  // Rendered into <body>: a `fixed` overlay is only viewport-fixed while no
  // ancestor has a transform/filter/containment, and the app shell has both a
  // transformed page wrapper and overflow-clipped scroll panes.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" onClick={onClose}>
      <div className={cx('max-h-[90vh] w-full overflow-y-auto rounded-t-2xl bg-panel shadow-pop animate-pop-in sm:rounded-2xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}
        onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-hairline bg-panel px-5 py-3.5">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-mute hover:bg-surface hover:text-ink">✕</button>
        </div>
        <div className="p-5">{children}</div>
        {footer && <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-hairline bg-panel px-5 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ toast

type Toast = { id: number; msg: string; tone: 'good' | 'bad' };
const ToastCtx = createContext<{ push: (msg: string, tone?: 'good' | 'bad') => void }>({ push: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((msg: string, tone: 'good' | 'bad' = 'good') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, msg, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4000);
  }, []);
  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} role="status"
            className={cx('pointer-events-auto rounded-lg border px-4 py-2.5 text-sm shadow-pop animate-fade-in',
              t.tone === 'good' ? 'border-good/30 bg-panel text-ink' : 'border-bad/30 bg-panel text-bad')}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Range picker shared by every dashboard — one filter row above the charts. */
export function RangePicker({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  const opts = [7, 14, 30, 90];
  return (
    <div className="inline-flex rounded-lg border border-hairline bg-panel p-0.5" role="group" aria-label="Date range">
      {opts.map((d) => (
        <button key={d} onClick={() => onChange(d)}
          className={cx('rounded-md px-2.5 py-1 text-xs font-medium transition',
            days === d ? 'bg-brand text-white' : 'text-ink-mute hover:text-ink')}>
          {d}d
        </button>
      ))}
    </div>
  );
}
