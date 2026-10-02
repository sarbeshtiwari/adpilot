import { useEffect, useState } from 'react';
import { useApi, useInvalidate, useMutation } from '../../lib/useApi';
import { put } from '../../lib/api';
import { Button, Card, CardHeader, ErrorNote, Field, Input, Loading, PageHeader, Toggle, useToast } from '../../components/ui';

type SettingsPayload = { settings: Record<string, string>; defaults: Record<string, string> };

const GROUPS: { title: string; hint: string; keys: { key: string; label: string; hint: string; kind: 'money' | 'int' | 'bool' }[] }[] = [
  {
    title: 'Revenue split',
    hint: 'How each billable event is divided between the end user and the platform.',
    keys: [
      { key: 'publisher_share_bps', label: 'End-user share (basis points)', hint: '6000 = the person seeing the ad keeps 60%', kind: 'int' },
      { key: 'min_payout_micros', label: 'Minimum withdrawal (USD)', hint: 'Below this, an end user cannot request a payout', kind: 'money' },
    ],
  },
  {
    title: 'Auction floors',
    hint: 'The lowest bids a vendor may set. Raising these lifts revenue but thins demand.',
    keys: [
      { key: 'cpm_floor_micros', label: 'Minimum CPM (USD)', hint: 'Per 1,000 impressions', kind: 'money' },
      { key: 'cpc_floor_micros', label: 'Minimum CPC (USD)', hint: 'Per click', kind: 'money' },
    ],
  },
  {
    title: 'Delivery pacing',
    hint: 'Applies to every end user. Only you can change these — end users cannot. Override a single account from its page under End users.',
    keys: [
      { key: 'max_ads_per_hour', label: 'Maximum ads per hour', hint: 'Per end user, across all their devices', kind: 'int' },
      { key: 'min_seconds_between_ads', label: 'Minimum gap between ads (seconds)', hint: 'A shorter gap raises revenue and annoyance together', kind: 'int' },
    ],
  },
  {
    title: 'Operations',
    hint: 'Switches that change platform behaviour immediately.',
    keys: [
      { key: 'global_ads_enabled', label: 'Ad serving enabled', hint: 'Turning this off stops all delivery platform-wide', kind: 'bool' },
      { key: 'auto_approve_vendors', label: 'Auto-approve new vendors', hint: 'Skip manual vendor review on signup', kind: 'bool' },
      { key: 'auto_approve_campaigns', label: 'Auto-approve campaigns', hint: 'Submitted campaigns go live without review', kind: 'bool' },
    ],
  },
];

export default function AdminSettings() {
  const { data, isLoading, error, refetch } = useApi<SettingsPayload>('/admin/settings');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const invalidate = useInvalidate();
  const toast = useToast();

  useEffect(() => { if (data) setDraft(data.settings); }, [data]);

  const save = useMutation({
    mutationFn: () => put('/admin/settings', draft),
    onSuccess: () => { invalidate('/admin/'); toast.push('Settings saved — they take effect within 15 seconds'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} retry={() => void refetch()} />;

  const dirty = data && JSON.stringify(draft) !== JSON.stringify(data.settings);
  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <>
      <PageHeader title="Platform settings" subtitle="Live economics and delivery guardrails"
        action={
          <div className="flex items-center gap-2">
            {dirty && <span className="text-xs text-warn">Unsaved changes</span>}
            <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button>
          </div>
        } />

      <div className="grid gap-4 lg:grid-cols-2">
        {GROUPS.map((g) => (
          <Card key={g.title}>
            <CardHeader title={g.title} subtitle={g.hint} />
            <div className="space-y-4">
              {g.keys.map((f) => {
                const raw = draft[f.key] ?? '';
                if (f.kind === 'bool') {
                  return (
                    <div key={f.key} className="flex items-start justify-between gap-4 border-b border-hairline pb-3 last:border-0 last:pb-0">
                      <div>
                        <p className="text-xs font-medium text-ink">{f.label}</p>
                        <p className="text-2xs text-ink-mute">{f.hint}</p>
                      </div>
                      <Toggle checked={raw === 'true'} onChange={(v) => set(f.key, String(v))} />
                    </div>
                  );
                }
                const shown = f.kind === 'money' ? String(Number(raw || 0) / 1e6) : raw;
                return (
                  <Field key={f.key} label={f.label} hint={f.hint}>
                    <Input type="number" step={f.kind === 'money' ? '0.01' : '1'} value={shown}
                      onChange={(e) => set(f.key, f.kind === 'money' ? String(Math.round(Number(e.target.value) * 1e6)) : e.target.value)} />
                  </Field>
                );
              })}
            </div>
          </Card>
        ))}
      </div>

      <Card className="mt-4">
        <CardHeader title="Effective split preview" subtitle="What a $4.00 CPM campaign pays out per 1,000 impressions" />
        <div className="flex flex-wrap gap-6 text-sm">
          {(() => {
            const bps = Number(draft.publisher_share_bps ?? 6000);
            const gross = 4;
            return [
              { label: 'Vendor pays', value: `$${gross.toFixed(2)}` },
              { label: 'End users receive', value: `$${((gross * bps) / 10000).toFixed(2)}` },
              { label: 'Platform keeps', value: `$${(gross - (gross * bps) / 10000).toFixed(2)}` },
              { label: 'Take rate', value: `${(100 - bps / 100).toFixed(1)}%` },
            ].map((x) => (
              <div key={x.label}>
                <p className="text-2xs uppercase tracking-wide text-ink-mute">{x.label}</p>
                <p className="tnum mt-0.5 text-lg font-semibold text-ink">{x.value}</p>
              </div>
            ));
          })()}
        </div>
      </Card>
    </>
  );
}
