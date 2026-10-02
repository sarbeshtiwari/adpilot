import { useEffect, useState } from 'react';
import { useApi, useInvalidate, useMutation } from '../../lib/useApi';
import { patch, post } from '../../lib/api';
import { Button, Card, CardHeader, ErrorNote, Field, Input, Loading, PageHeader, Select, Toggle, cx, useToast } from '../../components/ui';
import type { Publisher } from '../../lib/types';

const CATEGORIES = ['general', 'developer-tools', 'saas', 'ai-ml', 'finance', 'education', 'ecommerce', 'gaming', 'health', 'travel'];

type Pacing = { maxAdsPerHour: number; minSecondsBetweenAds: number; isOverride: boolean };
type Overview = { publisher: Publisher; revenueSharePct: number; pacing: Pacing };

export default function UserSettings() {
  const { data, isLoading, error, refetch } = useApi<Overview>('/me/overview?days=1');
  const invalidate = useInvalidate();
  const toast = useToast();

  const [prefs, setPrefs] = useState({
    displayName: '', adsEnabled: true, blockedCategories: [] as string[],
  });
  const [payout, setPayout] = useState({ payoutMethod: 'PAYPAL', detail1: '', detail2: '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });

  useEffect(() => {
    if (!data) return;
    const p = data.publisher;
    setPrefs({
      displayName: p.displayName, adsEnabled: p.adsEnabled,
      blockedCategories: p.blockedCategories ? p.blockedCategories.split(',').filter(Boolean) : [],
    });
    let details: Record<string, string> = {};
    try { details = p.payoutDetails ? JSON.parse(p.payoutDetails) : {}; } catch { details = {}; }
    const vals = Object.values(details);
    setPayout({ payoutMethod: p.payoutMethod ?? 'PAYPAL', detail1: vals[0] ?? '', detail2: vals[1] ?? '' });
  }, [data]);

  const savePrefs = useMutation({
    mutationFn: () => patch('/me/settings', prefs),
    onSuccess: () => { invalidate('/me/'); toast.push('Preferences saved'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  const savePayout = useMutation({
    mutationFn: () => patch('/me/settings', {
      payoutMethod: payout.payoutMethod,
      payoutDetails: payout.payoutMethod === 'BANK'
        ? { accountNumber: payout.detail1, ifscOrSwift: payout.detail2 }
        : payout.payoutMethod === 'UPI' ? { upiId: payout.detail1 }
        : payout.payoutMethod === 'CRYPTO' ? { walletAddress: payout.detail1, network: payout.detail2 }
        : { paypalEmail: payout.detail1 },
    }),
    onSuccess: () => { invalidate('/me/'); toast.push('Payout method saved'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  const changePw = useMutation({
    mutationFn: () => post('/auth/change-password', pw),
    onSuccess: () => { toast.push('Password updated'); setPw({ currentPassword: '', newPassword: '' }); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} retry={() => void refetch()} />;

  const pacing = data?.pacing;
  const labels: Record<string, [string, string?]> = {
    PAYPAL: ['PayPal email'], UPI: ['UPI ID'],
    BANK: ['Account number', 'IFSC / SWIFT'], CRYPTO: ['Wallet address', 'Network'],
  };
  const [l1, l2] = labels[payout.payoutMethod] ?? ['Details'];

  return (
    <>
      <PageHeader title="Ad preferences" subtitle="Switch ads off any time, and block the categories you would rather not see" />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Delivery" subtitle="Switch ads off any time — that also switches off your earnings" />
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-ink">Show ads while models think</p>
                <p className="text-2xs text-ink-mute">Turning this off stops all ads and all earnings.</p>
              </div>
              <Toggle checked={prefs.adsEnabled} onChange={(v) => setPrefs({ ...prefs, adsEnabled: v })} />
            </div>
            <div className="rounded-lg border border-hairline bg-surface px-3 py-2.5">
              <p className="mb-2 text-xs font-medium text-ink">Delivery limits</p>
              <dl className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-mute">Maximum ads per hour</dt>
                  <dd className="tnum font-semibold text-ink">{pacing?.maxAdsPerHour ?? '—'}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-mute">Minimum gap between ads</dt>
                  <dd className="tnum font-semibold text-ink">{pacing ? `${pacing.minSecondsBetweenAds}s` : '—'}</dd>
                </div>
              </dl>
              <p className="mt-2 text-2xs text-ink-mute">
                Set by AdPilot for every account{pacing?.isOverride ? ', with an adjustment applied to yours' : ''}.
                You can always switch ads off above.
              </p>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-ink-soft">Block these categories</p>
              <div className="flex flex-wrap gap-1.5">
                {CATEGORIES.map((c) => {
                  const blocked = prefs.blockedCategories.includes(c);
                  return (
                    <button key={c} type="button"
                      onClick={() => setPrefs({
                        ...prefs,
                        blockedCategories: blocked ? prefs.blockedCategories.filter((x) => x !== c) : [...prefs.blockedCategories, c],
                      })}
                      className={cx('rounded-md border px-2 py-1 text-2xs font-medium transition',
                        blocked ? 'border-bad/40 bg-bad/10 text-bad line-through' : 'border-hairline text-ink-soft hover:bg-surface')}>
                      {c}
                    </button>
                  );
                })}
              </div>
            </div>
            <Field label="Display name"><Input value={prefs.displayName} onChange={(e) => setPrefs({ ...prefs, displayName: e.target.value })} /></Field>
            <Button variant="primary" loading={savePrefs.isPending} onClick={() => savePrefs.mutate()}>Save preferences</Button>
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Payout method" subtitle="Where withdrawals are sent. Only you and the platform can see this." />
            <div className="space-y-4">
              <Field label="Method">
                <Select value={payout.payoutMethod} onChange={(e) => setPayout({ ...payout, payoutMethod: e.target.value })}>
                  <option value="PAYPAL">PayPal</option>
                  <option value="UPI">UPI</option>
                  <option value="BANK">Bank transfer</option>
                  <option value="CRYPTO">Crypto wallet</option>
                </Select>
              </Field>
              <Field label={l1}><Input value={payout.detail1} onChange={(e) => setPayout({ ...payout, detail1: e.target.value })} /></Field>
              {l2 && <Field label={l2}><Input value={payout.detail2} onChange={(e) => setPayout({ ...payout, detail2: e.target.value })} /></Field>}
              <Button variant="primary" loading={savePayout.isPending} disabled={!payout.detail1} onClick={() => savePayout.mutate()}>Save payout method</Button>
            </div>
          </Card>

          <Card>
            <CardHeader title="Password" />
            <div className="space-y-4">
              <Field label="Current password">
                <Input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
              </Field>
              <Field label="New password" hint="At least 8 characters">
                <Input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
              </Field>
              <Button variant="primary" loading={changePw.isPending}
                disabled={!pw.currentPassword || pw.newPassword.length < 8} onClick={() => changePw.mutate()}>Update password</Button>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
