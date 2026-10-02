import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApi, useInvalidate, useMutation } from '../../lib/useApi';
import { del, patch, post } from '../../lib/api';
import { BarList, TrendChart } from '../../components/charts';
import { CampaignForm, toDraft, toPayload, type CampaignDraft } from '../../components/CampaignForm';
import { Badge, Button, Card, CardHeader, ErrorNote, Field, Input, Loading, Modal, PageHeader, StatTile, StatusBadge, Tabs, useToast } from '../../components/ui';
import { compact, dateTime, num, pct, usd, usdCompact } from '../../lib/format';
import type { Ad, Campaign, GeoRow, SeriesPoint } from '../../lib/types';
import { geoSummary } from './Campaigns';

type Detail = { campaign: Campaign; series: SeriesPoint[]; geo: GeoRow[] };

export default function VendorCampaignDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [adModal, setAdModal] = useState<{ ad: Ad | null } | null>(null);
  const { data, isLoading, error, refetch } = useApi<Detail>(`/vendor/campaigns/${id}?days=30`);
  const invalidate = useInvalidate();
  const toast = useToast();

  const act = useMutation({
    mutationFn: (action: 'submit' | 'pause' | 'resume' | 'archive') => post(`/vendor/campaigns/${id}/status`, { action }),
    onSuccess: () => { invalidate('/vendor/'); toast.push('Campaign updated'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  const remove = useMutation({
    mutationFn: () => del(`/vendor/campaigns/${id}`),
    onSuccess: () => { invalidate('/vendor/'); toast.push('Campaign deleted'); nav('/vendor/campaigns'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} retry={() => void refetch()} />;
  if (!data) return null;

  const c = data.campaign;
  const impressions = c.ads.reduce((a, b) => a + b.impressionCount, 0);
  const clicks = c.ads.reduce((a, b) => a + b.clickCount, 0);
  const usedPct = Number(c.totalBudgetMicros) ? (Number(c.spentMicros) / Number(c.totalBudgetMicros)) * 100 : 0;

  return (
    <>
      <Link to="/vendor/campaigns" className="mb-3 inline-block text-xs text-ink-mute hover:text-ink">← All campaigns</Link>
      <PageHeader title={c.name} subtitle={`${c.category} · ${c.pricingModel.replace('_', ' + ')} · priority ${c.priority}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={c.status} />
            {c.status === 'DRAFT' && <Button variant="primary" loading={act.isPending} onClick={() => act.mutate('submit')}>Submit for review</Button>}
            {c.status === 'REJECTED' && <Button variant="primary" loading={act.isPending} onClick={() => act.mutate('submit')}>Resubmit</Button>}
            {c.status === 'ACTIVE' && <Button loading={act.isPending} onClick={() => act.mutate('pause')}>Pause</Button>}
            {c.status === 'PAUSED' && <Button variant="primary" loading={act.isPending} onClick={() => act.mutate('resume')}>Resume</Button>}
            <Button onClick={() => setEditing(true)}>Edit</Button>
          </div>
        } />

      {c.reviewNote && (
        <div className="mb-6 rounded-xl border border-hairline bg-panel px-4 py-3 text-sm">
          <span className="text-xs font-semibold text-ink-mute">Reviewer note</span>
          <p className="mt-0.5 text-ink-soft">{c.reviewNote}</p>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Spent" value={usdCompact(c.spentMicros)} sub={`${usedPct.toFixed(1)}% of ${usd(c.totalBudgetMicros)}`} />
        <StatTile label="Impressions" value={compact(impressions)} sub="all time" />
        <StatTile label="Clicks" value={num(clicks)} sub={`${pct(impressions ? clicks / impressions : 0)} CTR`} />
        <StatTile label="Daily cap" value={c.dailyBudgetMicros === '0' ? 'None' : usdCompact(c.dailyBudgetMicros)}
          sub={c.frequencyCapPerDay ? `${c.frequencyCapPerDay} views/person/day` : 'no frequency cap'} />
      </div>

      <Tabs active={tab} onChange={setTab}
        tabs={[{ id: 'overview', label: 'Performance' }, { id: 'creatives', label: 'Creatives', count: c.ads.length }, { id: 'targeting', label: 'Targeting' }]} />

      {tab === 'overview' && (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            <TrendChart data={data.series} title="Impressions" metric="impressions" slot={0} tall />
            <TrendChart data={data.series} title="Spend" metric="spendMicros" format="money" slot={2} />
          </div>
          <BarList title="Delivery by location" rows={data.geo.slice(0, 10).map((g) => ({ key: g.key, label: g.key, value: g.impressions }))} />
        </div>
      )}

      {tab === 'creatives' && (
        <>
          <div className="mb-4 flex justify-end">
            <Button variant="primary" onClick={() => setAdModal({ ad: null })}>Add creative</Button>
          </div>
          {c.ads.length === 0 ? (
            <Card><p className="py-8 text-center text-sm text-ink-mute">No creatives yet. A campaign needs at least one before it can go live.</p></Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {c.ads.map((ad) => (
                <Card key={ad.id} className="flex flex-col">
                  <div className="mb-3 rounded-lg border-l-[3px] bg-surface p-3" style={{ borderColor: ad.accent }}>
                    <p className="text-2xs uppercase tracking-wide text-ink-mute">Sponsored</p>
                    <p className="mt-1 text-sm font-semibold text-ink">{ad.headline}</p>
                    <p className="mt-0.5 text-xs text-ink-soft">{ad.body}</p>
                    <p className="mt-2 text-xs font-medium" style={{ color: ad.accent }}>{ad.ctaText} →</p>
                  </div>
                  <p className="tnum mb-3 text-2xs text-ink-mute">
                    {num(ad.impressionCount)} impressions · {num(ad.clickCount)} clicks · {pct(ad.impressionCount ? ad.clickCount / ad.impressionCount : 0)} CTR · weight {ad.weight}
                  </p>
                  <div className="mt-auto flex items-center justify-between">
                    <StatusBadge status={ad.status} />
                    <Button size="sm" onClick={() => setAdModal({ ad })}>Edit</Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'targeting' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Geo rules" subtitle={geoSummary(c.geoRules)} />
            {c.geoRules.length === 0 ? <p className="text-sm text-ink-mute">Worldwide — no location restrictions.</p> : (
              <ul className="space-y-2">
                {c.geoRules.map((g, i) => (
                  <li key={i} className="flex items-center gap-2 rounded-lg border border-hairline px-3 py-2 text-sm">
                    <Badge tone={g.mode === 'EXCLUDE' ? 'bad' : 'good'}>{g.mode.toLowerCase()}</Badge>
                    <span className="text-ink">{[g.country, g.state, g.city, g.area].map((x) => (x === '*' ? 'any' : x)).join(' › ')}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Schedule &amp; pacing" />
            <dl className="space-y-2 text-sm">
              {[
                ['Flight', `${dateTime(c.startAt)} → ${dateTime(c.endAt)}`],
                ['Dayparting', c.dayparting ? JSON.parse(c.dayparting).tz + (JSON.parse(c.dayparting).hours?.length ? ` · ${JSON.parse(c.dayparting).hours.length} hours` : ' · all hours') : 'Always on'],
                ['Frequency cap', c.frequencyCapPerDay ? `${c.frequencyCapPerDay} per person per day` : 'Unlimited'],
                ['Priority', `${c.priority} / 10`],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 border-b border-hairline pb-2 last:border-0">
                  <dt className="text-ink-mute">{k}</dt><dd className="text-right text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader title="Danger zone" subtitle="Deleting removes the campaign and its creatives. Delivery history stays in your reports." />
            <Button variant="danger" disabled={c.status === 'ACTIVE'} loading={remove.isPending}
              onClick={() => remove.mutate()}>Delete campaign</Button>
            {c.status === 'ACTIVE' && <p className="mt-2 text-xs text-ink-mute">Pause the campaign first.</p>}
          </Card>
        </div>
      )}

      <EditModal open={editing} onClose={() => setEditing(false)} campaign={c} />
      {adModal && <AdModal campaignId={c.id} ad={adModal.ad} onClose={() => setAdModal(null)} />}
    </>
  );
}

function EditModal({ open, onClose, campaign }: { open: boolean; onClose: () => void; campaign: Campaign }) {
  const [draft, setDraft] = useState<CampaignDraft>(() => toDraft(campaign));
  const invalidate = useInvalidate();
  const toast = useToast();

  const mut = useMutation({
    mutationFn: () => patch(`/vendor/campaigns/${campaign.id}`, toPayload(draft)),
    onSuccess: () => { invalidate('/vendor/'); toast.push('Campaign saved'); onClose(); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  return (
    <Modal open={open} onClose={onClose} wide title={`Edit — ${campaign.name}`}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={mut.isPending} onClick={() => mut.mutate()}>Save changes</Button></>}>
      <CampaignForm draft={draft} onChange={setDraft} />
    </Modal>
  );
}

const ACCENTS = ['#4f46e5', '#2a78d6', '#1baf7a', '#eb6834', '#db2777', '#b45309', '#7c3aed'];

function AdModal({ campaignId, ad, onClose }: { campaignId: string; ad: Ad | null; onClose: () => void }) {
  const [form, setForm] = useState({
    headline: ad?.headline ?? '', body: ad?.body ?? '', ctaText: ad?.ctaText ?? 'Learn more',
    clickUrl: ad?.clickUrl ?? '', accent: ad?.accent ?? '#4f46e5', weight: ad?.weight ?? 1,
    imageUrl: ad?.imageUrl ?? '',
  });
  const invalidate = useInvalidate();
  const toast = useToast();
  const set = (k: string, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      const payload = { ...form, imageUrl: form.imageUrl || null };
      return ad ? patch(`/vendor/ads/${ad.id}`, payload) : post(`/vendor/campaigns/${campaignId}/ads`, payload);
    },
    onSuccess: () => { invalidate('/vendor/'); toast.push(ad ? 'Creative updated' : 'Creative added'); onClose(); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  const remove = useMutation({
    mutationFn: () => del(`/vendor/ads/${ad!.id}`),
    onSuccess: () => { invalidate('/vendor/'); toast.push('Creative deleted'); onClose(); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  const toggle = useMutation({
    mutationFn: () => patch(`/vendor/ads/${ad!.id}`, { status: ad!.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' }),
    onSuccess: () => { invalidate('/vendor/'); toast.push('Creative updated'); onClose(); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  return (
    <Modal open onClose={onClose} title={ad ? 'Edit creative' : 'New creative'}
      footer={
        <>
          {ad && <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Delete</Button>}
          {ad && ad.status !== 'REJECTED' && (
            <Button loading={toggle.isPending} onClick={() => toggle.mutate()}>{ad.status === 'ACTIVE' ? 'Pause' : 'Activate'}</Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!form.headline || !form.clickUrl} onClick={() => save.mutate()}>Save</Button>
        </>
      }>
      <div className="space-y-4">
        {/* Live preview, identical to what the extension renders. */}
        <div className="rounded-lg border-l-[3px] bg-surface p-3" style={{ borderColor: form.accent }}>
          <p className="text-2xs uppercase tracking-wide text-ink-mute">Sponsored · preview</p>
          <p className="mt-1 text-sm font-semibold text-ink">{form.headline || 'Your headline here'}</p>
          <p className="mt-0.5 text-xs text-ink-soft">{form.body || 'One or two lines describing the offer.'}</p>
          <p className="mt-2 text-xs font-medium" style={{ color: form.accent }}>{form.ctaText || 'Learn more'} →</p>
        </div>

        <Field label="Headline" hint={`${form.headline.length}/80`}>
          <Input maxLength={80} value={form.headline} onChange={(e) => set('headline', e.target.value)} />
        </Field>
        <Field label="Body" hint={`${form.body.length}/220`}>
          <Input maxLength={220} value={form.body} onChange={(e) => set('body', e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Call to action"><Input maxLength={24} value={form.ctaText} onChange={(e) => set('ctaText', e.target.value)} /></Field>
          <Field label="Rotation weight" hint="Higher shows more often">
            <Input type="number" min={1} max={100} value={form.weight} onChange={(e) => set('weight', Number(e.target.value))} />
          </Field>
        </div>
        <Field label="Destination URL"><Input type="url" value={form.clickUrl} onChange={(e) => set('clickUrl', e.target.value)} placeholder="https://example.com/landing" /></Field>
        <Field label="Image URL" hint="Optional"><Input type="url" value={form.imageUrl} onChange={(e) => set('imageUrl', e.target.value)} /></Field>
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-soft">Accent colour</p>
          <div className="flex gap-2">
            {ACCENTS.map((a) => (
              <button key={a} type="button" onClick={() => set('accent', a)} aria-label={`Accent ${a}`}
                className={`h-7 w-7 rounded-full border-2 ${form.accent === a ? 'border-ink' : 'border-transparent'}`}
                style={{ background: a }} />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
