import { useState } from 'react';
import { useApi, useInvalidate, useMutation } from '../../lib/useApi';
import { post, qs } from '../../lib/api';
import { Button, Card, Empty, ErrorNote, Loading, PageHeader, Pagination, StatusBadge, Tabs, useToast } from '../../components/ui';
import { num, pct } from '../../lib/format';
import type { Ad, Paged } from '../../lib/types';

type AdRow = Ad & { campaign: { id: string; name: string; status: string; category: string; vendor: { companyName: string } } };

export default function AdminModeration() {
  const [tab, setTab] = useState('ACTIVE');
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = useApi<Paged<AdRow>>(`/admin/ads${qs({ status: tab, page, limit: 24 })}`);
  const invalidate = useInvalidate();
  const toast = useToast();

  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'APPROVE' | 'REJECT' }) => post(`/admin/ads/${v.id}/review`, { decision: v.decision }),
    onSuccess: () => { invalidate('/admin/'); toast.push('Creative updated'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  return (
    <>
      <PageHeader title="Creative review" subtitle="Every ad unit that can appear inside a model's thinking pane" />
      <Tabs active={tab} onChange={(t) => { setTab(t); setPage(1); }}
        tabs={[{ id: 'ACTIVE', label: 'Live' }, { id: 'PAUSED', label: 'Paused' }, { id: 'REJECTED', label: 'Rejected' }]} />

      {isLoading ? <Loading /> : error ? <ErrorNote error={error} retry={() => void refetch()} /> : !data?.data.length ? (
        <Empty title="Nothing to review here" hint="Creatives appear as vendors add them to campaigns." />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.data.map((ad) => (
              <Card key={ad.id} className="flex flex-col">
                {/* Rendered the same way the extension renders it. */}
                <div className="mb-3 rounded-lg border-l-[3px] bg-surface p-3" style={{ borderColor: ad.accent }}>
                  <p className="text-2xs uppercase tracking-wide text-ink-mute">Sponsored · {ad.campaign.vendor.companyName}</p>
                  <p className="mt-1 text-sm font-semibold text-ink">{ad.headline}</p>
                  <p className="mt-0.5 text-xs text-ink-soft">{ad.body}</p>
                  <p className="mt-2 text-xs font-medium" style={{ color: ad.accent }}>{ad.ctaText} →</p>
                </div>
                <div className="mb-3 space-y-1 text-2xs text-ink-mute">
                  <p className="truncate">Campaign: <span className="text-ink-soft">{ad.campaign.name}</span></p>
                  <p className="truncate">Destination: <span className="text-ink-soft">{ad.clickUrl}</span></p>
                  <p className="tnum">{num(ad.impressionCount)} impressions · {num(ad.clickCount)} clicks · {pct(ad.impressionCount ? ad.clickCount / ad.impressionCount : 0)} CTR</p>
                </div>
                <div className="mt-auto flex items-center justify-between gap-2">
                  <StatusBadge status={ad.status} />
                  <div className="flex gap-1">
                    {ad.status !== 'ACTIVE' && <Button size="sm" variant="primary" onClick={() => decide.mutate({ id: ad.id, decision: 'APPROVE' })}>Approve</Button>}
                    {ad.status !== 'REJECTED' && <Button size="sm" variant="danger" onClick={() => decide.mutate({ id: ad.id, decision: 'REJECT' })}>Reject</Button>}
                  </div>
                </div>
              </Card>
            ))}
          </div>
          <div className="mt-4 rounded-xl border border-hairline bg-panel">
            <Pagination page={data.page} pages={data.pages} onPage={setPage} />
          </div>
        </>
      )}
    </>
  );
}
