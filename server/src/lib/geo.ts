import { env } from '../env.js';

export type Geo = { country: string; state: string; city: string; area: string };
export const UNKNOWN_GEO: Geo = { country: 'XX', state: '', city: '', area: '' };

/**
 * Small offline table so the whole stack runs with no third-party key.
 * Set GEO_PROVIDER=ipapi to resolve real client IPs instead.
 */
const LOCAL_RANGES: Array<{ prefix: string; geo: Geo }> = [
  { prefix: '103.', geo: { country: 'IN', state: 'Karnataka', city: 'Bengaluru', area: 'Koramangala' } },
  { prefix: '49.', geo: { country: 'IN', state: 'Maharashtra', city: 'Mumbai', area: 'Andheri' } },
  { prefix: '117.', geo: { country: 'IN', state: 'Delhi', city: 'New Delhi', area: 'Connaught Place' } },
  { prefix: '8.', geo: { country: 'US', state: 'California', city: 'Mountain View', area: 'Downtown' } },
  { prefix: '24.', geo: { country: 'US', state: 'New York', city: 'New York', area: 'Manhattan' } },
  { prefix: '86.', geo: { country: 'GB', state: 'England', city: 'London', area: 'Camden' } },
];

const cache = new Map<string, { geo: Geo; at: number }>();
const CACHE_TTL = 6 * 60 * 60 * 1000;

export function clientIp(headers: Record<string, unknown>, socketIp?: string): string {
  const fwd = headers['x-forwarded-for'];
  const raw = Array.isArray(fwd) ? fwd[0] : typeof fwd === 'string' ? fwd.split(',')[0] : socketIp;
  return (raw ?? '').toString().trim().replace(/^::ffff:/, '') || '127.0.0.1';
}

function isPrivate(ip: string) {
  return (
    ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.') ||
    ip === '::1' || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

export async function resolveGeo(ip: string): Promise<Geo> {
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.geo;

  let geo: Geo = UNKNOWN_GEO;
  if (isPrivate(ip)) {
    // Local development: pretend we're in Bengaluru so targeting demos work.
    geo = { country: 'IN', state: 'Karnataka', city: 'Bengaluru', area: 'Koramangala' };
  } else if (env.geoProvider === 'ipapi' && env.geoApiUrl) {
    try {
      const res = await fetch(env.geoApiUrl.replace('{ip}', ip), { signal: AbortSignal.timeout(2500) });
      const j = (await res.json()) as Record<string, string>;
      if (j.status === 'success') {
        geo = { country: j.countryCode ?? 'XX', state: j.regionName ?? '', city: j.city ?? '', area: j.district ?? '' };
      }
    } catch {
      geo = UNKNOWN_GEO;
    }
  } else {
    geo = LOCAL_RANGES.find((r) => ip.startsWith(r.prefix))?.geo ?? UNKNOWN_GEO;
  }

  cache.set(ip, { geo, at: Date.now() });
  return geo;
}

const norm = (s: string) => s.trim().toLowerCase();

/** A rule segment matches when it is "*" or equals the request value (case-insensitive). */
function segMatches(rule: string, value: string) {
  return rule === '*' || norm(rule) === norm(value);
}

export type GeoRuleLike = { mode: string; country: string; state: string; city: string; area: string };

/** EXCLUDE always wins. With no INCLUDE rules a campaign is treated as worldwide. */
export function geoMatches(rules: GeoRuleLike[], geo: Geo): boolean {
  const hit = (r: GeoRuleLike) =>
    segMatches(r.country, geo.country) && segMatches(r.state, geo.state) &&
    segMatches(r.city, geo.city) && segMatches(r.area, geo.area);

  if (rules.some((r) => r.mode === 'EXCLUDE' && hit(r))) return false;
  const includes = rules.filter((r) => r.mode === 'INCLUDE');
  return includes.length === 0 || includes.some(hit);
}

/** Specificity score — a city-level match outranks a country-level one. */
export function geoSpecificity(rules: GeoRuleLike[], geo: Geo): number {
  let best = 0;
  for (const r of rules.filter((x) => x.mode === 'INCLUDE')) {
    if (!segMatches(r.country, geo.country) || !segMatches(r.state, geo.state) ||
        !segMatches(r.city, geo.city) || !segMatches(r.area, geo.area)) continue;
    const score = (r.country !== '*' ? 1 : 0) + (r.state !== '*' ? 2 : 0) +
                  (r.city !== '*' ? 4 : 0) + (r.area !== '*' ? 8 : 0);
    if (score > best) best = score;
  }
  return best;
}
