/**
 * Day bucketing.
 *
 * Budgets, pacing and reports are all "per day", and which day that is depends
 * on who is asking. Everything derives from an explicit IANA timezone rather
 * than from UTC, so an advertiser in Asia/Kolkata sees their own days.
 */
import { env } from '../env.js';

/** YYYY-MM-DD as seen in `timeZone`. */
export function dayKeyIn(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '01';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The platform's own accounting day — what daily budgets reset against. */
export const platformDayKey = (date = new Date()) => dayKeyIn(date, env.platformTimezone);

/** Start of the local day containing `date`, as an absolute instant. */
export function startOfDayIn(date: Date, timeZone: string): Date {
  const key = dayKeyIn(date, timeZone);
  // Find the UTC instant whose local date is `key` at 00:00 by correcting for
  // the zone's offset at that moment.
  const guess = new Date(`${key}T00:00:00Z`);
  const offsetMs = guess.getTime() - new Date(guess.toLocaleString('en-US', { timeZone })).getTime();
  return new Date(guess.getTime() + offsetMs);
}

export const startOfPlatformDay = (date = new Date()) => startOfDayIn(date, env.platformTimezone);

/** True when the string is a timezone this runtime recognises. */
export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export const resolveTimeZone = (requested?: string | null) =>
  requested && isValidTimeZone(requested) ? requested : env.platformTimezone;
