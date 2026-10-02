/** Pure logic: the pieces where a subtle bug silently costs money. */
import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateRecoveryCodes, generateSecret, otpauthUri, verifyTotp } from '../src/lib/totp.js';
import { splitRevenue, usdToMicros, microsToUsd, MICROS_PER_USD } from '../src/lib/money.js';
import { geoMatches, geoSpecificity } from '../src/lib/geo.js';
import { can, sanitiseGrants, allGrants, readOnlyGrants } from '../src/lib/permissions.js';
import { dayKeyIn, isValidTimeZone, resolveTimeZone } from '../src/lib/time.js';
import { taxBreakdown, withholdingFor } from '../src/services/invoicing.js';
import { checkUrl } from '../src/services/urlSafety.js';

describe('money', () => {
  it('round-trips USD through micros without drift', () => {
    for (const usd of [0.01, 0.0001, 1, 2.5, 999.99, 123456.78]) {
      expect(microsToUsd(usdToMicros(usd))).toBeCloseTo(usd, 6);
    }
  });

  it('never loses a micro when splitting revenue', () => {
    for (const gross of [1n, 7n, 3200n, 450_000n, 1_000_000n, 999_999n]) {
      for (const bps of [0, 1, 6000, 9999, 10000]) {
        const { publisherMicros, platformMicros } = splitRevenue(gross, bps);
        expect(publisherMicros + platformMicros).toBe(gross);
        expect(publisherMicros).toBeGreaterThanOrEqual(0n);
        expect(platformMicros).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  it('gives the rounding remainder to the platform, never the other way', () => {
    // 60% of 7 micros is 4.2 — the earner gets 4, not 5.
    expect(splitRevenue(7n, 6000).publisherMicros).toBe(4n);
    expect(splitRevenue(7n, 6000).platformMicros).toBe(3n);
  });

  it('treats one USD as a million micros', () => {
    expect(usdToMicros(1)).toBe(MICROS_PER_USD);
  });
});

describe('TOTP', () => {
  it('round-trips base32', () => {
    const buf = Buffer.from('a slightly awkward length');
    expect(base32Decode(base32Encode(buf)).toString()).toBe(buf.toString());
  });

  it('accepts a code it just generated and rejects a wrong one', async () => {
    const secret = generateSecret();
    // Derive the current code the same way a phone would.
    const { createHmac } = await import('node:crypto');
    const counter = Math.floor(Date.now() / 1000 / 30);
    const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter));
    const h = createHmac('sha1', base32Decode(secret)).update(b).digest();
    const o = h[h.length - 1] & 15;
    const n = ((h[o] & 127) << 24) | ((h[o + 1] & 255) << 16) | ((h[o + 2] & 255) << 8) | (h[o + 3] & 255);
    const code = String(n % 1e6).padStart(6, '0');

    expect(verifyTotp(secret, code)).toBe(true);
    expect(verifyTotp(secret, '000000')).toBe(false);
    expect(verifyTotp(secret, 'abcdef')).toBe(false);
    expect(verifyTotp(secret, '')).toBe(false);
  });

  it('builds an otpauth URI an authenticator app can read', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'person@example.com');
    expect(uri).toMatch(/^otpauth:\/\/totp\/AdPilot:person%40example\.com\?/);
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('issues distinct recovery codes', () => {
    const codes = generateRecoveryCodes(8);
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const c of codes) expect(c).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });
});

describe('geo targeting', () => {
  const geo = { country: 'IN', state: 'Karnataka', city: 'Bengaluru', area: 'Koramangala' };
  const rule = (o: Partial<Record<string, string>> = {}) =>
    ({ mode: 'INCLUDE', country: '*', state: '*', city: '*', area: '*', ...o });

  it('treats no rules as worldwide', () => {
    expect(geoMatches([], geo)).toBe(true);
  });

  it('matches at every level', () => {
    expect(geoMatches([rule({ country: 'IN' })], geo)).toBe(true);
    expect(geoMatches([rule({ country: 'IN', state: 'Karnataka' })], geo)).toBe(true);
    expect(geoMatches([rule({ area: 'Koramangala' })], geo)).toBe(true);
    expect(geoMatches([rule({ country: 'US' })], geo)).toBe(false);
  });

  it('ignores case', () => {
    expect(geoMatches([rule({ city: 'bengaluru' })], geo)).toBe(true);
  });

  it('lets an exclusion beat an inclusion', () => {
    const rules = [rule({ country: 'IN' }), rule({ mode: 'EXCLUDE', city: 'Bengaluru' })];
    expect(geoMatches(rules, geo)).toBe(false);
  });

  it('scores a narrower rule above a broader one', () => {
    const broad = geoSpecificity([rule({ country: 'IN' })], geo);
    const narrow = geoSpecificity([rule({ country: 'IN', state: 'Karnataka', city: 'Bengaluru', area: 'Koramangala' })], geo);
    expect(narrow).toBeGreaterThan(broad);
  });
});

describe('permissions', () => {
  const member = (grants: string[]) => ({ isOwner: false, grants: new Set(grants) });

  it('lets an owner do anything', () => {
    expect(can({ isOwner: true, grants: new Set() }, 'ledger', 'delete')).toBe(true);
  });

  it('grants exactly what was given', () => {
    const actor = member(['campaigns:read', 'campaigns:update']);
    expect(can(actor, 'campaigns', 'read')).toBe(true);
    expect(can(actor, 'campaigns', 'update')).toBe(true);
    expect(can(actor, 'campaigns', 'delete')).toBe(false);
    expect(can(actor, 'wallet', 'read')).toBe(false);
  });

  it('implies read from any mutating grant', () => {
    // "can edit but cannot see" is not a coherent state.
    expect(can(member(['wallet:create']), 'wallet', 'read')).toBe(true);
  });

  it('drops grants that are not real for the scope', () => {
    expect(sanitiseGrants('VENDOR', ['campaigns:read', 'nonsense:delete', 'ledger:read'])).toEqual(['campaigns:read']);
  });

  it('keeps the presets inside the catalogue', () => {
    for (const scope of ['PLATFORM', 'VENDOR'] as const) {
      const all = new Set(allGrants(scope));
      for (const g of readOnlyGrants(scope)) expect(all.has(g)).toBe(true);
    }
  });
});

describe('day bucketing', () => {
  it('uses the viewer timezone, not UTC', () => {
    // 22:00 UTC is already the next day in Kolkata (+5:30).
    const instant = new Date('2026-03-10T22:00:00Z');
    expect(dayKeyIn(instant, 'UTC')).toBe('2026-03-10');
    expect(dayKeyIn(instant, 'Asia/Kolkata')).toBe('2026-03-11');
    expect(dayKeyIn(instant, 'America/Los_Angeles')).toBe('2026-03-10');
  });

  it('falls back when handed a nonsense timezone', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(resolveTimeZone('Mars/Olympus')).not.toBe('Mars/Olympus');
  });
});

describe('tax', () => {
  it('splits a tax-inclusive amount back out', () => {
    const { netMicros, taxMicros, totalMicros } = taxBreakdown(usdToMicros(118), 1800);
    expect(netMicros + taxMicros).toBe(totalMicros);
    expect(microsToUsd(netMicros)).toBeCloseTo(100, 2);
    expect(microsToUsd(taxMicros)).toBeCloseTo(18, 2);
  });

  it('withholds nothing when the rate is zero', () => {
    const r = withholdingFor(1_000_000n, 0);
    expect(r.withheldMicros).toBe(0n);
    expect(r.netMicros).toBe(1_000_000n);
  });

  it('never withholds more than the amount', () => {
    const r = withholdingFor(1_000_000n, 3000);
    expect(r.withheldMicros + r.netMicros).toBe(1_000_000n);
  });
});

describe('creative destination safety', () => {
  it('accepts an ordinary https URL', async () => {
    expect((await checkUrl('https://example.com/landing')).verdict).toBe('SAFE');
  });

  it('blocks credentials embedded in the host', async () => {
    // https://google.com@evil.example reads as Google to a human.
    expect((await checkUrl('https://google.com@evil.example/x')).verdict).toBe('BLOCKED');
  });

  it('blocks private and loopback destinations', async () => {
    for (const url of ['https://localhost/x', 'https://127.0.0.1/x', 'https://192.168.1.1/x']) {
      expect((await checkUrl(url)).verdict).toBe('BLOCKED');
    }
  });

  it('blocks non-web schemes', async () => {
    expect((await checkUrl('javascript:alert(1)')).verdict).toBe('BLOCKED');
    expect((await checkUrl('not a url')).verdict).toBe('BLOCKED');
  });

  it('flags plain http and link shorteners rather than blocking', async () => {
    expect((await checkUrl('http://example.com')).verdict).toBe('SUSPICIOUS');
    expect((await checkUrl('https://bit.ly/abc')).verdict).toBe('SUSPICIOUS');
  });
});

describe('rate limiting', () => {
  it('counts within a window and resets after it', async () => {
    const { SharedStore } = await import('../src/middleware/rateLimitStore.js');
    const store = new SharedStore(`test-${Date.now()}`);
    store.init({ windowMs: 1000 } as never);

    const first = await store.increment('same-client');
    const second = await store.increment('same-client');
    const other = await store.increment('different-client');

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    // Clients are counted independently.
    expect(other.totalHits).toBe(1);
    expect(second.resetTime!.getTime()).toBeGreaterThan(Date.now());

    // A new window starts a fresh count.
    await new Promise((r) => setTimeout(r, 1100));
    expect((await store.increment('same-client')).totalHits).toBe(1);
  });

  it('can be reset for one client without touching others', async () => {
    const { SharedStore } = await import('../src/middleware/rateLimitStore.js');
    const store = new SharedStore(`test-reset-${Date.now()}`);
    store.init({ windowMs: 5000 } as never);
    await store.increment('a');
    await store.increment('a');
    await store.increment('b');
    await store.resetKey('a');
    expect((await store.increment('a')).totalHits).toBe(1);
    expect((await store.increment('b')).totalHits).toBe(2);
  });
});
