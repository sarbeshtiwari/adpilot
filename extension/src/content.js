/**
 * AdPilot content script.
 *
 * Watches the page for the signal that a frontier model has started thinking,
 * asks the service worker for an ad, and renders it in a closed shadow root so
 * the host page can neither style it nor read it.
 */

const MIN_VISIBLE_MS = 2500;   // the card stays at least this long, so a view is real
const GRACE_MS = 6000;         // stays clickable after the answer lands
const MAX_LIFETIME_MS = 90_000;
const SETTLE_MS = 700;         // thinking must persist this long before we ask for an ad

// ------------------------------------------------------------- detection

/**
 * Bundled fallback. The live rules are fetched from the server (see
 * applyRemoteRules below) so a DOM change at an AI vendor can be fixed without
 * shipping a new extension and waiting for every user to update.
 */
const RULES = [
  {
    test: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/,
    host: 'chatgpt.com',
    thinking: () =>
      qs('button[data-testid="stop-button"]') ||
      qs('button[aria-label*="Stop" i]') ||
      qs('.result-streaming'),
    model: () => text('[data-testid="model-switcher-dropdown-button"]'),
  },
  {
    test: /(^|\.)claude\.ai$/,
    host: 'claude.ai',
    thinking: () =>
      qs('button[aria-label*="Stop" i]') ||
      qs('[data-is-streaming="true"]') ||
      qs('[data-testid="stop-button"]'),
    model: () => text('[data-testid="model-selector-dropdown"]'),
  },
  {
    test: /(^|\.)gemini\.google\.com$/,
    host: 'gemini.google.com',
    thinking: () =>
      qs('button[aria-label*="Stop" i]') ||
      qs('.stop-icon') ||
      qs('message-content.streaming'),
    model: () => text('.current-mode-title'),
  },
  {
    test: /(^|\.)perplexity\.ai$/,
    host: 'perplexity.ai',
    thinking: () => qs('button[aria-label*="Stop" i]') || qs('[data-testid="stop-generating"]'),
  },
  { test: /(^|\.)grok\.com$/, host: 'grok.com', thinking: () => qs('button[aria-label*="Stop" i]') },
  { test: /(^|\.)chat\.mistral\.ai$/, host: 'chat.mistral.ai', thinking: () => qs('button[aria-label*="Stop" i]') },
  { test: /(^|\.)copilot\.microsoft\.com$/, host: 'copilot.microsoft.com', thinking: () => qs('button[aria-label*="Stop" i]') },
];

const qs = (sel) => {
  const el = document.querySelector(sel);
  return el && isVisible(el) ? el : null;
};

const text = (sel) => document.querySelector(sel)?.textContent?.trim().slice(0, 60) ?? '';

function isVisible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * Fallback for self-hosted UIs (Open WebUI, LM Studio, Ollama front-ends…).
 * Deliberately narrow: only an accessible name that *starts* with "stop", or an
 * explicit aria-busy region. A looser match produces phantom impressions.
 */
function genericThinking() {
  for (const btn of document.querySelectorAll('button, [role="button"]')) {
    const name = (btn.getAttribute('aria-label') || btn.textContent || '').trim();
    if (/^stop\b/i.test(name) && isVisible(btn)) return btn;
  }
  return qs('[aria-busy="true"]') || qs('[data-streaming="true"]');
}

let rule = RULES.find((r) => r.test.test(location.hostname));
let hostApp = rule?.host ?? location.host;

const isThinking = () => Boolean(rule ? rule.thinking() : genericThinking());
const modelHint = () => (rule?.model ? rule.model() : '');

/**
 * Replaces the bundled rule for this host with the server's, if it has one.
 * Anything malformed is ignored so a bad config cannot break detection.
 */
function applyRemoteRules(config) {
  if (!config?.rules?.length) return;
  for (const remote of config.rules) {
    let re;
    try { re = new RegExp(remote.match); } catch { continue; }
    if (!re.test(location.hostname)) continue;

    const selectors = Array.isArray(remote.thinking) ? remote.thinking : [];
    if (selectors.length === 0) continue;

    rule = {
      test: re,
      host: remote.host ?? location.host,
      thinking: () => selectors.some((sel) => { try { return Boolean(qs(sel)); } catch { return false; } }),
      model: remote.model ? () => { try { return text(remote.model); } catch { return ''; } } : undefined,
    };
    hostApp = rule.host;
    console.debug(`[AdPilot] detection rules v${config.version} applied for ${hostApp}`);
    return;
  }
}

// ------------------------------------------------------------- ad surface

let shadowHost = null;
let shadow = null;
let current = null;       // { token, shownAt, hideTimer, lifetimeTimer }
let thinkingSince = 0;
let serveInFlight = false;
let settleTimer = null;

const STYLES = `
:host { all: initial; }
.wrap {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  width: 320px; max-width: calc(100vw - 40px);
  font: 400 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
  color: #18181b;
  animation: pop .28s cubic-bezier(.2,.9,.3,1) both;
}
@keyframes pop { from { opacity: 0; transform: translateY(10px) scale(.98) } to { opacity: 1; transform: none } }
.wrap.leaving { animation: fade .25s ease-in both }
@keyframes fade { to { opacity: 0; transform: translateY(6px) } }
.card {
  position: relative; overflow: hidden;
  background: #fff; border: 1px solid #e7e5e4; border-left: 3px solid var(--accent, #4f46e5);
  border-radius: 12px; box-shadow: 0 10px 34px -12px rgba(0,0,0,.35), 0 2px 6px rgba(0,0,0,.06);
  padding: 12px 14px 11px;
}
.head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.badge {
  font-size: 9px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase;
  color: #82807c; border: 1px solid #e7e5e4; border-radius: 4px; padding: 1px 4px;
}
.advertiser { font-size: 11px; color: #82807c; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.close {
  all: unset; cursor: pointer; color: #a8a29e; font-size: 13px; line-height: 1;
  padding: 3px 4px; border-radius: 4px;
}
.close:hover { background: #f5f5f4; color: #52514e; }
.headline { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
.body { margin: 3px 0 0; font-size: 12.5px; color: #52514e; }
.thumb { margin-top: 9px; width: 100%; height: 108px; object-fit: cover; border-radius: 7px; display: block; }
.foot { display: flex; align-items: center; gap: 8px; margin-top: 11px; }
.cta {
  all: unset; cursor: pointer; flex: 1; text-align: center;
  background: var(--accent, #4f46e5); color: #fff; font-size: 12px; font-weight: 600;
  padding: 7px 10px; border-radius: 7px; transition: filter .15s;
}
.cta:hover { filter: brightness(1.1); }
.earn { font-size: 11px; font-weight: 600; color: #008300; font-variant-numeric: tabular-nums; white-space: nowrap; }
.rail { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: #f5f5f4; }
.rail > i { display: block; height: 100%; width: 100%; background: var(--accent, #4f46e5); transform-origin: left;
  animation: drain linear forwards; }
@keyframes drain { to { transform: scaleX(0) } }
.why { all: unset; cursor: pointer; font-size: 10px; color: #a8a29e; margin-top: 7px; display: block; }
.why:hover { color: #52514e; text-decoration: underline; }

@media (prefers-color-scheme: dark) {
  .wrap { color: #fafaf9; }
  .card { background: #1a1a19; border-color: #383835; box-shadow: 0 10px 34px -12px rgba(0,0,0,.7); }
  .badge { color: #8f8e86; border-color: #383835; }
  .advertiser, .body { color: #c3c2b7; }
  .close:hover { background: #262624; color: #c3c2b7; }
  .rail { background: #262624; }
}
`;

function mount() {
  if (shadowHost) return;
  shadowHost = document.createElement('div');
  shadowHost.id = 'adpilot-root';
  shadowHost.style.cssText = 'all:initial;position:static';
  shadow = shadowHost.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLES;
  shadow.appendChild(style);
  document.documentElement.appendChild(shadowHost);
}

function render(ad) {
  mount();
  shadow.querySelector('.wrap')?.remove();

  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.style.setProperty('--accent', ad.accent || '#4f46e5');

  const card = document.createElement('div');
  card.className = 'card';

  const head = document.createElement('div');
  head.className = 'head';
  head.innerHTML = `<span class="badge">Sponsored</span><span class="advertiser"></span>`;
  head.querySelector('.advertiser').textContent = ad.advertiser;

  const close = document.createElement('button');
  close.className = 'close';
  close.setAttribute('aria-label', 'Dismiss this ad');
  close.textContent = '✕';
  close.addEventListener('click', (e) => { e.stopPropagation(); dismiss('user_closed'); });
  head.appendChild(close);

  const headline = document.createElement('p');
  headline.className = 'headline';
  headline.textContent = ad.headline;

  const body = document.createElement('p');
  body.className = 'body';
  body.textContent = ad.body;

  card.append(head, headline, body);

  if (ad.imageUrl) {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.src = ad.imageUrl;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.remove());
    card.appendChild(img);
  }

  const foot = document.createElement('div');
  foot.className = 'foot';
  const cta = document.createElement('button');
  cta.className = 'cta';
  cta.textContent = `${ad.ctaText} →`;
  cta.addEventListener('click', onClick);
  const earn = document.createElement('span');
  earn.className = 'earn';
  earn.textContent = 'you earn';
  foot.append(cta, earn);
  card.appendChild(foot);

  const why = document.createElement('button');
  why.className = 'why';
  why.textContent = 'Why this ad? · manage in AdPilot';
  why.addEventListener('click', () => window.open('http://localhost:5173/app/settings', '_blank', 'noopener'));
  card.appendChild(why);

  const rail = document.createElement('div');
  rail.className = 'rail';
  const fill = document.createElement('i');
  fill.style.animationDuration = `${MAX_LIFETIME_MS}ms`;
  rail.appendChild(fill);
  card.appendChild(rail);

  wrap.appendChild(card);
  shadow.appendChild(wrap);

  current = {
    token: ad.token,
    shownAt: Date.now(),
    earnEl: earn,
    hideTimer: null,
    lifetimeTimer: setTimeout(() => dismiss('max_lifetime'), MAX_LIFETIME_MS),
  };
}

function send(type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(res ?? { ok: false, error: 'No response' });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

async function onClick() {
  if (!current) return;
  const res = await send('CLICK', { token: current.token });
  if (res.ok && res.data?.earnedMicros) {
    current.earnEl.textContent = `+$${(Number(res.data.earnedMicros) / 1e6).toFixed(4)}`;
  }
  setTimeout(() => dismiss('clicked'), 900);
}

/** Confirms the view (if it lasted long enough) and removes the card. */
async function dismiss(reason) {
  if (!current) return;
  const card = current;
  current = null;
  clearTimeout(card.hideTimer);
  clearTimeout(card.lifetimeTimer);

  const dwellMs = Date.now() - card.shownAt;
  const wrap = shadow?.querySelector('.wrap');
  if (wrap) {
    wrap.classList.add('leaving');
    setTimeout(() => wrap.remove(), 250);
  }

  if (reason !== 'clicked') {
    const res = await send('IMPRESSION', { token: card.token, dwellMs });
    if (!res.ok) console.debug('[AdPilot] impression not counted:', res.error);
  }
}

/** Waits out the minimum visible time, then the grace period, then hides. */
function scheduleHide() {
  if (!current || current.hideTimer) return;
  const visibleFor = Date.now() - current.shownAt;
  const wait = Math.max(MIN_VISIBLE_MS - visibleFor, 0) + GRACE_MS;
  current.hideTimer = setTimeout(() => dismiss('answer_delivered'), wait);
}

async function requestAd() {
  if (serveInFlight || current) return;
  serveInFlight = true;
  try {
    const res = await send('SERVE', { hostApp, modelHint: modelHint() });
    if (!res.ok) return console.debug('[AdPilot]', res.error);
    if (!res.data.fill) return console.debug('[AdPilot] no fill:', res.data.reason);
    render(res.data.ad);
  } finally {
    serveInFlight = false;
  }
}

// ------------------------------------------------------------- the loop

function onThinkingStart() {
  thinkingSince = Date.now();
  clearTimeout(settleTimer);
  // A card already on screen belongs to the previous turn — retire it so the
  // next thinking moment gets a fresh creative.
  if (current) dismiss('new_turn');
  settleTimer = setTimeout(() => {
    if (thinkingSince) void requestAd();
  }, SETTLE_MS);
}

function onThinkingEnd() {
  thinkingSince = 0;
  clearTimeout(settleTimer);
  scheduleHide();
}

let wasThinking = false;
function tick() {
  const now = isThinking();
  if (now && !wasThinking) onThinkingStart();
  else if (!now && wasThinking) onThinkingEnd();
  wasThinking = now;
}

// Mutation observer catches the change immediately; the interval is the safety
// net for UIs that swap nodes without touching the observed subtree.
const observer = new MutationObserver(() => tick());
function start() {
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-label', 'aria-busy', 'data-is-streaming', 'data-testid'] });
  setInterval(tick, 800);
  tick();
}

function boot() {
  // Start on the bundled rules immediately, then upgrade when the server answers.
  start();
  send('DETECTION', {}).then((res) => {
    if (res.ok && res.data) applyRemoteRules(res.data);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

// Lets the popup's "Show a test ad" button exercise the full loop on any page.
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type === 'FORCE_AD') {
    if (current) dismiss('forced_refresh');
    setTimeout(() => void requestAd(), 120);
    sendResponse({ ok: true });
  }
  if (msg?.type === 'PROBE') {
    sendResponse({ ok: true, data: { hostApp, thinking: isThinking(), model: modelHint() } });
  }
  return false;
});
