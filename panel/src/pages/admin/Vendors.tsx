import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi, useInvalidate, useMutation } from '../../lib/useApi';
import { patch, post, qs } from '../../lib/api';
import { Button, Card, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Select, StatusBadge, Table, Td, useToast } from '../../components/ui';
import { dateTime, num, relative, usd } from '../../lib/format';
import type { Paged, Vendor } from '../../lib/types';

export default function AdminVendors() {
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const status = params.get('status') ?? '';
  const [credit, setCredit] = useState<Vendor | null>(null);

  const path = `/admin/vendors${qs({ page, status, q, limit: 20 })}`;
  const { data, isLoading, error, refetch } = useApi<Paged<Vendor>>(path);
  const invalidate = useInvalidate();
  const toast = useToast();

  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: string }) => patch(`/admin/vendors/${v.id}`, { status: v.status }),
    onSuccess: () => { invalidate('/admin/'); toast.push('Vendor updated'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  return (
    <>
      <PageHeader title="Vendors" subtitle="Advertiser companies, their wallets and their delivery" />

      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <Input placeholder="Search company or email…" value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }} className="max-w-xs" />
          <Select value={status} onChange={(e) => { const v = e.target.value; setParams(v ? { status: v } : {}); setPage(1); }} className="w-40">
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="PENDING">Pending approval</option>
            <option value="SUSPENDED">Suspended</option>
          </Select>
          <span className="ml-auto text-xs text-ink-mute">{num(data?.total ?? 0)} vendors</span>
        </div>

        {isLoading ? <Loading /> : error ? <div className="p-5"><ErrorNote error={error} retry={() => void refetch()} /></div> : (
          <>
            <Table head={['Company', 'Contact', 'Status', 'Balance', 'Lifetime spend', 'Campaigns', 'Last seen', '']} empty={!data?.data.length}>
              {data?.data.map((v) => (
                <tr key={v.id} className="hover:bg-surface/60">
                  <Td className="font-medium text-ink">
                    <Link to={`/admin/vendors/${v.id}`} className="hover:text-brand hover:underline">{v.companyName}</Link>
                    {v.website && <span className="block text-2xs text-ink-mute">{v.website}</span>}
                  </Td>
                  <Td>{v.user?.email}<span className="block text-2xs text-ink-mute">{v.user?.name}</span></Td>
                  <Td><StatusBadge status={v.status} /></Td>
                  <Td className="tnum font-medium text-ink">{usd(v.balanceMicros)}</Td>
                  <Td className="tnum">{usd(v.lifetimeSpendMicros)}</Td>
                  <Td className="tnum">{v._count?.campaigns ?? 0}</Td>
                  <Td className="text-xs">{relative(v.user?.lastLoginAt)}</Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" onClick={() => setCredit(v)}>Credit</Button>
                      {v.status === 'ACTIVE' ? (
                        <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: v.id, status: 'SUSPENDED' })}>Suspend</Button>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: v.id, status: 'ACTIVE' })}>Activate</Button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
            <Pagination page={data?.page ?? 1} pages={data?.pages ?? 1} onPage={setPage} />
          </>
        )}
      </Card>

      <CreditModal vendor={credit} onClose={() => setCredit(null)} />
    </>
  );
}

function CreditModal({ vendor, onClose }: { vendor: Vendor | null; onClose: () => void }) {
  const [amount, setAmount] = useState('100');
  const [note, setNote] = useState('Manual credit');
  const invalidate = useInvalidate();
  const toast = useToast();

  const mut = useMutation({
    mutationFn: () => post(`/admin/vendors/${vendor!.id}/credit`, { amountUsd: Number(amount), note }),
    onSuccess: () => { invalidate('/admin/'); toast.push(`Wallet adjusted by $${amount}`); onClose(); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  return (
    <Modal open={!!vendor} onClose={onClose} title={`Adjust wallet — ${vendor?.companyName ?? ''}`}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={mut.isPending} onClick={() => mut.mutate()}>Apply</Button></>}>
      <div className="space-y-4">
        <p className="rounded-lg bg-surface px-3 py-2 text-xs text-ink-mute">
          Current balance <span className="tnum font-semibold text-ink">{usd(vendor?.balanceMicros ?? 0)}</span>.
          A negative amount books a correction against the wallet.
        </p>
        <Field label="Amount in USD" hint="Use a negative number to claw back">
          <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Reason" hint="Recorded in the ledger and the audit log">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
