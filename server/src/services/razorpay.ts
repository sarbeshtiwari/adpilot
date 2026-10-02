/**
 * Razorpay integration — Orders + Checkout for vendor top-ups, and RazorpayX
 * Payouts (optional) for automated end-user withdrawals.
 *
 * Called over plain fetch rather than the SDK: the surface we need is three
 * endpoints and two HMACs, and this keeps the signature verification visible.
 */
import crypto from 'node:crypto';
import { env, razorpayEnabled, razorpayXEnabled } from '../env.js';
import { ApiError } from '../lib/http.js';

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

/** USD is the unit of account; Razorpay charges in minor units of the local currency. */
export function usdMicrosToMinorUnits(micros: bigint): number {
  const usd = Number(micros) / 1_000_000;
  return Math.round(usd * env.razorpay.usdRate * 100);
}

export function minorUnitsToUsdMicros(minor: number): bigint {
  const usd = minor / 100 / env.razorpay.usdRate;
  return BigInt(Math.round(usd * 1_000_000));
}

function assertConfigured() {
  if (!razorpayEnabled) {
    throw new ApiError(
      503,
      'Card payments are not configured on this server. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, or use a manual bank transfer.',
      'gateway_not_configured',
    );
  }
}

async function call<T>(path: string, init: RequestInit, auth: { id: string; secret: string }): Promise<T> {
  const res = await fetch(`${env.razorpay.apiBase}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: basic(auth.id, auth.secret), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (body.error ?? {}) as { description?: string; reason?: string };
    throw new ApiError(res.status === 401 ? 500 : 502, err.description ?? 'Payment gateway rejected the request', 'gateway_error', err);
  }
  return body as T;
}

export type RazorpayOrder = { id: string; amount: number; currency: string; status: string; receipt?: string };

export async function createOrder(opts: { amountMicros: bigint; receipt: string; notes?: Record<string, string> }) {
  assertConfigured();
  const amount = usdMicrosToMinorUnits(opts.amountMicros);
  if (amount < 100) throw ApiError.badRequest('That amount is below the gateway minimum');

  return call<RazorpayOrder>(
    '/orders',
    {
      method: 'POST',
      body: JSON.stringify({
        amount,
        currency: env.razorpay.currency,
        receipt: opts.receipt.slice(0, 40),
        notes: opts.notes ?? {},
        payment_capture: 1,
      }),
    },
    { id: env.razorpay.keyId, secret: env.razorpay.keySecret },
  );
}

export type RazorpayPayment = {
  id: string; order_id: string; status: string; amount: number; currency: string;
  method?: string; error_description?: string;
};

export async function fetchPayment(paymentId: string) {
  assertConfigured();
  return call<RazorpayPayment>(`/payments/${paymentId}`, { method: 'GET' }, { id: env.razorpay.keyId, secret: env.razorpay.keySecret });
}

/**
 * Checkout hands the browser (order_id, payment_id, signature). The signature is
 * HMAC-SHA256 of "order_id|payment_id" keyed with the API secret — which only
 * the server knows, so a forged callback cannot credit a wallet.
 */
export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
  if (!razorpayEnabled) return false;
  const expected = crypto.createHmac('sha256', env.razorpay.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Webhooks are signed over the exact raw body — parse only after verifying. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
  if (!env.razorpay.webhookSecret) return false;
  const expected = crypto.createHmac('sha256', env.razorpay.webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature ?? '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────── RazorpayX (payouts, optional)

export type PayoutResult = { id: string; status: string; failure_reason?: string };

/**
 * Sends money out to an end user. Only used when auto-payout is switched on and
 * RazorpayX credentials exist; otherwise withdrawals stay a manual admin step.
 */
export async function sendPayout(opts: {
  amountMicros: bigint;
  method: string;
  details: Record<string, string>;
  referenceId: string;
  name: string;
  email?: string;
}): Promise<PayoutResult> {
  if (!razorpayXEnabled) {
    throw new ApiError(503, 'Automated payouts are not configured — settle this withdrawal manually', 'payouts_not_configured');
  }
  const auth = { id: env.razorpayX.keyId, secret: env.razorpayX.keySecret };

  // 1. contact
  const contact = await call<{ id: string }>(
    '/contacts',
    { method: 'POST', body: JSON.stringify({ name: opts.name.slice(0, 50), email: opts.email, type: 'customer', reference_id: opts.referenceId }) },
    auth,
  );

  // 2. fund account — shape depends on how they asked to be paid
  const fundAccountBody =
    opts.method === 'UPI'
      ? { contact_id: contact.id, account_type: 'vpa', vpa: { address: opts.details.upiId } }
      : {
          contact_id: contact.id,
          account_type: 'bank_account',
          bank_account: {
            name: opts.name.slice(0, 50),
            ifsc: opts.details.ifscOrSwift,
            account_number: opts.details.accountNumber,
          },
        };
  const fundAccount = await call<{ id: string }>('/fund_accounts', { method: 'POST', body: JSON.stringify(fundAccountBody) }, auth);

  // 3. payout
  return call<PayoutResult>(
    '/payouts',
    {
      method: 'POST',
      body: JSON.stringify({
        account_number: env.razorpayX.accountNumber,
        fund_account_id: fundAccount.id,
        amount: usdMicrosToMinorUnits(opts.amountMicros),
        currency: env.razorpay.currency,
        mode: opts.method === 'UPI' ? 'UPI' : 'IMPS',
        purpose: 'payout',
        queue_if_low_balance: true,
        reference_id: opts.referenceId,
        narration: 'AdPilot earnings',
      }),
      headers: { 'X-Payout-Idempotency': opts.referenceId },
    },
    auth,
  );
}

export { razorpayEnabled, razorpayXEnabled };
