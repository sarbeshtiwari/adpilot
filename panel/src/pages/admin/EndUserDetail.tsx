import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi, useInvalidate, useMutation } from '../../lib/useApi';
import { patch, post } from '../../lib/api';
import { CategoryBars, TrendChart } from '../../components/charts';
import { Badge, Button, Card, CardHeader, ErrorNote, Field, Input, Loading, Modal, PageHeader, RangePicker, StatTile, StatusBadge, Table, Td, Toggle, useToast } from '../../components/ui';
import { compact, dateTime, num, pct, relative, usd, usdCompact } from '../../lib/format';
import type { Device, HostRow, Impression, LedgerEntry, Payout, Publisher, SeriesPoint, Totals } from '../../lib/types';

type Detail = {
  publisher: Publisher & { devices: Device[]; payouts: Payout[] };
  totals: Totals; series: SeriesPoint[]; hosts: HostRow[]; ledger: LedgerEntry[]; impressions: Impression[];
  policy: { maxAdsPerHour: number; minSecondsBetweenAds: number };
};

export default function AdminEndUserDetail() {
  const { id } = useParams();
  const [days, setDays] = useState(30);
  const [adjusting, setAdjusting] = useState(false);
  const { data, isLoading, error, refetch } = useApi<Detail>(`/admin/publishers/${id}?days=${days}`);

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} retry={() => void refetch()} />;
  if (!data) return null;
  const p = data.publisher;
  const isOverridden = p.maxAdsPerHour !== null || p.minSecondsBetweenAds !== null;

  return (
    <>
      <Link to="/admin/end-users" className="mb-3 inline-block text-xs text-ink-mute hover:text-ink">← All end users</Link>
      <PageHeader title={p.displayName} subtitle={`${p.user?.email} · ${[p.city, p.state, p.country].filter(Boolean).join(', ') || 'location unknown'}`}
        action={<div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setAdjusting(true)}>Adjust balance</Button>
          <RangePicker days={days} onChange={setDays} />
        </div>} />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Withdrawable balance" value={usdCompact(p.balanceMicros)} tone="good" />
        <StatTile label="Lifetime earned" value={usdCompact(p.lifetimeEarnedMicros)} sub={`${usd(p.paidOutMicros)} paid out`} />
        <StatTile label="Impressions in range" value={compact(data.totals.impressions)} sub={`${num(data.totals.clicks)} clicks · ${pct(data.totals.ctr)}`} />
        <StatTile label="Ad delivery" value={p.adsEnabled ? 'Enabled' : 'Paused'}
          sub={`max ${p.maxAdsPerHour ?? data.policy.maxAdsPerHour}/hr · ${p.minSecondsBetweenAds ?? data.policy.minSecondsBetweenAds}s gap${isOverridden ? ' (override)' : ''}`}
          tone={p.adsEnabled ? undefined : 'bad'} />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <TrendChart data={data.series} title="Earnings" metric="payoutMicros" format="money" slot={0} />
        <CategoryBars title="Where they see ads" rows={data.hosts.map((h) => ({ key: h.hostApp, label: h.hostApp, value: h.impressions }))} />
      </div>

      <PacingCard publisherId={p.id} publisher={p} policy={data.policy} />

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card pad={false}>
          <div className="p-5 pb-0"><CardHeader title="Devices" subtitle="Paired extension installs" /></div>
          <Table head={['Label', 'Platform', 'Version', 'Impressions', 'Last seen']} empty={!p.devices.length}>
            {p.devices.map((d) => (
              <tr key={d.id}>
                <Td className="font-medium text-ink">{d.label}{d.revokedAt && <Badge tone="bad">revoked</Badge>}</Td>
                <Td className="text-xs">{d.platform ?? '—'} · {d.browser ?? '—'}</Td>
                <Td className="text-xs">{d.extVersion ?? '—'}</Td>
                <Td className="tnum">{num(d._count?.impressions ?? 0)}</Td>
                <Td className="text-xs">{relative(d.lastSeenAt)}</Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card pad={false}>
          <div className="p-5 pb-0"><CardHeader title="Withdrawals" subtitle={`Payout method: ${p.payoutMethod ?? 'not set'}`} /></div>
          <Table head={['Requested', 'Amount', 'Method', 'Status']} empty={!p.payouts.length}>
            {p.payouts.map((x) => (
              <tr key={x.id}>
                <Td className="text-xs">{dateTime(x.requestedAt)}</Td>
                <Td className="tnum font-medium text-ink">{usd(x.amountMicros)}</Td>
                <Td>{x.method}</Td>
                <Td><StatusBadge status={x.status} /></Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Card pad={false}>
        <div className="p-5 pb-0"><CardHeader title="Recent impressions" subtitle="Full delivery detail — admin only" /></div>
        <Table head={['When', 'Creative', 'Advertiser', 'Surface', 'Location', 'Status', 'Earned']} empty={!data.impressions.length}>
          {data.impressions.slice(0, 25).map((i) => (
            <tr key={i.id}>
              <Td className="text-xs">{dateTime(i.servedAt)}</Td>
              <Td className="max-w-[16rem] truncate font-medium text-ink" title={i.ad.headline}>{i.ad.headline}</Td>
              <Td className="text-xs">{i.campaign.name}</Td>
              <Td className="text-xs">{i.hostApp}<span className="block text-2xs text-ink-mute">{i.modelHint}</span></Td>
              <Td className="text-xs">{[i.city, i.country].filter(Boolean).join(', ')}</Td>
              <Td><StatusBadge status={i.status} /></Td>
              <Td className="tnum text-good">{usd(i.payoutMicros, { precise: true })}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <AdjustModal open={adjusting} onClose={() => setAdjusting(false)} publisherId={p.id} name={p.displayName} balance={p.balanceMicros} />
    </>
  );
}

/** Delivery pacing for one account. Super-admin only — end users cannot set this. */
function PacingCard({ publisherId, publisher, policy }: {
  publisherId: string;
  publisher: Publisher;
  policy: { maxAdsPerHour: number; minSecondsBetweenAds: number };
}) {
  const [override, setOverride] = useState(publisher.maxAdsPerHour !== null || publisher.minSecondsBetweenAds !== null);
  const [maxPerHour, setMaxPerHour] = useState(publisher.maxAdsPerHour ?? policy.maxAdsPerHour);
  const [gap, setGap] = useState(publisher.minSecondsBetweenAds ?? policy.minSecondsBetweenAds);
  const [adsEnabled, setAdsEnabled] = useState(publisher.adsEnabled);
  const invalidate = useInvalidate();
  const toast = useToast();

  const save = useMutation({
    mutationFn: () => patch(`/admin/publishers/${publisherId}/pacing`, {
      maxAdsPerHour: override ? maxPerHour : null,
      minSecondsBetweenAds: override ? gap : null,
      adsEnabled,
    }),
    onSuccess: () => { invalidate('/admin/'); toast.push('Delivery pacing updated'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  const dirty =
    override !== (publisher.maxAdsPerHour !== null || publisher.minSecondsBetweenAds !== null) ||
    adsEnabled !== publisher.adsEnabled ||
    (override && (maxPerHour !== publisher.maxAdsPerHour || gap !== publisher.minSecondsBetweenAds));

  return (
    <Card className="mb-6">
      <CardHeader
        title="Delivery pacing"
        subtitle="Platform policy applies unless you set an override here. End users cannot change these."
        action={<Button variant="primary" size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>}
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="flex items-start justify-between gap-4 rounded-lg border border-hairline px-3 py-2.5">
          <div>
            <p className="text-xs font-medium text-ink">Ad delivery</p>
            <p className="text-2xs text-ink-mute">Switching this off stops all earning for this account.</p>
          </div>
          <Toggle checked={adsEnabled} onChange={setAdsEnabled} />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border border-hairline px-3 py-2.5">
          <div>
            <p className="text-xs font-medium text-ink">Override platform policy</p>
            <p className="text-2xs text-ink-mute">
              Platform default is {policy.maxAdsPerHour}/hr, {policy.minSecondsBetweenAds}s apart.
            </p>
          </div>
          <Toggle checked={override} onChange={(v) => {
            setOverride(v);
            if (v) { setMaxPerHour(publisher.maxAdsPerHour ?? policy.maxAdsPerHour); setGap(publisher.minSecondsBetweenAds ?? policy.minSecondsBetweenAds); }
          }} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Max ads / hour">
            <Input type="number" min={1} max={240} disabled={!override}
              value={override ? maxPerHour : policy.maxAdsPerHour}
              onChange={(e) => setMaxPerHour(Number(e.target.value))} />
          </Field>
          <Field label="Min gap (seconds)">
            <Input type="number" min={5} max={3600} disabled={!override}
              value={override ? gap : policy.minSecondsBetweenAds}
              onChange={(e) => setGap(Number(e.target.value))} />
          </Field>
        </div>
      </div>
      {!override && (
        <p className="mt-3 text-2xs text-ink-mute">
          Inheriting the platform policy. Change it for everyone under Platform → Settings.
        </p>
      )}
    </Card>
  );
}

function AdjustModal({ open, onClose, publisherId, name, balance }: {
  open: boolean; onClose: () => void; publisherId: string; name: string; balance: string;
}) {
  const [amount, setAmount] = useState('1');
  const [note, setNote] = useState('Goodwill credit');
  const invalidate = useInvalidate();
  const toast = useToast();

  const mut = useMutation({
    mutationFn: () => post(`/admin/publishers/${publisherId}/adjust`, { amountUsd: Number(amount), note }),
    onSuccess: () => { invalidate('/admin/'); toast.push('Balance adjusted'); onClose(); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  return (
    <Modal open={open} onClose={onClose} title={`Adjust balance — ${name}`}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={mut.isPending} onClick={() => mut.mutate()}>Apply</Button></>}>
      <div className="space-y-4">
        <p className="rounded-lg bg-surface px-3 py-2 text-xs text-ink-mute">
          Current balance <span className="tnum font-semibold text-ink">{usd(balance)}</span>
        </p>
        <Field label="Amount in USD" hint="Negative to claw back">
          <Input type="number" step="0.0001" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Reason"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
