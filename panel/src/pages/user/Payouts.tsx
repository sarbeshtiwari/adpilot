import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useInvalidate, useMutation } from '../../lib/useApi';
import { del, post } from '../../lib/api';
import { Button, Card, CardHeader, Empty, ErrorNote, Field, Input, Loading, Modal, PageHeader, StatTile, StatusBadge, Table, Td, useToast } from '../../components/ui';
import { dateTime, usd, usdCompact } from '../../lib/format';
import type { Payout } from '../../lib/types';

type PayoutData = { payouts: Payout[]; balanceMicros: string; minPayoutMicros: string };

export default function UserPayouts() {
  const { data, isLoading, error, refetch } = useApi<PayoutData>('/me/payouts');
  const [requesting, setRequesting] = useState(false);
  const invalidate = useInvalidate();
  const toast = useToast();

  const cancel = useMutation({
    mutationFn: (id: string) => del(`/me/payouts/${id}`),
    onSuccess: () => { invalidate('/me/'); toast.push('Request cancelled'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} retry={() => void refetch()} />;
  if (!data) return null;

  const open = data.payouts.filter((p) => p.status === 'REQUESTED' || p.status === 'APPROVED');
  const lockedMicros = open.reduce((a, p) => a + Number(p.amountMicros), 0);
  const available = Number(data.balanceMicros) - lockedMicros;
  const canRequest = available >= Number(data.minPayoutMicros);

  return (
    <>
      <PageHeader title="Withdrawals" subtitle="Move your earnings to your own account"
        action={<Button variant="primary" disabled={!canRequest} onClick={() => setRequesting(true)}>Request withdrawal</Button>} />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Wallet balance" value={usdCompact(data.balanceMicros)} tone="good" />
        <StatTile label="Locked in requests" value={usdCompact(lockedMicros)} sub={`${open.length} open`} />
        <StatTile label="Free to withdraw" value={usdCompact(available)} />
        <StatTile label="Minimum withdrawal" value={usd(data.minPayoutMicros)} />
      </div>

      {!canRequest && (
        <div className="mb-6 rounded-xl border border-hairline bg-panel px-4 py-3 text-sm text-ink-soft">
          You need <span className="tnum font-semibold text-ink">{usd(Number(data.minPayoutMicros) - available)}</span> more before you can withdraw.
          Keep the extension running — every ad adds to the total.
        </div>
      )}

      <Card pad={false}>
        <div className="p-5 pb-0"><CardHeader title="Your requests" subtitle="Payments are sent to the method in your settings" /></div>
        {data.payouts.length === 0 ? (
          <div className="p-5"><Empty title="No withdrawals yet"
            hint="Once your balance passes the minimum you can cash out any time."
            action={<Link to="/app/settings" className="text-xs font-medium text-brand hover:underline">Set a payout method →</Link>} /></div>
        ) : (
          <Table head={['Requested', 'Amount', 'Method', 'Status', 'Settled', '']}>
            {data.payouts.map((p) => (
              <tr key={p.id} className="hover:bg-surface/60">
                <Td className="text-xs">{dateTime(p.requestedAt)}</Td>
                <Td className="tnum font-semibold text-ink">{usd(p.amountMicros)}</Td>
                <Td>{p.method}</Td>
                <Td><StatusBadge status={p.status} /></Td>
                <Td className="text-xs">{p.processedAt ? dateTime(p.processedAt) : '—'}<span className="block text-2xs text-ink-mute">{p.reference}</span></Td>
                <Td>
                  <div className="flex justify-end">
                    {p.status === 'REQUESTED' && <Button size="sm" variant="ghost" onClick={() => cancel.mutate(p.id)}>Cancel</Button>}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <RequestModal open={requesting} onClose={() => setRequesting(false)} available={available} min={Number(data.minPayoutMicros)} />
    </>
  );
}

function RequestModal({ open, onClose, available, min }: { open: boolean; onClose: () => void; available: number; min: number }) {
  const [amount, setAmount] = useState((available / 1e6).toFixed(2));
  const invalidate = useInvalidate();
  const toast = useToast();

  const mut = useMutation({
    mutationFn: () => post('/me/payouts', { amountUsd: Number(amount) }),
    onSuccess: () => { invalidate('/me/'); toast.push('Withdrawal requested'); onClose(); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  const value = Number(amount) * 1e6;
  const tooMuch = value > available;
  const tooLittle = value < min;

  return (
    <Modal open={open} onClose={onClose} title="Request a withdrawal"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={mut.isPending} disabled={tooMuch || tooLittle} onClick={() => mut.mutate()}>Request</Button></>}>
      <div className="space-y-4">
        <Field label="Amount in USD"
          hint={`Between ${usd(min)} and ${usd(available)}`}
          error={tooMuch ? 'More than you have available' : tooLittle ? `Below the ${usd(min)} minimum` : undefined}>
          <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <button onClick={() => setAmount((available / 1e6).toFixed(2))} className="text-xs font-medium text-brand hover:underline">
          Withdraw everything ({usd(available)})
        </button>
        <p className="rounded-lg bg-surface px-3 py-2 text-xs text-ink-mute">
          The amount is locked while the request is open, then debited when the platform marks it paid.
          Payments go to the method saved in your <Link to="/app/settings" className="font-medium text-brand hover:underline">settings</Link>.
        </p>
      </div>
    </Modal>
  );
}
