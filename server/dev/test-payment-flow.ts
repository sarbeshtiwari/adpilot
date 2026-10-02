/**
 * End-to-end test of the vendor top-up flow against the mock gateway.
 *
 * Exercises the real application code path — order creation, checkout signature
 * verification, webhook capture, wallet crediting, ledger journaling — and the
 * failure cases that matter: forged signatures, replayed webhooks, declines.
 *
 *   npm run mock:razorpay      (terminal 1)
 *   npm run dev                (terminal 2, with mock keys in .env)
 *   npm run test:payments      (terminal 3)
 */
import { prisma } from '../src/lib/prisma.js';

const API = process.env.ADPILOT_API ?? 'http://localhost:4000';
const MOCK = process.env.MOCK_RAZORPAY ?? 'http://localhost:4100';
const VENDOR_EMAIL = process.env.TEST_VENDOR ?? 'ads@vectordb.io';
const PASSWORD = process.env.TEST_PASSWORD ?? 'Passw0rd!23';

const usd = (micros: bigint | string | number) => `$${(Number(micros) / 1e6).toFixed(2)}`;

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

// ── a tiny cookie-aware client, since the API is cookie-authenticated ────────
const jar = new Map<string, string>();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

function absorb(res: Response) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

async function call(path: string, init: RequestInit = {}) {
  const method = init.method ?? 'GET';
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader() ? { Cookie: cookieHeader() } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': jar.get('adpilot_csrf') ?? '' } : {}),
      ...(init.headers ?? {}),
    },
  });
  absorb(res);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const mock = async (path: string, body: unknown) =>
  (await fetch(`${MOCK}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

const balanceOf = async (vendorId: string) =>
  (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { balanceMicros: true } })).balanceMicros;

async function main() {
  console.log('\n─── Razorpay payment flow ───────────────────────────────────\n');

  // ── sign in ───────────────────────────────────────────────────────────────
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: VENDOR_EMAIL, password: PASSWORD, portal: 'VENDOR' }),
  });
  if (login.status !== 200) throw new Error(`login failed (${login.status}): ${JSON.stringify(login.body)}`);
  const vendorId: string = login.body.user.vendor.id;
  console.log(`  signed in as ${VENDOR_EMAIL} (${login.body.user.vendor.companyName})\n`);

  // ── 1. happy path: checkout callback ──────────────────────────────────────
  console.log('1. Card payment verified at checkout');
  const before1 = await balanceOf(vendorId);

  const created = await call('/api/vendor/wallet/recharge', {
    method: 'POST',
    body: JSON.stringify({ amountUsd: 250, method: 'RAZORPAY' }),
  });
  check('order created at the gateway', created.status === 201 && Boolean(created.body.checkout?.orderId), created.body.checkout?.orderId);
  const rechargeId: string = created.body.rechargeId;
  const orderId: string = created.body.checkout.orderId;
  check('charged in gateway minor units', created.body.checkout.amount > 0, `${created.body.checkout.amount} ${created.body.checkout.currency}`);

  const paid = await mock('/_test/pay', { orderId });
  const verified = await call(`/api/vendor/wallet/recharge/${rechargeId}/verify`, {
    method: 'POST',
    body: JSON.stringify({
      razorpayOrderId: paid.razorpay_order_id,
      razorpayPaymentId: paid.razorpay_payment_id,
      razorpaySignature: paid.razorpay_signature,
    }),
  });
  check('signature accepted and wallet credited', verified.status === 200 && verified.body.status === 'COMPLETED');

  const after1 = await balanceOf(vendorId);
  check('balance moved by the paid amount', after1 > before1, `${usd(before1)} → ${usd(after1)}`);

  const ledger1 = await prisma.ledgerEntry.findFirst({
    where: { vendorId, type: 'VENDOR_TOPUP' }, orderBy: { createdAt: 'desc' },
  });
  check('journal entry written', ledger1?.note?.includes(paid.razorpay_payment_id) ?? false, ledger1?.note);

  // ── 2. forged checkout signature ──────────────────────────────────────────
  console.log('\n2. Forged checkout signature');
  const before2 = await balanceOf(vendorId);
  const created2 = await call('/api/vendor/wallet/recharge', {
    method: 'POST', body: JSON.stringify({ amountUsd: 100, method: 'RAZORPAY' }),
  });
  const paid2 = await mock('/_test/pay', { orderId: created2.body.checkout.orderId });
  const forged = await call(`/api/vendor/wallet/recharge/${created2.body.rechargeId}/verify`, {
    method: 'POST',
    body: JSON.stringify({
      razorpayOrderId: paid2.razorpay_order_id,
      razorpayPaymentId: paid2.razorpay_payment_id,
      razorpaySignature: 'f'.repeat(64),
    }),
  });
  check('rejected', forged.status === 400, forged.body?.error);
  check('no money moved', (await balanceOf(vendorId)) === before2, usd(await balanceOf(vendorId)));

  // ── 3. webhook path (the source of truth) ─────────────────────────────────
  console.log('\n3. Webhook capture, with no checkout callback');
  const before3 = await balanceOf(vendorId);
  const created3 = await call('/api/vendor/wallet/recharge', {
    method: 'POST', body: JSON.stringify({ amountUsd: 500, method: 'RAZORPAY' }),
  });
  const paid3 = await mock('/_test/pay', { orderId: created3.body.checkout.orderId, method: 'upi' });
  const hook = await mock('/_test/webhook', { paymentId: paid3.razorpay_payment_id });
  check('webhook accepted', hook.status === 200);

  const after3 = await balanceOf(vendorId);
  check('wallet credited by the webhook alone', after3 > before3, `${usd(before3)} → ${usd(after3)}`);
  const settled = await prisma.recharge.findUniqueOrThrow({ where: { id: created3.body.rechargeId } });
  check('recharge marked COMPLETED', settled.status === 'COMPLETED', settled.note);

  // ── 4. replayed webhook must not double-credit ────────────────────────────
  console.log('\n4. Replayed webhook (Razorpay retries until it gets a 2xx)');
  const beforeReplay = await balanceOf(vendorId);
  await mock('/_test/webhook', { paymentId: paid3.razorpay_payment_id });
  await mock('/_test/webhook', { paymentId: paid3.razorpay_payment_id });
  const afterReplay = await balanceOf(vendorId);
  check('idempotent — balance unchanged', afterReplay === beforeReplay, usd(afterReplay));
  const topUpCount = await prisma.ledgerEntry.count({ where: { vendorId, type: 'VENDOR_TOPUP', note: { contains: paid3.razorpay_payment_id } } });
  check('exactly one journal entry for that payment', topUpCount === 1, `${topUpCount} entries`);

  // ── 5. forged webhook signature ───────────────────────────────────────────
  console.log('\n5. Forged webhook signature');
  const beforeForged = await balanceOf(vendorId);
  const created5 = await call('/api/vendor/wallet/recharge', {
    method: 'POST', body: JSON.stringify({ amountUsd: 750, method: 'RAZORPAY' }),
  });
  const paid5 = await mock('/_test/pay', { orderId: created5.body.checkout.orderId });
  const bad = await mock('/_test/webhook-forged', { paymentId: paid5.razorpay_payment_id });
  check('rejected with 400', bad.status === 400, bad.response);
  check('no money moved', (await balanceOf(vendorId)) === beforeForged, usd(await balanceOf(vendorId)));

  // ── 6. declined payment ───────────────────────────────────────────────────
  console.log('\n6. Declined card');
  const beforeFail = await balanceOf(vendorId);
  const created6 = await call('/api/vendor/wallet/recharge', {
    method: 'POST', body: JSON.stringify({ amountUsd: 300, method: 'RAZORPAY' }),
  });
  const paid6 = await mock('/_test/pay', { orderId: created6.body.checkout.orderId, outcome: 'failed' });
  await mock('/_test/webhook', { paymentId: paid6.razorpay_payment_id, event: 'payment.failed' });
  const failed = await prisma.recharge.findUniqueOrThrow({ where: { id: created6.body.rechargeId } });
  check('recharge marked FAILED', failed.status === 'FAILED', failed.failureReason ?? '');
  check('no money moved', (await balanceOf(vendorId)) === beforeFail, usd(await balanceOf(vendorId)));

  // ── 7. permissions still apply to payments ────────────────────────────────
  console.log('\n7. A member without wallet:create cannot start a payment');
  jar.clear();
  const analyst = await call('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email: 'analyst@vectordb.io', password: PASSWORD, portal: 'VENDOR' }),
  });
  if (analyst.status === 200) {
    const denied = await call('/api/vendor/wallet/recharge', {
      method: 'POST', body: JSON.stringify({ amountUsd: 100, method: 'RAZORPAY' }),
    });
    check('blocked by permissions', denied.status === 403, denied.body?.error);
  } else {
    check('analyst account available', false, 'could not sign in — reseed to restore it');
  }

  // ── books ─────────────────────────────────────────────────────────────────
  console.log('\n8. Books still reconcile');
  const [topUps, spend, earn, platform] = await Promise.all([
    prisma.ledgerEntry.aggregate({ _sum: { amountMicros: true }, where: { type: 'VENDOR_TOPUP' } }),
    prisma.ledgerEntry.aggregate({ _sum: { amountMicros: true }, where: { type: 'VENDOR_SPEND' } }),
    prisma.ledgerEntry.aggregate({ _sum: { amountMicros: true }, where: { type: 'PUBLISHER_EARN' } }),
    prisma.ledgerEntry.aggregate({ _sum: { amountMicros: true }, where: { type: 'PLATFORM_REVENUE' } }),
  ]);
  const spent = -(spend._sum.amountMicros ?? 0n);
  const split = (earn._sum.amountMicros ?? 0n) + (platform._sum.amountMicros ?? 0n);
  check('ad spend = earner payouts + platform margin', spent === split, `${usd(spent)} = ${usd(split)}`);
  console.log(`     lifetime top-ups ${usd(topUps._sum.amountMicros ?? 0n)}`);

  console.log(`\n─── ${pass} passed, ${fail} failed ───────────────────────────────\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main()
  .catch((e) => { console.error('\n✗ ', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
