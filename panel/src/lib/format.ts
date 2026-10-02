/** Money arrives from the API as a micro-USD string; never parse it as a float. */
export const toUsd = (micros: string | number | bigint | null | undefined): number =>
  Number(micros ?? 0) / 1_000_000;

export function usd(micros: string | number | bigint | null | undefined, opts: { precise?: boolean } = {}) {
  const v = toUsd(micros);
  const digits = opts.precise ? 4 : Math.abs(v) >= 1000 ? 0 : 2;
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Compact money for stat tiles and axis ticks: $1.2k, $840, $0.90, $0.0041 */
export function usdCompact(micros: string | number | bigint | null | undefined) {
  const v = toUsd(micros);
  const abs = Math.abs(v);
  if (abs >= 1000) return `$${(v / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`;
  if (abs >= 1) return `$${v.toFixed(2)}`;
  if (v === 0) return '$0.00';
  // Sub-dollar amounts keep two decimals until they would round to zero; only
  // then do we spend the extra characters on a four-decimal tick.
  return `$${v.toFixed(abs >= 0.01 ? 2 : 4)}`;
}

export const num = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-US');

export const compact = (n: number | null | undefined) =>
  (n ?? 0) >= 10000 ? `${((n ?? 0) / 1000).toFixed(1)}k` : (n ?? 0).toLocaleString('en-US');

export const pct = (n: number | null | undefined, digits = 2) => `${((n ?? 0) * 100).toFixed(digits)}%`;

export function dateShort(d: string | Date) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function dateTime(d: string | Date | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function relative(d: string | Date | null | undefined) {
  if (!d) return 'never';
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 30 ? `${days}d ago` : new Date(d).toLocaleDateString();
}

export function duration(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export const titleCase = (s: string) =>
  s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
