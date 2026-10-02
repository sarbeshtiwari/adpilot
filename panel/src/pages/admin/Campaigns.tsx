import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi, useInvalidate, useMutation } from '../../lib/useApi';
import { post, qs } from '../../lib/api';
import { Badge, Button, Card, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Select, StatusBadge, Table, Td, useToast } from '../../components/ui';
import { dateTime, num, pct, usd } from '../../lib/format';
import type { Campaign, Paged } from '../../lib/types';

export const geoLabel = (rules: Campaign['geoRules']) => {
  if (!rules.length) return 'Worldwide';
  return rules.map((g) => {
    const parts = [g.area, g.city, g.state, g.country].filter((x) => x && x !== '*');
    return `${g.mode === 'EXCLUDE' ? '−' : ''}${parts.length ? parts.join(', ') : 'Worldwide'}`;
  }).join(' · ');
};

export default function AdminCampaigns() {
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const status = params.get('status') ?? '';
  const [review, setReview] = useState<Campaign | null>(null);

  const { data, isLoading, error, refetch } = useApi<Paged<Campaign>>(`/admin/campaigns${qs({ page, status, q, limit: 20 })}`);

  return (
    <>
      <PageHeader title="Campaigns" subtitle="Every campaign across every vendor" />
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <Input placeholder="Search campaign name…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="max-w-xs" />
          <Select value={status} onChange={(e) => { const v = e.target.value; setParams(v ? { status: v } : {}); setPage(1); }} className="w-48">
            <option value="">All statuses</option>
            {['PENDING_REVIEW', 'ACTIVE', 'PAUSED', 'DRAFT', 'COMPLETED', 'REJECTED'].map((s) => (
              <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>
            ))}
          </Select>
          <span className="ml-auto text-xs text-ink-mute">{num(data?.total ?? 0)} campaigns</span>
        </div>

        {isLoading ? <Loading /> : error ? <div className="p-5"><ErrorNote error={error} retry={() => void refetch()} /></div> : (
          <>
            <Table head={['Campaign', 'Vendor', 'Status', 'Pricing', 'Budget', 'Targeting', 'Creatives', '']} empty={!data?.data.length}>
              {data?.data.map((c) => {
                const used = Number(c.totalBudgetMicros) ? Number(c.spentMicros) / Number(c.totalBudgetMicros) : 0;
                return (
                  <tr key={c.id} className="hover:bg-surface/60">
                    <Td className="font-medium text-ink">
                      {c.name}
                      <span className="block text-2xs text-ink-mute">{c.category} · priority {c.priority}</span>
                    </Td>
                    <Td>
                      <Link to={`/admin/vendors/${c.vendorId}`} className="hover:text-brand hover:underline">{c.vendor?.companyName}</Link>
                      <span className="tnum block text-2xs text-ink-mute">wallet {usd(c.vendor?.balanceMicros ?? 0)}</span>
                    </Td>
                    <Td><StatusBadge status={c.status} /></Td>
                    <Td className="text-xs">
                      {c.pricingModel !== 'CPC' && <span className="tnum block">CPM {usd(c.cpmMicros)}</span>}
                      {c.pricingModel !== 'CPM' && <span className="tnum block">CPC {usd(c.cpcMicros)}</span>}
                    </Td>
                    <Td>
                      <span className="tnum text-xs">{usd(c.spentMicros)} / {usd(c.totalBudgetMicros)}</span>
                      <span className="mt-1 block h-1 w-24 overflow-hidden rounded-full bg-surface">
                        <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.min(used * 100, 100)}%` }} />
                      </span>
                    </Td>
                    <Td className="max-w-[14rem] truncate text-xs" title={geoLabel(c.geoRules)}>{geoLabel(c.geoRules)}</Td>
                    <Td className="tnum">{c.ads.length}</Td>
                    <Td><div className="flex justify-end"><Button size="sm" onClick={() => setReview(c)}>Review</Button></div></Td>
                  </tr>
                );
              })}
            </Table>
            <Pagination page={data?.page ?? 1} pages={data?.pages ?? 1} onPage={setPage} />
          </>
        )}
      </Card>

      <ReviewModal campaign={review} onClose={() => setReview(null)} />
    </>
  );
}

function ReviewModal({ campaign, onClose }: { campaign: Campaign | null; onClose: () => void }) {
  const [note, setNote] = useState('');
  const invalidate = useInvalidate();
  const toast = useToast();

  const mut = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT' | 'PAUSE') =>
      post(`/admin/campaigns/${campaign!.id}/review`, { decision, note }),
    onSuccess: () => { invalidate('/admin/'); toast.push('Decision recorded'); onClose(); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  if (!campaign) return null;
  return (
    <Modal open wide onClose={onClose} title={`Review — ${campaign.name}`}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="secondary" loading={mut.isPending} onClick={() => mut.mutate('PAUSE')}>Pause</Button>
          <Button variant="danger" loading={mut.isPending} onClick={() => mut.mutate('REJECT')}>Reject</Button>
          <Button variant="primary" loading={mut.isPending} onClick={() => mut.mutate('APPROVE')}>Approve &amp; go live</Button>
        </>
      }>
      <div className="space-y-5">
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          {[
            ['Vendor', campaign.vendor?.companyName ?? '—'],
            ['Category', campaign.category],
            ['Pricing', campaign.pricingModel.replace('_', ' + ')],
            ['Budget', `${usd(campaign.spentMicros)} of ${usd(campaign.totalBudgetMicros)}`],
            ['Daily cap', campaign.dailyBudgetMicros === '0' ? 'none' : usd(campaign.dailyBudgetMicros)],
            ['Frequency cap', campaign.frequencyCapPerDay ? `${campaign.frequencyCapPerDay}/day/user` : 'none'],
            ['Runs', `${dateTime(campaign.startAt)} → ${dateTime(campaign.endAt)}`],
            ['Targeting', geoLabel(campaign.geoRules)],
          ].map(([k, v]) => (
            <div key={k}><dt className="text-2xs uppercase tracking-wide text-ink-mute">{k}</dt><dd className="mt-0.5 text-ink">{v}</dd></div>
          ))}
        </dl>

        <div>
          <p className="mb-2 text-xs font-semibold text-ink">Creatives ({campaign.ads.length})</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {campaign.ads.map((a) => (
              <div key={a.id} className="rounded-lg border border-hairline p-3">
                <div className="mb-1 flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: a.accent }} aria-hidden />
                  <p className="flex-1 truncate text-sm font-medium text-ink">{a.headline}</p>
                  <StatusBadge status={a.status} />
                </div>
                <p className="text-xs text-ink-soft">{a.body}</p>
                <p className="mt-2 truncate text-2xs text-ink-mute">{a.ctaText} → {a.clickUrl}</p>
                <p className="tnum mt-1 text-2xs text-ink-mute">
                  {num(a.impressionCount)} impressions · {num(a.clickCount)} clicks · {pct(a.impressionCount ? a.clickCount / a.impressionCount : 0)}
                </p>
              </div>
            ))}
          </div>
        </div>

        <Field label="Review note" hint="Shown to the vendor and stored in the audit log">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Looks good / needs a clearer disclosure…" />
        </Field>
        {campaign.reviewNote && <p className="rounded-lg bg-surface px-3 py-2 text-xs text-ink-mute">Previous note: {campaign.reviewNote}</p>}
        {Number(campaign.vendor?.balanceMicros ?? 0) <= 0 && (
          <p className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
            <Badge tone="warn">wallet empty</Badge> This vendor cannot be billed — approving will not deliver until they top up.
          </p>
        )}
      </div>
    </Modal>
  );
}
