import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useInvalidate, useMutation } from '../../lib/useApi';
import { post, qs } from '../../lib/api';
import { Button, Card, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, StatTile, StatusBadge, Tabs, Table, Td, useToast } from '../../components/ui';
import { dateTime, num, usd } from '../../lib/format';
import type { Paged, Payout } from '../../lib/types';

type PayoutPage = Paged<Payout> & { queuedMicros: string };

export default function AdminPayouts() {
  const [tab, setTab] = useState('REQUESTED');
  const [page, setPage] = useState(1);
  const [acting, setActing] = useState<{ payout: Payout; action: 'APPROVE' | 'PAY' | 'REJECT' } | null>(null);
  const { data, isLoading, error, refetch } = useApi<PayoutPage>(`/admin/payouts${qs({ status: tab, page, limit: 20 })}`);

  return (
    <>
      <PageHeader title="Payouts" subtitle="Withdrawal requests from end users" />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Queued for payment" value={usd(data?.queuedMicros ?? 0)} sub="requested + approved" tone="warn" />
        <StatTile label="In this view" value={num(data?.total ?? 0)} sub={tab.toLowerCase()} />
      </div>

      <Tabs active={tab} onChange={(t) => { setTab(t); setPage(1); }}
        tabs={[{ id: 'REQUESTED', label: 'Requested' }, { id: 'APPROVED', label: 'Approved' }, { id: 'PAID', label: 'Paid' }, { id: 'REJECTED', label: 'Rejected' }]} />

      <Card pad={false}>
        {isLoading ? <Loading /> : error ? <div className="p-5"><ErrorNote error={error} retry={() => void refetch()} /></div> : (
          <>
            <Table head={['Requested', 'End user', 'Amount', 'Method', 'Their balance', 'Status', '']} empty={!data?.data.length}>
              {data?.data.map((p) => (
                <tr key={p.id} className="hover:bg-surface/60">
                  <Td className="text-xs">{dateTime(p.requestedAt)}</Td>
                  <Td className="font-medium text-ink">
                    <Link to={`/admin/end-users/${p.publisherId}`} className="hover:text-brand hover:underline">{p.publisher?.displayName}</Link>
                    <span className="block text-2xs text-ink-mute">{p.publisher?.user.email} · {[p.publisher?.city, p.publisher?.country].filter(Boolean).join(', ')}</span>
                  </Td>
                  <Td className="tnum font-semibold text-ink">{usd(p.amountMicros)}</Td>
                  <Td className="text-xs">{p.method}<span className="block max-w-[12rem] truncate text-2xs text-ink-mute">{p.details}</span></Td>
                  <Td className="tnum">{usd(p.publisher?.balanceMicros ?? 0)}</Td>
                  <Td><StatusBadge status={p.status} /></Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      {p.status === 'REQUESTED' && <Button size="sm" onClick={() => setActing({ payout: p, action: 'APPROVE' })}>Approve</Button>}
                      {(p.status === 'REQUESTED' || p.status === 'APPROVED') && (
                        <>
                          <Button size="sm" variant="primary" onClick={() => setActing({ payout: p, action: 'PAY' })}>Mark paid</Button>
                          <Button size="sm" variant="ghost" onClick={() => setActing({ payout: p, action: 'REJECT' })}>Reject</Button>
                        </>
                      )}
                      {p.status === 'PAID' && <span className="text-2xs text-ink-mute">{p.reference || 'settled'}</span>}
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
            <Pagination page={data?.page ?? 1} pages={data?.pages ?? 1} onPage={setPage} />
          </>
        )}
      </Card>

      <ActionModal acting={acting} onClose={() => setActing(null)} />
    </>
  );
}

function ActionModal({ acting, onClose }: { acting: { payout: Payout; action: 'APPROVE' | 'PAY' | 'REJECT' } | null; onClose: () => void }) {
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const invalidate = useInvalidate();
  const toast = useToast();

  const mut = useMutation({
    mutationFn: () => post(`/admin/payouts/${acting!.payout.id}/action`, { action: acting!.action, reference, note }),
    onSuccess: () => { invalidate('/admin/'); toast.push('Payout updated'); onClose(); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  if (!acting) return null;
  const { payout, action } = acting;

  return (
    <Modal open onClose={onClose} title={`${action === 'PAY' ? 'Mark as paid' : action === 'APPROVE' ? 'Approve' : 'Reject'} — ${usd(payout.amountMicros)}`}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant={action === 'REJECT' ? 'danger' : 'primary'} loading={mut.isPending} onClick={() => mut.mutate()}>Confirm</Button></>}>
      <div className="space-y-4">
        <dl className="space-y-1.5 rounded-lg bg-surface px-3 py-2.5 text-xs">
          <div className="flex justify-between"><dt className="text-ink-mute">End user</dt><dd className="text-ink">{payout.publisher?.displayName}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-mute">Method</dt><dd className="text-ink">{payout.method}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-mute">Details</dt><dd className="max-w-[16rem] truncate text-ink">{payout.details}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-mute">Their balance</dt><dd className="tnum text-ink">{usd(payout.publisher?.balanceMicros ?? 0)}</dd></div>
        </dl>
        {action === 'PAY' && (
          <p className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
            This debits the end user's wallet and writes a payout entry to the ledger. Send the money through your
            payment rail first, then record the reference here.
          </p>
        )}
        <Field label="Payment reference" hint="Bank UTR, PayPal batch id, transaction hash…">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
