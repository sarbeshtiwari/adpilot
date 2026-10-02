/**
 * AdPilot service worker.
 *
 * Content scripts never talk to the API directly — every request is proxied
 * through here. That keeps the device key out of the page context (so a hostile
 * page cannot read it) and keeps the API's CORS surface to one origin.
 */

const DEFAULT_API = 'http://localhost:4000/api';

const store = {
  async get(keys) { return chrome.storage.local.get(keys); },
  async set(obj) { return chrome.storage.local.set(obj); },
  async clear(keys) { return chrome.storage.local.remove(keys); },
};

async function apiBase() {
  const { apiBase } = await store.get('apiBase');
  return apiBase || DEFAULT_API;
}

async function deviceKey() {
  const { deviceKey } = await store.get('deviceKey');
  return deviceKey || null;
}

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const base = await apiBase();
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const key = await deviceKey();
    if (!key) throw new Error('This device is not paired yet');
    headers['x-adpilot-key'] = key;
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function platform() {
  const p = navigator.userAgentData?.platform || navigator.platform || '';
  if (/mac/i.test(p)) return 'macOS';
  if (/win/i.test(p)) return 'Windows';
  if (/linux/i.test(p)) return 'Linux';
  return p || 'Unknown';
}

// ------------------------------------------------------------------ actions

async function pair(code) {
  const version = chrome.runtime.getManifest().version;
  const data = await call('/sdk/pair', {
    auth: false,
    method: 'POST',
    body: { code, label: `${platform()} · Chrome`, platform: platform(), browser: 'Chrome', extVersion: version },
  });
  await store.set({ deviceKey: data.deviceKey, publisher: data.publisher, pairedAt: Date.now() });
  await refreshConfig();
  return data;
}

async function unpair() {
  await store.clear(['deviceKey', 'publisher', 'config', 'pairedAt']);
  return { ok: true };
}

async function refreshConfig() {
  const data = await call('/sdk/config');
  await store.set({ config: data.publisher, configAt: Date.now() });
  return data.publisher;
}

/**
 * Detection rules come from the server so a DOM change at any AI vendor can be
 * fixed centrally. The last good copy is cached; the content script falls back
 * to its bundled defaults if we have never managed to fetch one.
 */
const DETECTION_TTL_MS = 60 * 60_000;

async function detectionConfig({ force = false } = {}) {
  const { detection, detectionAt } = await store.get(['detection', 'detectionAt']);
  if (!force && detection && Date.now() - (detectionAt ?? 0) < DETECTION_TTL_MS) return detection;
  try {
    const fresh = await call('/sdk/detection-config', { auth: false });
    await store.set({ detection: fresh, detectionAt: Date.now() });
    return fresh;
  } catch {
    // Offline or API down — a stale copy beats no detection at all.
    return detection ?? null;
  }
}

/** Asked for by a content script the moment a model starts thinking. */
async function serve({ hostApp, modelHint }) {
  const { lastAdId, config } = await store.get(['lastAdId', 'config']);
  if (config && config.adsEnabled === false) return { fill: false, reason: 'user_opted_out' };

  const data = await call('/sdk/serve', {
    method: 'POST',
    body: { hostApp, modelHint, excludeAdId: lastAdId || undefined },
  });
  if (data.fill) await store.set({ lastAdId: data.ad.adId });
  return data;
}

async function confirmImpression({ token, dwellMs }) {
  const data = await call('/sdk/impression', { method: 'POST', body: { token, dwellMs } });
  if (data.earnedMicros) await bumpStats({ impressions: 1, micros: Number(data.earnedMicros) });
  return data;
}

async function registerClick({ token }) {
  const data = await call('/sdk/click', { method: 'POST', body: { token } });
  if (data.earnedMicros) await bumpStats({ clicks: 1, micros: Number(data.earnedMicros) });
  if (data.url) chrome.tabs.create({ url: data.url });
  return data;
}

/** Local counters so the popup feels instant without hitting the API. */
async function bumpStats({ impressions = 0, clicks = 0, micros = 0 }) {
  const today = new Date().toISOString().slice(0, 10);
  const { stats } = await store.get('stats');
  const cur = stats?.date === today ? stats : { date: today, impressions: 0, clicks: 0, micros: 0 };
  await store.set({
    stats: {
      date: today,
      impressions: cur.impressions + impressions,
      clicks: cur.clicks + clicks,
      micros: cur.micros + micros,
    },
  });
}

async function status() {
  const { deviceKey, publisher, config, stats, apiBase } = await store.get(['deviceKey', 'publisher', 'config', 'stats', 'apiBase']);
  return {
    paired: Boolean(deviceKey),
    publisher: publisher ?? null,
    config: config ?? null,
    stats: stats ?? null,
    apiBase: apiBase || DEFAULT_API,
    version: chrome.runtime.getManifest().version,
  };
}

const HANDLERS = {
  PAIR: (p) => pair(p.code),
  UNPAIR: () => unpair(),
  STATUS: () => status(),
  REFRESH: () => refreshConfig(),
  SERVE: (p) => serve(p),
  IMPRESSION: (p) => confirmImpression(p),
  CLICK: (p) => registerClick(p),
  SET_API: async (p) => { await store.set({ apiBase: p.apiBase }); return { ok: true }; },
  DETECTION: (p) => detectionConfig(p ?? {}),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown message ${msg?.type}` });
    return false;
  }
  handler(msg.payload ?? {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // keep the channel open for the async reply
});

// Heartbeat: keeps "last seen" fresh and pulls preference changes made in the panel.
chrome.alarms.create('adpilot-heartbeat', { periodInMinutes: 20 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'adpilot-heartbeat') return;
  if (!(await deviceKey())) return;
  try {
    await call('/sdk/heartbeat', { method: 'POST', body: { extVersion: chrome.runtime.getManifest().version } });
    await refreshConfig();
    await detectionConfig({ force: true });
  } catch {
    // Offline or API down — try again at the next alarm.
  }
});
