import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cx } from '../../components/ui';

/** Shared chrome for the three portals, tinted so you always know where you are. */
export function LoginLayout({
  badge, title, subtitle, children, footer, tone = 'brand',
}: {
  badge: string; title: string; subtitle: string; children: ReactNode; footer?: ReactNode;
  tone?: 'brand' | 'admin' | 'earn';
}) {
  const tones = {
    brand: 'bg-brand text-white',
    admin: 'bg-ink text-surface',
    earn: 'bg-good text-white',
  };
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-7 text-center">
          <span className={cx('mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl text-lg font-bold', tones[tone])}>A</span>
          <span className="mb-1.5 inline-block rounded-md border border-hairline px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide text-ink-mute">
            {badge}
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
          <p className="mt-1 text-sm text-ink-mute">{subtitle}</p>
        </div>

        <div className="rounded-xl border border-hairline bg-panel p-6 shadow-card">{children}</div>

        {footer}

        <p className="mt-6 text-center text-2xs text-ink-mute">
          Wrong door? <Link to="/login" className="font-medium text-brand hover:underline">See all sign-in options</Link>
        </p>
      </div>
    </div>
  );
}

export function Divider({ label = 'or' }: { label?: string }) {
  return (
    <div className="my-4 flex items-center gap-3">
      <span className="h-px flex-1 bg-hairline" />
      <span className="text-2xs uppercase tracking-wide text-ink-mute">{label}</span>
      <span className="h-px flex-1 bg-hairline" />
    </div>
  );
}
