/**
 * Redis, optional.
 *
 * Everything that uses it degrades to per-process memory when REDIS_URL is
 * unset, so a single node runs with no extra infrastructure. Production
 * requires it (env.ts enforces that) because rate limits and scheduled jobs
 * are wrong when each instance keeps its own copy.
 */
import Redis from 'ioredis';
import { env } from '../env.js';
import { logger } from './logger.js';

let client: Redis | null = null;
let healthy = false;

if (env.redisUrl) {
  client = new Redis(env.redisUrl, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });
  client.on('ready', () => { healthy = true; logger.info('redis connected'); });
  client.on('error', (err) => {
    if (healthy) logger.warn({ err: err.message }, 'redis error — falling back to in-process state');
    healthy = false;
  });
}

export const redis = () => (healthy ? client : null);
export const redisHealthy = () => healthy;

/** Small in-process TTL map used whenever Redis is unavailable. */
const memory = new Map<string, { value: string; expiresAt: number }>();

function sweepMemory() {
  const now = Date.now();
  for (const [k, v] of memory) if (v.expiresAt <= now) memory.delete(k);
}
setInterval(sweepMemory, 60_000).unref();

export const cache = {
  async get(key: string): Promise<string | null> {
    const r = redis();
    if (r) { try { return await r.get(key); } catch { /* fall through */ } }
    const hit = memory.get(key);
    if (!hit || hit.expiresAt <= Date.now()) { memory.delete(key); return null; }
    return hit.value;
  },

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    const r = redis();
    if (r) { try { await r.set(key, value, 'EX', ttlSeconds); return; } catch { /* fall through */ } }
    memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  },

  async del(...keys: string[]): Promise<void> {
    const r = redis();
    if (r) { try { await r.del(...keys); } catch { /* fall through */ } }
    for (const k of keys) memory.delete(k);
  },

  /** Returns the new count. Used for velocity checks, so it must be atomic. */
  async incr(key: string, ttlSeconds: number): Promise<number> {
    const r = redis();
    if (r) {
      try {
        const n = await r.incr(key);
        if (n === 1) await r.expire(key, ttlSeconds);
        return n;
      } catch { /* fall through */ }
    }
    const hit = memory.get(key);
    const n = hit && hit.expiresAt > Date.now() ? Number(hit.value) + 1 : 1;
    memory.set(key, { value: String(n), expiresAt: (hit && hit.expiresAt > Date.now() ? hit.expiresAt : Date.now() + ttlSeconds * 1000) });
    return n;
  },

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await cache.get(key);
    if (!raw) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
  },

  setJson: (key: string, value: unknown, ttlSeconds: number) => cache.set(key, JSON.stringify(value), ttlSeconds),
};

export async function closeRedis() {
  if (client) await client.quit().catch(() => {});
}
