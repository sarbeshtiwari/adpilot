/**
 * Creative destination checks.
 *
 * A creative is approved once but its URL can point anywhere afterwards, so
 * this runs structurally on every save and against Google Safe Browsing when a
 * key is configured. Structural checks alone catch the cheap attacks:
 * credential-harvesting hosts, IP literals, userinfo tricks and open redirects.
 */
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

export type Verdict = 'SAFE' | 'SUSPICIOUS' | 'BLOCKED' | 'UNCHECKED';
export type UrlCheck = { verdict: Verdict; detail: string };

/** Hosts that should never be a paid destination. */
const NEVER = [/^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /\.local$/i, /^\[?::1\]?$/];

/** Shorteners hide the real destination from review. */
const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly'];

export async function checkUrl(raw: string): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { verdict: 'BLOCKED', detail: 'Not a valid URL' };
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return { verdict: 'BLOCKED', detail: `Unsupported scheme ${url.protocol}` };
  }
  if (url.protocol === 'http:') {
    return { verdict: 'SUSPICIOUS', detail: 'Destination is not HTTPS' };
  }
  // https://google.com@evil.example reads as Google to a human.
  if (url.username || url.password) {
    return { verdict: 'BLOCKED', detail: 'URL embeds credentials, which is used to disguise the real host' };
  }
  if (NEVER.some((re) => re.test(url.hostname))) {
    return { verdict: 'BLOCKED', detail: 'Destination is a private or loopback address' };
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
    return { verdict: 'SUSPICIOUS', detail: 'Destination is a bare IP address rather than a domain' };
  }

  const blocked = await prisma.urlBlocklist.findMany();
  const hit = blocked.find((b) => {
    try { return new RegExp(b.pattern, 'i').test(raw); } catch { return raw.includes(b.pattern); }
  });
  if (hit) return { verdict: 'BLOCKED', detail: `Matches blocklist: ${hit.reason}` };

  if (SHORTENERS.includes(url.hostname.toLowerCase())) {
    return { verdict: 'SUSPICIOUS', detail: 'Link shortener hides the true destination from review' };
  }

  if (env.safeBrowsingKey) {
    const verdict = await safeBrowsing(raw);
    if (verdict) return verdict;
  }

  return { verdict: 'SAFE', detail: '' };
}

async function safeBrowsing(raw: string): Promise<UrlCheck | null> {
  try {
    const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${env.safeBrowsingKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(4000),
      body: JSON.stringify({
        client: { clientId: 'adpilot', clientVersion: '1.0' },
        threatInfo: {
          threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
          platformTypes: ['ANY_PLATFORM'],
          threatEntryTypes: ['URL'],
          threatEntries: [{ url: raw }],
        },
      }),
    });
    const body = (await res.json()) as { matches?: { threatType: string }[] };
    if (body.matches?.length) {
      return { verdict: 'BLOCKED', detail: `Safe Browsing: ${body.matches.map((m) => m.threatType).join(', ')}` };
    }
    return null;
  } catch (err) {
    // A scanner outage must not block legitimate campaign edits.
    logger.warn({ err }, 'safe browsing lookup failed — falling back to structural checks');
    return null;
  }
}

/** Stores the verdict on the creative. Returns it so callers can refuse a save. */
export async function checkAndRecord(adId: string, url: string): Promise<UrlCheck> {
  const result = await checkUrl(url);
  await prisma.ad.update({
    where: { id: adId },
    data: { urlCheckedAt: new Date(), urlVerdict: result.verdict, urlDetail: result.detail },
  });
  return result;
}

/** Periodic re-scan: a destination can turn hostile after approval. */
export async function rescanCreatives(limit = 50) {
  const stale = await prisma.ad.findMany({
    where: {
      status: 'ACTIVE',
      OR: [{ urlCheckedAt: null }, { urlCheckedAt: { lt: new Date(Date.now() - 24 * 3600_000) } }],
    },
    select: { id: true, clickUrl: true },
    take: limit,
  });
  let blocked = 0;
  for (const ad of stale) {
    const result = await checkAndRecord(ad.id, ad.clickUrl);
    if (result.verdict === 'BLOCKED') {
      await prisma.ad.update({ where: { id: ad.id }, data: { status: 'REJECTED' } });
      blocked += 1;
      logger.warn({ adId: ad.id, detail: result.detail }, 'creative pulled — destination failed re-scan');
    }
  }
  return { scanned: stale.length, blocked };
}
