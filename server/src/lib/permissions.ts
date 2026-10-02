/**
 * Panel access control. A grant is "<section>:<action>"; OWNER implies all.
 * The same catalogue drives the server guards and the panel's team editor, so
 * the two can never drift apart.
 */
export const ACTIONS = ['read', 'create', 'update', 'delete'] as const;
export type Action = (typeof ACTIONS)[number];

export type SectionDef = { key: string; label: string; description: string; actions: Action[] };

/** Super-admin console. */
export const PLATFORM_SECTIONS: SectionDef[] = [
  { key: 'dashboard', label: 'Dashboard', description: 'Platform totals, revenue and queues', actions: ['read'] },
  { key: 'vendors', label: 'Vendors', description: 'Advertiser accounts, approval and wallet credits', actions: ['read', 'create', 'update', 'delete'] },
  { key: 'campaigns', label: 'Campaigns', description: 'Every campaign across every vendor', actions: ['read', 'update'] },
  { key: 'moderation', label: 'Creative review', description: 'Approve or reject ad creatives', actions: ['read', 'update'] },
  { key: 'endusers', label: 'End users', description: 'Earner accounts, pacing and balance adjustments', actions: ['read', 'update'] },
  { key: 'delivery', label: 'Delivery log', description: 'Raw impression and click records', actions: ['read'] },
  { key: 'recharges', label: 'Vendor top-ups', description: 'Settle and reconcile incoming payments', actions: ['read', 'update'] },
  { key: 'payouts', label: 'Payouts', description: 'Approve and release end-user withdrawals', actions: ['read', 'update'] },
  { key: 'ledger', label: 'Ledger', description: 'The full money journal', actions: ['read'] },
  { key: 'settings', label: 'Platform settings', description: 'Revenue split, bid floors, pacing, automation', actions: ['read', 'update'] },
  { key: 'audit', label: 'Audit log', description: 'Who did what, when', actions: ['read'] },
  { key: 'team', label: 'Team', description: 'Console users and their permissions', actions: ['read', 'create', 'update', 'delete'] },
  { key: 'health', label: 'System health', description: 'Service status and delivery funnel', actions: ['read'] },
];

/** Vendor panel. */
export const VENDOR_SECTIONS: SectionDef[] = [
  { key: 'dashboard', label: 'Dashboard', description: 'Spend, delivery and engagement', actions: ['read'] },
  { key: 'campaigns', label: 'Campaigns', description: 'Create, edit, pause and submit campaigns', actions: ['read', 'create', 'update', 'delete'] },
  { key: 'creatives', label: 'Creatives', description: 'Ad copy, destinations and rotation weights', actions: ['read', 'create', 'update', 'delete'] },
  { key: 'wallet', label: 'Wallet', description: 'Balance, top-ups and billing history', actions: ['read', 'create'] },
  { key: 'reports', label: 'Reports', description: 'Delivery and geography reporting', actions: ['read'] },
  { key: 'team', label: 'Team', description: 'Panel users and their permissions', actions: ['read', 'create', 'update', 'delete'] },
  { key: 'settings', label: 'Settings', description: 'Business details and account security', actions: ['read', 'update'] },
];

export type Scope = 'PLATFORM' | 'VENDOR';

export const sectionsFor = (scope: Scope) => (scope === 'PLATFORM' ? PLATFORM_SECTIONS : VENDOR_SECTIONS);

export const allGrants = (scope: Scope) =>
  sectionsFor(scope).flatMap((s) => s.actions.map((a) => `${s.key}:${a}`));

/** Read-only across everything — the safest starting point for a new member. */
export const readOnlyGrants = (scope: Scope) =>
  sectionsFor(scope).filter((s) => s.actions.includes('read')).map((s) => `${s.key}:read`);

export function parseGrants(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    return [];
  }
}

/** Drops anything that is not a real section:action pair for this scope. */
export function sanitiseGrants(scope: Scope, grants: string[]): string[] {
  const valid = new Set(allGrants(scope));
  return [...new Set(grants.filter((g) => valid.has(g)))].sort();
}

export type Actor = { isOwner: boolean; grants: Set<string> };

export function can(actor: Actor, section: string, action: Action): boolean {
  if (actor.isOwner) return true;
  // Holding any mutating grant implies being able to read the section — there
  // is no coherent "can edit but cannot see" state.
  if (action === 'read') {
    return ACTIONS.some((a) => actor.grants.has(`${section}:${a}`));
  }
  return actor.grants.has(`${section}:${action}`);
}
