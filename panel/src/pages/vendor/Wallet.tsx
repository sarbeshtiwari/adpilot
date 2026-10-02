import { useState } from 'react';
import { useApi, useInvalidate, useMutation } from '../../lib/useApi';
import { get, post, qs } from '../../lib/api';
import { openCheckout } from '../../lib/razorpay';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, CardHeader, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Spinner, StatTile, StatusBadge, Table, Td, useToast } from '../../components/ui';
import { dateTime, usd, usdCompact } from '../../lib/format';
import type { LedgerEntry, Recharge, Vendor } from '../../lib/types';

type WalletData = {
  vendor: Vendor; ledger: LedgerEntry[]; ledgerPage: number; ledgerTotal: number; ledgerPages: number;
  recharges: Recharge[];
};

type Gateway = { razorpay: boolean; currency: string; usdRate: number };

export default function VendorWallet() {
  const [page, setPage] = useState(1);
  const [topUp, setTopUp] = useState(false);
  const { data, isLoading, error, refetch } = useApi<WalletData>(`/vendor/wallet${qs({ page, limit: 25 })}`);
  const { data: profile } = useApi<{ gateway: Gateway }>('/vendor/profile');
  const { can } = useAuth();
  const invalidate = useInvalidate();
  const toast = useToast();

  const settle = useMutation({
    mutationFn: (id: string) => post(`/vendor/wallet/recharge/${id}/simulate-settle`),
    onSuccess: () => { invalidate('/vendor/'); invalidate('/auth/me'); toast.push('Sandbox top-up settled — balance credited'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} retry={() => void refetch()} />;
  if (!data) return null;
  const v = data.vendor;

  return (
    <>
      <PageHeader title="Wallet" subtitle="Prepaid balance — campaigns draw from it as ads are served"
        action={<Button variant="primary" disabled={!can('wallet', 'create')} onClick={() => setTopUp(true)}>Add funds</Button>} />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Available balance" value={usdCompact(v.balanceMicros)} tone={Number(v.balanceMicros) > 0 ? 'good' : 'bad'} />
        <StatTile label="Lifetime spend" value={usdCompact(v.lifetimeSpendMicros)} />
        <StatTile label="Lifetime top-ups" value={usdCompact(v.lifetimeTopUpMicros)} />
        <StatTile label="Account status" value={v.status.toLowerCase()} sub={v.status === 'ACTIVE' ? 'campaigns can deliver' : 'delivery blocked'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card pad={false}>
          <div className="p-5 pb-0"><CardHeader title="Top-ups" subtitle="Funds are credited once the platform confirms settlement" /></div>
          <Table head={['Requested', 'Amount', 'Method', 'Status', '']} empty={!data.recharges.length}>
            {data.recharges.map((r) => (
              <tr key={r.id}>
                <Td className="text-xs">{dateTime(r.createdAt)}</Td>
                <Td className="tnum font-medium text-ink">{usd(r.amountMicros)}</Td>
                <Td>{r.method}<span className="block text-2xs text-ink-mute">{r.reference}</span></Td>
                <Td><StatusBadge status={r.status} /></Td>
                <Td>
                  {r.status === 'PENDING' && (
                    <div className="flex justify-end">
                      <Button size="sm" loading={settle.isPending} onClick={() => settle.mutate(r.id)}>Simulate payment</Button>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card pad={false}>
          <div className="p-5 pb-0"><CardHeader title="Wallet activity" subtitle={`${data.ledgerTotal} entries`} /></div>
          <Table head={['When', 'Type', 'Amount', 'Balance', 'Note']} empty={!data.ledger.length}>
            {data.ledger.map((l) => (
              <tr key={l.id}>
                <Td className="whitespace-nowrap text-xs">{dateTime(l.createdAt)}</Td>
                <Td><Badge tone={l.type === 'VENDOR_TOPUP' ? 'good' : 'neutral'}>{l.type.replace('VENDOR_', '').toLowerCase()}</Badge></Td>
                <Td className={`tnum font-medium ${Number(l.amountMicros) < 0 ? 'text-bad' : 'text-good'}`}>
                  {Number(l.amountMicros) > 0 ? '+' : ''}{usd(l.amountMicros, { precise: true })}
                </Td>
                <Td className="tnum text-xs">{l.balanceAfter ? usd(l.balanceAfter) : '—'}</Td>
                <Td className="max-w-[14rem] truncate text-xs" title={l.note}>{l.note}</Td>
              </tr>
            ))}
          </Table>
          <Pagination page={data.ledgerPage} pages={data.ledgerPages} onPage={setPage} />
        </Card>
      </div>

      <TopUpModal open={topUp} onClose={() => setTopUp(false)} gateway={profile?.gateway ?? null} />
    </>
  );
}

function TopUpModal({ open, onClose, gateway }: { open: boolean; onClose: () => void; gateway: Gateway | null }) {
  const [amount, setAmount] = useState('250');
  const [method, setMethod] = useState<'RAZORPAY' | 'BANK' | 'UPI' | 'MANUAL'>('RAZORPAY');
  const [reference, setReference] = useState('');
  const [stage, setStage] = useState<'form' | 'paying' | 'confirming'>('form');
  const invalidate = useInvalidate();
  const toast = useToast();

  const cardsAvailable = gateway?.razorpay ?? false;
  const effectiveMethod = cardsAvailable ? method : method === 'RAZORPAY' ? 'BANK' : method;
  const usd = Number(amount) || 0;
  const localApprox = gateway ? usd * gateway.usdRate : null;

  function close() { setStage('form'); onClose(); }

  const start = useMutation({
    mutationFn: async () => {
      const res = await post<{
        rechargeId: string; manual?: boolean;
        checkout?: { key: string; orderId: string; amount: number; currency: string; name: string; description: string; prefill: Record<string, string> };
      }>('/vendor/wallet/recharge', { amountUsd: usd, method: effectiveMethod, reference });

      // Manual transfer: nothing else to do until an admin settles it.
      if (!res.checkout) return { settled: false as const, manual: true as const };

      setStage('paying');
      const result = await openCheckout(res.checkout);

      // The webhook is the source of truth, but verifying here lets the panel
      // confirm immediately rather than spinning.
      setStage('confirming');
      const verified = await post<{ status: string; creditedMicros?: string }>(
        `/vendor/wallet/recharge/${res.rechargeId}/verify`,
        result,
      );
      if (verified.status === 'COMPLETED') return { settled: true as const, manual: false as const };

      // Still capturing — poll briefly for the webhook to land.
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const poll = await get<{ status: string }>(`/vendor/wallet/recharge/${res.rechargeId}`);
        if (poll.status === 'COMPLETED') return { settled: true as const, manual: false as const };
        if (poll.status === 'FAILED') throw new Error('The payment was declined');
      }
      return { settled: false as const, manual: false as const };
    },
    onSuccess: (r) => {
      invalidate('/vendor/'); invalidate('/auth/me');
      toast.push(
        r.manual ? 'Top-up requested — funds appear once the platform confirms the transfer'
          : r.settled ? `$${usd.toFixed(2)} added to your wallet`
          : 'Payment received — the balance updates as soon as the gateway confirms',
      );
      close();
    },
    onError: (e: Error) => { setStage('form'); toast.push(e.message, 'bad'); },
  });

  const busy = start.isPending;
  const stageLabel = stage === 'paying' ? 'Waiting for the payment window…' : stage === 'confirming' ? 'Confirming with the gateway…' : null;

  return (
    <Modal open={open} onClose={busy ? () => {} : close} title="Add funds"
      footer={<>
        <Button onClick={close} disabled={busy}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={usd < 10} onClick={() => start.mutate()}>
          {effectiveMethod === 'RAZORPAY' ? `Pay $${usd.toFixed(2)}` : 'Request top-up'}
        </Button>
      </>}>
      <div className="space-y-4">
        <div className="flex gap-2">
          {[100, 250, 500, 1000].map((a) => (
            <button key={a} type="button" disabled={busy} onClick={() => setAmount(String(a))}
              className={`tnum flex-1 rounded-lg border py-2 text-sm font-medium ${Number(amount) === a ? 'border-brand bg-brand-soft text-brand' : 'border-hairline text-ink-soft hover:bg-surface'}`}>
              ${a}
            </button>
          ))}
        </div>

        <Field label="Amount in USD" hint={localApprox ? `≈ ${gateway!.currency} ${localApprox.toLocaleString('en-US', { maximumFractionDigits: 0 })} charged` : 'Minimum $10'}>
          <Input type="number" min="10" step="1" value={amount} disabled={busy} onChange={(e) => setAmount(e.target.value)} />
        </Field>

        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-soft">How would you like to pay?</p>
          <div className="space-y-2">
            <button type="button" disabled={!cardsAvailable || busy} onClick={() => setMethod('RAZORPAY')}
              className={`w-full rounded-lg border p-3 text-left transition disabled:opacity-50 ${effectiveMethod === 'RAZORPAY' ? 'border-brand bg-brand-soft' : 'border-hairline hover:bg-surface'}`}>
              <span className={`block text-sm font-medium ${effectiveMethod === 'RAZORPAY' ? 'text-brand' : 'text-ink'}`}>
                Card, UPI or net banking
              </span>
              <span className="block text-2xs text-ink-mute">
                {cardsAvailable
                  ? 'Secured by Razorpay. Your balance updates the moment the payment clears.'
                  : 'Unavailable — the server has no Razorpay keys configured.'}
              </span>
            </button>

            <button type="button" disabled={busy} onClick={() => setMethod('BANK')}
              className={`w-full rounded-lg border p-3 text-left transition ${effectiveMethod === 'BANK' ? 'border-brand bg-brand-soft' : 'border-hairline hover:bg-surface'}`}>
              <span className={`block text-sm font-medium ${effectiveMethod === 'BANK' ? 'text-brand' : 'text-ink'}`}>Bank transfer</span>
              <span className="block text-2xs text-ink-mute">Credited once the platform team confirms the money arrived.</span>
            </button>
          </div>
        </div>

        {effectiveMethod !== 'RAZORPAY' && (
          <Field label="Your reference" hint="UTR, wire reference or invoice number">
            <Input value={reference} disabled={busy} onChange={(e) => setReference(e.target.value)} />
          </Field>
        )}

        {stageLabel && (
          <p className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-ink-soft">
            <Spinner className="h-3.5 w-3.5" /> {stageLabel}
          </p>
        )}
      </div>
    </Modal>
  );
}
