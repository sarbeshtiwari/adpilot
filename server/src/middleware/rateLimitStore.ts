import type { Store, Options, ClientRateLimitInfo } from 'express-rate-limit';
import { cache, redisHealthy } from '../lib/redis.js';

/**
 * Rate-limit store backed by the shared cache.
 *
 * The default store is per-process, so N instances silently allow N times the
 * intended limit. This keeps one counter for the whole fleet, and degrades to
 * the same in-process map the cache uses when Redis is unavailable.
 */
export class SharedStore implements Store {
  private windowMs = 60_000;
  prefix: string;

  constructor(prefix: string) {
    this.prefix = `rl:${prefix}:`;
  }

  init(options: Options) {
    this.windowMs = options.windowMs;
  }

  private key(k: string) {
    // Bucketed by window so the counter expires naturally.
    return `${this.prefix}${Math.floor(Date.now() / this.windowMs)}:${k}`;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const ttl = Math.ceil(this.windowMs / 1000) + 1;
    const totalHits = await cache.incr(this.key(key), ttl);
    const windowEnd = (Math.floor(Date.now() / this.windowMs) + 1) * this.windowMs;
    return { totalHits, resetTime: new Date(windowEnd) };
  }

  async decrement(key: string): Promise<void> {
    const k = this.key(key);
    const current = Number((await cache.get(k)) ?? 0);
    if (current > 0) await cache.set(k, String(current - 1), Math.ceil(this.windowMs / 1000) + 1);
  }

  async resetKey(key: string): Promise<void> {
    await cache.del(this.key(key));
  }

  get localKeys() { return !redisHealthy(); }
}
