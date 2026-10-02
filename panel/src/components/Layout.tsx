import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth, type Role } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { usd } from '../lib/format';
import { Badge, cx } from './ui';

type NavItem = { to: string; label: string; icon: string; end?: boolean; section?: string };

const NAV: Record<Role, { section: string; items: NavItem[] }[]> = {
  SUPER_ADMIN: [
    { section: 'Overview', items: [
      { to: '/admin', label: 'Dashboard', icon: '◧', end: true, section: 'dashboard' },
      { to: '/admin/reports', label: 'Reports', icon: '◴', section: 'dashboard' },
      { to: '/admin/health', label: 'System health', icon: '❤', section: 'health' },
    ] },
    { section: 'Demand', items: [
      { to: '/admin/vendors', label: 'Vendors', icon: '▤', section: 'vendors' },
      { to: '/admin/campaigns', label: 'Campaigns', icon: '◩', section: 'campaigns' },
      { to: '/admin/moderation', label: 'Creative review', icon: '⚑', section: 'moderation' },
    ] },
    { section: 'Supply', items: [
      { to: '/admin/end-users', label: 'End users', icon: '◍', section: 'endusers' },
      { to: '/admin/impressions', label: 'Delivery log', icon: '≡', section: 'delivery' },
      { to: '/admin/trust-safety', label: 'Trust & safety', icon: '⚠', section: 'delivery' },
    ] },
    { section: 'Finance', items: [
      { to: '/admin/recharges', label: 'Vendor top-ups', icon: '＋', section: 'recharges' },
      { to: '/admin/payouts', label: 'Payouts', icon: '↑', section: 'payouts' },
      { to: '/admin/ledger', label: 'Ledger', icon: '⌗', section: 'ledger' },
    ] },
    { section: 'Platform', items: [
      { to: '/admin/settings', label: 'Settings', icon: '⚙', section: 'settings' },
      { to: '/admin/team', label: 'Team', icon: '◎', section: 'team' },
      { to: '/admin/audit', label: 'Audit log', icon: '◷', section: 'audit' },
      { to: '/security', label: 'Security', icon: '⛨' },
    ] },
  ],
  VENDOR: [
    { section: 'Campaigns', items: [
      { to: '/vendor', label: 'Dashboard', icon: '◧', end: true, section: 'dashboard' },
      { to: '/vendor/campaigns', label: 'Campaigns', icon: '◩', section: 'campaigns' },
      { to: '/vendor/reports', label: 'Reports', icon: '◴', section: 'reports' },
    ] },
    { section: 'Billing', items: [
      { to: '/vendor/wallet', label: 'Wallet', icon: '▤', section: 'wallet' },
      { to: '/vendor/invoices', label: 'Invoices', icon: '⎙', section: 'wallet' },
    ] },
    { section: 'Account', items: [
      { to: '/vendor/team', label: 'Team', icon: '◎', section: 'team' },
      { to: '/vendor/settings', label: 'Settings', icon: '⚙', section: 'settings' },
      { to: '/security', label: 'Security', icon: '⛨' },
    ] },
  ],
  END_USER: [
    { section: 'Earnings', items: [
      { to: '/app', label: 'Dashboard', icon: '◧', end: true },
      { to: '/app/earnings', label: 'Earnings history', icon: '⌗' },
      { to: '/app/payouts', label: 'Withdrawals', icon: '↑' },
    ] },
    { section: 'Setup', items: [
      { to: '/app/devices', label: 'Devices', icon: '◍' },
      { to: '/app/settings', label: 'Ad preferences', icon: '⚙' },
      { to: '/security', label: 'Security', icon: '⛨' },
      { to: '/privacy', label: 'Your data', icon: '◫' },
    ] },
  ],
};

const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Platform admin',
  VENDOR: 'Advertiser',
  END_USER: 'Earner',
};

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-sm font-bold text-white">A</span>
      <span className="text-sm font-semibold tracking-tight text-ink">AdPilot</span>
    </div>
  );
}

export function Shell() {
  const { user, logout, can } = useAuth();
  const { dark, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const scrollRef = useRef<HTMLElement>(null);

  // The window no longer scrolls, so a route change has to rewind the pane.
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [location.pathname]);

  if (!user) return null;
  // A member only sees what they can open — no dead links into a 403.
  const sections = NAV[user.role]
    .map((group) => ({ ...group, items: group.items.filter((it) => !it.section || can(it.section)) }))
    .filter((group) => group.items.length > 0);
  const balance = user.role === 'VENDOR' ? user.vendor?.balanceMicros : user.role === 'END_USER' ? user.publisher?.balanceMicros : null;

  return (
    <div className="flex h-screen overflow-hidden bg-surface supports-[height:100dvh]:h-[100dvh]">
      {/* Sidebar: a full-height flex item on desktop, an overlay drawer below lg. */}
      <aside className={cx(
        'fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-hairline bg-panel transition-transform lg:static lg:z-auto lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full',
      )}>
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-hairline px-4">
          <Logo />
          <button onClick={() => setOpen(false)} className="text-ink-mute lg:hidden" aria-label="Close menu">✕</button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {sections.map((s) => (
            <div key={s.section} className="mb-5">
              <p className="mb-1.5 px-2 text-2xs font-semibold uppercase tracking-wide text-ink-mute">{s.section}</p>
              <ul className="space-y-0.5">
                {s.items.map((it) => (
                  <li key={it.to}>
                    <NavLink to={it.to} end={it.end} onClick={() => setOpen(false)}
                      className={({ isActive }) => cx(
                        'flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition',
                        isActive ? 'bg-brand-soft font-medium text-brand' : 'text-ink-soft hover:bg-surface hover:text-ink',
                      )}>
                      <span className="w-4 text-center text-xs opacity-70" aria-hidden>{it.icon}</span>
                      {it.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-hairline p-3">
          {balance !== null && balance !== undefined && (
            <div className="mb-2 rounded-lg bg-surface px-3 py-2">
              <p className="text-2xs text-ink-mute">{user.role === 'VENDOR' ? 'Wallet balance' : 'Available to withdraw'}</p>
              <p className="tnum text-sm font-semibold text-ink">{usd(balance)}</p>
            </div>
          )}
          <div className="flex items-center gap-2 rounded-lg px-1 py-1">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface text-xs font-semibold text-ink-soft">
              {user.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-ink">{user.name}</p>
              <p className="truncate text-2xs text-ink-mute" title={user.email}>{user.email}</p>
              {user.membership && user.membership.role !== 'OWNER' && (
                <p className="truncate text-2xs text-ink-mute">{user.membership.role.toLowerCase()} access</p>
              )}
            </div>
          </div>
          {/* Always visible and always labelled — signing out should never be a hunt. */}
          <button onClick={logout}
            className="mt-1.5 flex w-full items-center justify-center gap-2 rounded-lg border border-hairline px-2 py-1.5 text-xs font-medium text-ink-soft transition hover:border-bad/40 hover:bg-bad/5 hover:text-bad">
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <path d="M6 14H3.5A1.5 1.5 0 0 1 2 12.5v-9A1.5 1.5 0 0 1 3.5 2H6" strokeLinecap="round" />
              <path d="M10.5 11 14 8l-3.5-3M14 8H6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Sign out
          </button>
        </div>
      </aside>

      {open && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setOpen(false)} />}

      {/* main */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="z-20 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-hairline bg-panel px-4 lg:px-8">
          <button onClick={() => setOpen(true)} className="text-ink-soft lg:hidden" aria-label="Open menu">☰</button>
          <div className="hidden min-w-0 lg:block">
            {user.role === 'VENDOR' && user.vendor && (
              <span className="flex items-center gap-2 text-sm text-ink-soft">
                {user.vendor.companyName}
                {user.vendor.status !== 'ACTIVE' && <Badge tone="warn">{user.vendor.status.toLowerCase()}</Badge>}
              </span>
            )}
            {user.role === 'SUPER_ADMIN' && <span className="text-sm text-ink-soft">Platform console</span>}
            {user.role === 'END_USER' && <span className="text-sm text-ink-soft">Your earnings</span>}
            <span className="sr-only">Signed in as {user.name}, {ROLE_LABEL[user.role]}</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={toggle} aria-label="Toggle theme"
              className="rounded-lg p-2 text-ink-mute hover:bg-surface hover:text-ink">{dark ? '☀' : '☾'}</button>
          </div>
        </header>

        <main ref={scrollRef} data-scroll-container className="flex-1 overflow-y-auto overflow-x-hidden">
          <div key={location.pathname} className="mx-auto w-full max-w-[84rem] animate-fade-in px-4 py-6 lg:px-8 lg:py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

export function Section({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="mb-8">
      {title && (
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
