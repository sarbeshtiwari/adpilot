const $ = (id) => document.getElementById(id);
const usd = (micros) => `$${(Number(micros || 0) / 1e6).toFixed(Number(micros) >= 1e6 ? 2 : 4)}`;

const send = (type, payload) =>
  new Promise((resolve) => chrome.runtime.sendMessage({ type, payload }, (r) => resolve(r ?? { ok: false, error: 'No response' })));

function flash(text, kind = 'err') {
  $('msg').innerHTML = `<div class="msg ${kind}">${text}</div>`;
  setTimeout(() => { $('msg').innerHTML = ''; }, 4000);
}

async function refresh() {
  const res = await send('STATUS');
  if (!res.ok) return flash(res.error);
  const s = res.data;

  $('version').textContent = `v${s.version}`;
  $('apiBase').value = s.apiBase;
  $('pairView').classList.toggle('hide', s.paired);
  $('mainView').classList.toggle('hide', !s.paired);
  if (!s.paired) return;

  const stats = s.stats?.date === new Date().toISOString().slice(0, 10) ? s.stats : null;
  $('sAds').textContent = stats?.impressions ?? 0;
  $('sClicks').textContent = stats?.clicks ?? 0;
  $('sEarned').textContent = usd(stats?.micros ?? 0);

  const c = s.config;
  $('balance').textContent = usd(c?.balanceMicros);
  $('lifetime').textContent = `lifetime ${usd(c?.lifetimeEarnedMicros)}`;
  $('dot').classList.toggle('on', Boolean(c?.adsEnabled));
  $('statusLine').textContent = c
    ? c.adsEnabled
      ? `Active · up to ${c.maxAdsPerHour} ads/hour, ${c.minSecondsBetweenAds}s apart`
      : 'Ads are paused in your settings — you are not earning'
    : '';
}

$('pairBtn').addEventListener('click', async () => {
  const code = $('code').value.trim().toUpperCase();
  if (code.length < 6) return flash('Enter the code from your dashboard');
  $('pairBtn').disabled = true;
  const res = await send('PAIR', { code });
  $('pairBtn').disabled = false;
  if (!res.ok) return flash(res.error);
  flash(`Paired as ${res.data.publisher.displayName}`, 'ok');
  await refresh();
});

$('saveApi').addEventListener('click', async () => {
  await send('SET_API', { apiBase: $('apiBase').value.trim() });
  flash('Endpoint saved', 'ok');
});

$('unpairBtn').addEventListener('click', async () => {
  await send('UNPAIR');
  flash('Device unpaired', 'ok');
  await refresh();
});

$('dashBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://localhost:5173/app' });
});

$('testBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return flash('No active tab');
  chrome.tabs.sendMessage(tab.id, { type: 'FORCE_AD' }, () => {
    if (chrome.runtime.lastError) {
      flash('AdPilot does not run on this page. Open an AI chat first.');
    } else {
      flash('Requesting an ad…', 'ok');
      setTimeout(refresh, 2500);
    }
  });
});

$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pairBtn').click(); });

refresh();
send('REFRESH').then(refresh);
