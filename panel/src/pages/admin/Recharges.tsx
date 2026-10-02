import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useInvalidate, useMutation } from '../../lib/useApi';
import { post, qs } from '../../lib/api';
import { Button, Card, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, StatusBadge, Tabs, Table, Td, useToast } from '../../components/ui';
import { dateTime, num, usd } from '../../lib/format';
import type { Paged, Recharge } from '../../lib/types';

export default function AdminRecharges() {
  const [tab, setTab] = useState('PENDING');
  const [page, setPage] = useState(1);
  const [settling, setSettling] = useState<Recharge | null>(null);
  const { data, isLoading, error, refetch } = useApi<Paged<Recharge>>(`/admin/recharges${qs({ status: tab, page, limit: 20 })}`);

  return (
    <>
      <PageHeader title="Vendor top-ups" subtitle="Prepaid funding — money only moves once you confirm settlement" />
      <Tabs active={tab} onChange={(t) => { setTab(t); setPage(1); }}
        tabs={[{ id: 'PENDING', label: 'Pending' }, { id: 'COMPLETED', label: 'Completed' }, { id: 'FAILED', label: 'Failed' }]} />

      <Card pad={false}>
        {isLoading ? <Loading /> : error ? <div className="p-5"><ErrorNote error={error} retry={() => void refetch()} /></div> : (
          <>
            <Table head={['Requested', 'Vendor', 'Amount', 'Method', 'Reference', 'Status', '']} empty={!data?.data.length}>
              {data?.data.map((r) => (
                <tr key={r.id} className="hover:bg-surface/60">
                  <Td className="text-xs">{dateTime(r.createdAt)}</Td>
                  <Td className="font-medium text-ink">
                    <Link to={`/admin/vendors/${r.vendorId}`} className="hover:text-brand hover:underline">{r.vendor?.companyName}</Link>
                    <span className="tnum block text-2xs text-ink-mute">wallet {usd(r.vendor?.balanceMicros ?? 0)}</span>
                  </Td>
                  <Td className="tnum font-semibold text-ink">{usd(r.amountMicros)}</Td>
                  <Td>{r.method}</Td>
                  <Td className="text-xs">{r.reference || '—'}</Td>
                  <Td><StatusBadge status={r.status} /></Td>
                  <Td>
                    <div className="flex justify-end">
                      {r.status === 'PENDING' && <Button size="sm" variant="primary" onClick={() => setSettling(r)}>Settle</Button>}
                      {r.status !== 'PENDING' && <span className="text-2xs text-ink-mute">{dateTime(r.settledAt)}</span>}
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
            <Pagination page={data?.page ?? 1} pages={data?.pages ?? 1} onPage={setPage} />
          </>
        )}
      </Card>

      <SettleModal recharge={settling} onClose={() => setSettling(null)} />
    </>
  );
}

function SettleModal({ recharge, onClose }: { recharge: Recharge | null; onClose: () => void }) {
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const invalidate = useInvalidate();
  const toast = useToast();

  const mut = useMutation({
    mutationFn: (decision: 'COMPLETE' | 'FAIL') => post(`/admin/recharges/${recharge!.id}/settle`, { decision, reference, note }),
    onSuccess: () => { invalidate('/admin/'); toast.push('Top-up settled'); onClose(); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  if (!recharge) return null;
  return (
    <Modal open onClose={onClose} title={`Settle ${usd(recharge.amountMicros)} — ${recharge.vendor?.companyName ?? ''}`}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" loading={mut.isPending} onClick={() => mut.mutate('FAIL')}>Mark failed</Button>
        <Button variant="primary" loading={mut.isPending} onClick={() => mut.mutate('COMPLETE')}>Credit wallet</Button></>}>
      <div className="space-y-4">
        <p className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
          Confirm the money has landed in your account before crediting. Crediting adds
          <span className="tnum font-semibold"> {usd(recharge.amountMicros)}</span> of spendable balance immediately.
        </p>
        <Field label="Bank / gateway reference"><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={recharge.reference} /></Field>
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
