import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useInvalidate, useMutation } from '../../lib/useApi';
import { post, qs } from '../../lib/api';
import { CampaignForm, emptyDraft, toPayload, type CampaignDraft } from '../../components/CampaignForm';
import { Button, Card, Empty, ErrorNote, Input, Loading, Modal, PageHeader, Pagination, Select, StatusBadge, Table, Td, useToast } from '../../components/ui';
import { dateShort, num, pct, usd } from '../../lib/format';
import type { Campaign, Paged } from '../../lib/types';

export const geoSummary = (rules: Campaign['geoRules']) => {
  if (!rules.length) return 'Worldwide';
  return rules.slice(0, 2).map((g) => {
    const parts = [g.area, g.city, g.state, g.country].filter((x) => x && x !== '*');
    return `${g.mode === 'EXCLUDE' ? 'not ' : ''}${parts.length ? parts.join(', ') : 'worldwide'}`;
  }).join(' · ') + (rules.length > 2 ? ` +${rules.length - 2}` : '');
};

export default function VendorCampaigns() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error, refetch } = useApi<Paged<Campaign>>(`/vendor/campaigns${qs({ page, status, q, limit: 20 })}`);

  return (
    <>
      <PageHeader title="Campaigns" subtitle="Target by place, pace by budget, rotate creatives automatically"
        action={<Button variant="primary" onClick={() => setCreating(true)}>New campaign</Button>} />

      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <Input placeholder="Search…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="max-w-xs" />
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-44">
            <option value="">All statuses</option>
            {['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'PAUSED', 'COMPLETED', 'REJECTED'].map((s) => (
              <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>
            ))}
          </Select>
          <span className="ml-auto text-xs text-ink-mute">{num(data?.total ?? 0)} campaigns</span>
        </div>

        {isLoading ? <Loading /> : error ? <div className="p-5"><ErrorNote error={error} retry={() => void refetch()} /></div>
          : !data?.data.length ? (
            <div className="p-5">
              <Empty title="No campaigns yet"
                hint="A campaign holds your bids, budget, targeting and creatives. Ads rotate between creatives each time a model starts thinking."
                action={<Button variant="primary" onClick={() => setCreating(true)}>Create your first campaign</Button>} />
            </div>
          ) : (
            <>
              <Table head={['Campaign', 'Status', 'Bids', 'Budget', 'Targeting', 'Creatives', 'Delivery', 'Flight']}>
                {data.data.map((c) => (
                  <tr key={c.id} className="hover:bg-surface/60">
                    <Td className="font-medium text-ink">
                      <Link to={`/vendor/campaigns/${c.id}`} className="hover:text-brand hover:underline">{c.name}</Link>
                      <span className="block text-2xs text-ink-mute">{c.category}</span>
                    </Td>
                    <Td><StatusBadge status={c.status} /></Td>
                    <Td className="text-xs">
                      {c.pricingModel !== 'CPC' && <span className="tnum block">CPM {usd(c.cpmMicros)}</span>}
                      {c.pricingModel !== 'CPM' && <span className="tnum block">CPC {usd(c.cpcMicros)}</span>}
                    </Td>
                    <Td>
                      <span className="tnum text-xs">{usd(c.spentMicros)} / {usd(c.totalBudgetMicros)}</span>
                      <span className="mt-1 block h-1 w-24 overflow-hidden rounded-full bg-surface">
                        <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.min(c.budgetUsedPct ?? 0, 100)}%` }} />
                      </span>
                    </Td>
                    <Td className="max-w-[12rem] truncate text-xs" title={geoSummary(c.geoRules)}>{geoSummary(c.geoRules)}</Td>
                    <Td className="tnum">{c.ads.filter((a) => a.status === 'ACTIVE').length}<span className="text-ink-mute">/{c.ads.length}</span></Td>
                    <Td className="tnum text-xs">
                      {num(c.stats?.impressions ?? 0)} imp
                      <span className="block text-2xs text-ink-mute">{num(c.stats?.clicks ?? 0)} clicks · {pct(c.stats?.ctr ?? 0)}</span>
                    </Td>
                    <Td className="whitespace-nowrap text-xs">{dateShort(c.startAt)} → {dateShort(c.endAt)}</Td>
                  </tr>
                ))}
              </Table>
              <Pagination page={data.page} pages={data.pages} onPage={setPage} />
            </>
          )}
      </Card>

      <CreateModal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function CreateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState<CampaignDraft>(emptyDraft());
  const invalidate = useInvalidate();
  const toast = useToast();

  const mut = useMutation({
    mutationFn: () => post<Campaign>('/vendor/campaigns', toPayload(draft)),
    onSuccess: () => {
      invalidate('/vendor/');
      toast.push('Campaign created as a draft — add a creative next');
      setDraft(emptyDraft());
      onClose();
    },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  return (
    <Modal open={open} onClose={onClose} wide title="New campaign"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={mut.isPending} disabled={!draft.name} onClick={() => mut.mutate()}>Create draft</Button></>}>
      <CampaignForm draft={draft} onChange={setDraft} />
    </Modal>
  );
}
