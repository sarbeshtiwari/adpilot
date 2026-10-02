import { useState } from 'react';
import { Button, Field, Input, Select, Toggle, cx } from './ui';
import type { Campaign, GeoRule } from '../lib/types';

export const CATEGORIES = ['general', 'developer-tools', 'saas', 'ai-ml', 'finance', 'education', 'ecommerce', 'gaming', 'health', 'travel'];

export type CampaignDraft = {
  name: string; category: string; pricingModel: 'CPM' | 'CPC' | 'CPM_CPC';
  cpmUsd: number; cpcUsd: number; totalBudgetUsd: number; dailyBudgetUsd: number;
  startAt: string; endAt: string;
  dayparting: { tz: string; hours?: number[]; days?: number[] } | null;
  frequencyCapPerDay: number; priority: number; geoRules: GeoRule[];
};

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function emptyDraft(): CampaignDraft {
  const now = new Date();
  return {
    name: '', category: 'general', pricingModel: 'CPM_CPC',
    cpmUsd: 2.5, cpcUsd: 0.4, totalBudgetUsd: 250, dailyBudgetUsd: 25,
    startAt: toLocalInput(now),
    endAt: toLocalInput(new Date(now.getTime() + 30 * 86_400_000)),
    dayparting: null, frequencyCapPerDay: 5, priority: 5,
    geoRules: [{ mode: 'INCLUDE', country: 'IN', state: '*', city: '*', area: '*' }],
  };
}

export function toDraft(c: Campaign): CampaignDraft {
  let dp: CampaignDraft['dayparting'] = null;
  try { dp = c.dayparting ? JSON.parse(c.dayparting) : null; } catch { dp = null; }
  return {
    name: c.name, category: c.category, pricingModel: c.pricingModel,
    cpmUsd: Number(c.cpmMicros) / 1e6, cpcUsd: Number(c.cpcMicros) / 1e6,
    totalBudgetUsd: Number(c.totalBudgetMicros) / 1e6, dailyBudgetUsd: Number(c.dailyBudgetMicros) / 1e6,
    startAt: toLocalInput(new Date(c.startAt)), endAt: toLocalInput(new Date(c.endAt)),
    dayparting: dp, frequencyCapPerDay: c.frequencyCapPerDay, priority: c.priority,
    geoRules: c.geoRules.map((g) => ({ mode: g.mode, country: g.country, state: g.state, city: g.city, area: g.area })),
  };
}

/** Converts the draft into the payload the API expects. */
export function toPayload(d: CampaignDraft) {
  return {
    ...d,
    startAt: new Date(d.startAt).toISOString(),
    endAt: new Date(d.endAt).toISOString(),
    geoRules: d.geoRules.map((g) => ({
      mode: g.mode,
      country: g.country.trim() || '*',
      state: g.state.trim() || '*',
      city: g.city.trim() || '*',
      area: g.area.trim() || '*',
    })),
  };
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function CampaignForm({ draft, onChange }: { draft: CampaignDraft; onChange: (d: CampaignDraft) => void }) {
  const set = <K extends keyof CampaignDraft>(k: K, v: CampaignDraft[K]) => onChange({ ...draft, [k]: v });
  const [showSchedule, setShowSchedule] = useState(draft.dayparting !== null);

  const setRule = (i: number, patch: Partial<GeoRule>) =>
    set('geoRules', draft.geoRules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const estImpressions = draft.cpmUsd > 0 ? Math.round((draft.totalBudgetUsd / draft.cpmUsd) * 1000) : 0;
  const estClicks = draft.cpcUsd > 0 ? Math.round(draft.totalBudgetUsd / draft.cpcUsd) : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Campaign name">
          <Input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Q4 developer push" />
        </Field>
        <Field label="Category" hint="End users can block whole categories">
          <Select value={draft.category} onChange={(e) => set('category', e.target.value)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
      </div>

      {/* ---------------------------------------------------------- pricing */}
      <section>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-mute">Bidding</h4>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Pricing model" hint="What you pay for">
            <Select value={draft.pricingModel} onChange={(e) => set('pricingModel', e.target.value as CampaignDraft['pricingModel'])}>
              <option value="CPM_CPC">Impressions + clicks</option>
              <option value="CPM">Impressions only (CPM)</option>
              <option value="CPC">Clicks only (CPC)</option>
            </Select>
          </Field>
          <Field label="CPM bid (USD)" hint="Per 1,000 views">
            <Input type="number" step="0.01" min="0" disabled={draft.pricingModel === 'CPC'}
              value={draft.cpmUsd} onChange={(e) => set('cpmUsd', Number(e.target.value))} />
          </Field>
          <Field label="CPC bid (USD)" hint="Per click">
            <Input type="number" step="0.01" min="0" disabled={draft.pricingModel === 'CPM'}
              value={draft.cpcUsd} onChange={(e) => set('cpcUsd', Number(e.target.value))} />
          </Field>
        </div>
      </section>

      {/* ---------------------------------------------------------- budget */}
      <section>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-mute">Budget &amp; flight</h4>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Total budget (USD)" hint="Campaign completes when this is spent">
            <Input type="number" step="1" min="1" value={draft.totalBudgetUsd} onChange={(e) => set('totalBudgetUsd', Number(e.target.value))} />
          </Field>
          <Field label="Daily cap (USD)" hint="0 means no daily limit">
            <Input type="number" step="1" min="0" value={draft.dailyBudgetUsd} onChange={(e) => set('dailyBudgetUsd', Number(e.target.value))} />
          </Field>
          <Field label="Starts"><Input type="datetime-local" value={draft.startAt} onChange={(e) => set('startAt', e.target.value)} /></Field>
          <Field label="Ends"><Input type="datetime-local" value={draft.endAt} onChange={(e) => set('endAt', e.target.value)} /></Field>
        </div>
        <p className="mt-2 rounded-lg bg-surface px-3 py-2 text-xs text-ink-mute">
          At these bids the budget buys roughly{' '}
          <span className="tnum font-semibold text-ink">{estImpressions.toLocaleString()}</span> impressions
          {draft.pricingModel !== 'CPM' && <> or <span className="tnum font-semibold text-ink">{estClicks.toLocaleString()}</span> clicks</>}.
        </p>
      </section>

      {/* ---------------------------------------------------------- geo */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-mute">Geo targeting</h4>
          <Button size="sm" onClick={() => set('geoRules', [...draft.geoRules, { mode: 'INCLUDE', country: '*', state: '*', city: '*', area: '*' }])}>
            Add rule
          </Button>
        </div>
        <p className="mb-3 text-xs text-ink-mute">
          Use <code className="rounded bg-surface px-1">*</code> to match anything at that level. Exclusions always win over inclusions,
          and a more specific rule (city, area) outbids a broad one in the auction.
        </p>
        <div className="space-y-2">
          {draft.geoRules.map((r, i) => (
            <div key={i} className={cx('grid grid-cols-2 gap-2 rounded-lg border p-2 sm:grid-cols-6',
              r.mode === 'EXCLUDE' ? 'border-bad/30 bg-bad/5' : 'border-hairline')}>
              <Select value={r.mode} onChange={(e) => setRule(i, { mode: e.target.value as GeoRule['mode'] })} className="sm:col-span-1">
                <option value="INCLUDE">Include</option>
                <option value="EXCLUDE">Exclude</option>
              </Select>
              <Input value={r.country} onChange={(e) => setRule(i, { country: e.target.value.toUpperCase() })} placeholder="Country (IN)" maxLength={2} />
              <Input value={r.state} onChange={(e) => setRule(i, { state: e.target.value })} placeholder="State" />
              <Input value={r.city} onChange={(e) => setRule(i, { city: e.target.value })} placeholder="City" />
              <Input value={r.area} onChange={(e) => setRule(i, { area: e.target.value })} placeholder="Area" />
              <Button size="sm" variant="ghost" onClick={() => set('geoRules', draft.geoRules.filter((_, idx) => idx !== i))}>Remove</Button>
            </div>
          ))}
          {draft.geoRules.length === 0 && (
            <p className="rounded-lg border border-dashed border-hairline px-3 py-4 text-center text-xs text-ink-mute">
              No rules — this campaign will run worldwide.
            </p>
          )}
        </div>
      </section>

      {/* ---------------------------------------------------------- pacing */}
      <section>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-mute">Pacing</h4>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Frequency cap" hint="Max times one person sees this campaign per day (0 = unlimited)">
            <Input type="number" min="0" max="100" value={draft.frequencyCapPerDay} onChange={(e) => set('frequencyCapPerDay', Number(e.target.value))} />
          </Field>
          <Field label="Priority" hint="1–10. Breaks ties against competing campaigns">
            <Input type="number" min="1" max="10" value={draft.priority} onChange={(e) => set('priority', Number(e.target.value))} />
          </Field>
        </div>

        <div className="mt-4 rounded-lg border border-hairline p-3">
          <Toggle checked={showSchedule} label="Restrict to certain hours and days"
            onChange={(v) => {
              setShowSchedule(v);
              set('dayparting', v ? { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, hours: [], days: [] } : null);
            }} />
          {showSchedule && draft.dayparting && (
            <div className="mt-3 space-y-3">
              <Field label="Timezone">
                <Input value={draft.dayparting.tz} onChange={(e) => set('dayparting', { ...draft.dayparting!, tz: e.target.value })} />
              </Field>
              <div>
                <p className="mb-1.5 text-xs font-medium text-ink-soft">Days (none selected = every day)</p>
                <div className="flex flex-wrap gap-1">
                  {DAYS.map((d, i) => {
                    const on = draft.dayparting!.days?.includes(i);
                    return (
                      <button key={d} type="button"
                        onClick={() => {
                          const cur = draft.dayparting!.days ?? [];
                          set('dayparting', { ...draft.dayparting!, days: on ? cur.filter((x) => x !== i) : [...cur, i] });
                        }}
                        className={cx('rounded-md border px-2 py-1 text-xs',
                          on ? 'border-brand bg-brand text-white' : 'border-hairline text-ink-soft hover:bg-surface')}>
                        {d}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium text-ink-soft">Hours (none selected = all day)</p>
                <div className="flex flex-wrap gap-1">
                  {Array.from({ length: 24 }, (_, h) => {
                    const on = draft.dayparting!.hours?.includes(h);
                    return (
                      <button key={h} type="button"
                        onClick={() => {
                          const cur = draft.dayparting!.hours ?? [];
                          set('dayparting', { ...draft.dayparting!, hours: on ? cur.filter((x) => x !== h) : [...cur, h] });
                        }}
                        className={cx('tnum w-8 rounded-md border py-1 text-2xs',
                          on ? 'border-brand bg-brand text-white' : 'border-hairline text-ink-soft hover:bg-surface')}>
                        {String(h).padStart(2, '0')}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
