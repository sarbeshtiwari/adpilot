import { useState } from 'react';
import { useMutation } from '../../lib/useApi';
import { post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, Card, CardHeader, Field, Input, PageHeader, StatusBadge, useToast } from '../../components/ui';
import { dateTime, usd } from '../../lib/format';

export default function VendorSettings() {
  const { user } = useAuth();
  const toast = useToast();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });

  const change = useMutation({
    mutationFn: () => post('/auth/change-password', { currentPassword: pw.currentPassword, newPassword: pw.newPassword }),
    onSuccess: () => { toast.push('Password updated'); setPw({ currentPassword: '', newPassword: '', confirm: '' }); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  const mismatch = pw.newPassword !== '' && pw.newPassword !== pw.confirm;

  return (
    <>
      <PageHeader title="Account settings" subtitle="Your company profile and sign-in security" />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Company" subtitle="Contact the platform team to change these details" />
          <dl className="space-y-3 text-sm">
            {[
              ['Company', user?.vendor?.companyName ?? '—'],
              ['Account owner', user?.name ?? '—'],
              ['Email', user?.email ?? '—'],
              ['Wallet balance', usd(user?.vendor?.balanceMicros ?? 0)],
              ['Member since', dateTime(user?.createdAt)],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-4 border-b border-hairline pb-2 last:border-0">
                <dt className="text-ink-mute">{k}</dt><dd className="text-right font-medium text-ink">{v}</dd>
              </div>
            ))}
            <div className="flex items-center justify-between gap-4">
              <dt className="text-ink-mute">Status</dt>
              <dd><StatusBadge status={user?.vendor?.status ?? 'PENDING'} /></dd>
            </div>
          </dl>
        </Card>

        <Card>
          <CardHeader title="Change password" subtitle="At least 8 characters" />
          <div className="space-y-4">
            <Field label="Current password">
              <Input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
            </Field>
            <Field label="New password">
              <Input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
            </Field>
            <Field label="Confirm new password" error={mismatch ? 'Passwords do not match' : undefined}>
              <Input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
            </Field>
            <Button variant="primary" loading={change.isPending}
              disabled={!pw.currentPassword || pw.newPassword.length < 8 || mismatch}
              onClick={() => change.mutate()}>Update password</Button>
          </div>
        </Card>
      </div>
    </>
  );
}
