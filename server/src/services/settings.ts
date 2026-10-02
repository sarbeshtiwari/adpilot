import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';

/** Live platform knobs, editable from the super-admin panel. */
export const SETTING_DEFAULTS = {
  publisher_share_bps: String(env.defaultRevShareBps), // 6000 = end user keeps 60%
  min_payout_micros: '5000000',                        // $5.00 minimum withdrawal
  cpm_floor_micros: '500000',                          // $0.50 minimum CPM bid
  cpc_floor_micros: '20000',                           // $0.02 minimum CPC bid
  min_seconds_between_ads: '45',
  global_ads_enabled: 'true',
  auto_approve_campaigns: 'false',
  auto_approve_vendors: 'false',

  // Withdrawal automation. Off by default — a human releases every payout.
  auto_payout_enabled: 'false',
  auto_payout_min_micros: '10000000',  // only auto-release $10.00 and above
  auto_payout_max_micros: '200000000', // anything over $200.00 needs a human

  // Trust & safety. Flagged events are held unbilled for review rather than
  // paid out; a device past the block score stops being served entirely.
  fraud_flag_score: '70',
  fraud_block_score: '150',
  fraud_hold_flagged: 'true',

  /**
   * Thinking-detection rules for the extension, served at /sdk/detection-config.
   * Kept here so a DOM change at any AI vendor is a settings edit rather than a
   * new extension release waiting on every user to update.
   */
  detection_config: JSON.stringify({
    version: 1,
    rules: [
      { host: 'chatgpt.com', match: '(^|\\.)chatgpt\\.com$|(^|\\.)chat\\.openai\\.com$',
        thinking: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]', '.result-streaming'],
        model: '[data-testid="model-switcher-dropdown-button"]' },
      { host: 'claude.ai', match: '(^|\\.)claude\\.ai$',
        thinking: ['button[aria-label*="Stop" i]', '[data-is-streaming="true"]', '[data-testid="stop-button"]'],
        model: '[data-testid="model-selector-dropdown"]' },
      { host: 'gemini.google.com', match: '(^|\\.)gemini\\.google\\.com$',
        thinking: ['button[aria-label*="Stop" i]', '.stop-icon', 'message-content.streaming'],
        model: '.current-mode-title' },
      { host: 'perplexity.ai', match: '(^|\\.)perplexity\\.ai$',
        thinking: ['button[aria-label*="Stop" i]', '[data-testid="stop-generating"]'] },
      { host: 'grok.com', match: '(^|\\.)grok\\.com$', thinking: ['button[aria-label*="Stop" i]'] },
      { host: 'chat.mistral.ai', match: '(^|\\.)chat\\.mistral\\.ai$', thinking: ['button[aria-label*="Stop" i]'] },
      { host: 'copilot.microsoft.com', match: '(^|\\.)copilot\\.microsoft\\.com$', thinking: ['button[aria-label*="Stop" i]'] },
    ],
  }),
  max_ads_per_hour: '20',
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

let cache: Record<string, string> | null = null;
let cachedAt = 0;
const TTL = 15_000;

export async function allSettings(): Promise<Record<string, string>> {
  if (cache && Date.now() - cachedAt < TTL) return cache;
  const rows = await prisma.systemSetting.findMany();
  const merged: Record<string, string> = { ...SETTING_DEFAULTS };
  for (const r of rows) merged[r.key] = r.value;
  cache = merged;
  cachedAt = Date.now();
  return merged;
}

export async function getSetting(key: SettingKey): Promise<string> {
  return (await allSettings())[key];
}

export async function getNumber(key: SettingKey): Promise<number> {
  return Number(await getSetting(key));
}

export async function getBigInt(key: SettingKey): Promise<bigint> {
  return BigInt(await getSetting(key));
}

export async function getBool(key: SettingKey): Promise<boolean> {
  return (await getSetting(key)) === 'true';
}

export async function setSetting(key: string, value: string, updatedBy?: string) {
  await prisma.systemSetting.upsert({
    where: { key },
    create: { key, value, updatedBy },
    update: { value, updatedBy },
  });
  cache = null;
}
