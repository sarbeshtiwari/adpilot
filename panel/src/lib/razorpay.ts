/** Razorpay Checkout loader + promise wrapper around its callback API. */

type CheckoutOptions = {
  key: string; orderId: string; amount: number; currency: string;
  name: string; description: string;
  prefill: { name?: string; email?: string; contact?: string };
};

export type CheckoutResult = {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
};

declare global {
  interface Window { Razorpay?: new (opts: Record<string, unknown>) => { open: () => void; on: (e: string, cb: (r: unknown) => void) => void } }
}

let loader: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (loader) return loader;
  loader = new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const el = document.createElement('script');
    el.src = 'https://checkout.razorpay.com/v1/checkout.js';
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('Could not load the payment window'));
    document.head.appendChild(el);
  });
  return loader;
}

/** Resolves with the signed result, or rejects if the payer closes the window. */
export async function openCheckout(opts: CheckoutOptions): Promise<CheckoutResult> {
  await loadScript();
  if (!window.Razorpay) throw new Error('Payment window is unavailable');

  return new Promise((resolve, reject) => {
    const rzp = new window.Razorpay!({
      key: opts.key,
      order_id: opts.orderId,
      amount: opts.amount,
      currency: opts.currency,
      name: opts.name,
      description: opts.description,
      prefill: opts.prefill,
      theme: { color: '#2a78d6' },
      modal: { ondismiss: () => reject(new Error('Payment window closed before the payment finished')) },
      handler: (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) =>
        resolve({
          razorpayOrderId: r.razorpay_order_id,
          razorpayPaymentId: r.razorpay_payment_id,
          razorpaySignature: r.razorpay_signature,
        }),
    });
    rzp.on('payment.failed', (r: unknown) => {
      const err = (r as { error?: { description?: string } })?.error;
      reject(new Error(err?.description ?? 'The payment did not go through'));
    });
    rzp.open();
  });
}
