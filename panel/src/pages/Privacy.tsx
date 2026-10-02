import { useState } from 'react';
import { useApi, useInvalidate, useMutation } from '../lib/useApi';
import { del, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, CardHeader, ErrorNote, Field, Input, Loading, Modal, PageHeader, StatusBadge, Table, Td, Toggle, useToast } from '../components/ui';
import { dateTime } from '../lib/format';

type PrivacyData = {
  consent: { policyVersion: string; scopes: Record<string, boolean>; upToDate: boolean };
  requests: { id: string; type: string; status: string; requestedAt: string; completedAt: string | null; note: string }[];
  policyVersion: string;
};

const SCOPES = [
  { key: 'ADS', label: 'Show me ads and pay me for them', hint: 'Turning this off stops delivery and stops your earnings.' },
  { key: 'LOCATION', label: 'Use my approximate location for targeting', hint: 'City-level only, and advertisers only ever see it aggregated.' },
  { key: 'ANALYTICS', label: 'Use my activity to improve the product', hint: 'Which AI surfaces ads appear on, and how long they are visible.' },
] as const;

export default function Privacy() {
  const { user } = useAuth();
  const { data, isLoading, error, refetch } = useApi<PrivacyData>('/privacy');
  const [erasing, setErasing] = useState(false);
  const invalidate = useInvalidate();
  const toast = useToast();

  const setConsent = useMutation({
    mutationFn: (v: { scope: string; granted: boolean }) => post('/privacy/consent', v),
    onSuccess: () => { invalidate('/privacy'); invalidate('/me/'); toast.push('Preference saved'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => del(`/privacy/erase/${id}`),
    onSuccess: () => { invalidate('/privacy'); toast.push('Request cancelled'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} retry={() => void refetch()} />;
  if (!data) return null;

  const pendingErase = data.requests.find((r) => r.type === 'ERASE' && r.status === 'PENDING');

  return (
    <>
      <PageHeader title="Your data" subtitle="What we hold, what you have agreed to, and how to take it back" />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Permissions" subtitle={`Policy version ${data.policyVersion}`}
            action={data.consent.upToDate ? <Badge tone="good">up to date</Badge> : <Badge tone="warn">review needed</Badge>} />
          <div className="space-y-4">
            {SCOPES.map((s) => (
              <div key={s.key} className="flex items-start justify-between gap-4 border-b border-hairline pb-3 last:border-0 last:pb-0">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-ink">{s.label}</p>
                  <p className="text-2xs text-ink-mute">{s.hint}</p>
                </div>
                <Toggle
                  checked={data.consent.scopes[s.key] ?? false}
                  onChange={(granted) => setConsent.mutate({ scope: s.key, granted })}
                />
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Take your data with you" subtitle="Everything we hold about you, as a file" />
          <div className="space-y-3">
            <p className="text-xs text-ink-soft">
              Your account, every ad you were shown, where and on which AI surface, what each one paid you,
              and your full earnings ledger.
            </p>
            <a href="/api/privacy/export" download
              className="inline-flex rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface">
              Download my data (JSON)
            </a>
          </div>

          <div className="mt-6 border-t border-hairline pt-4">
            <p className="mb-1 text-xs font-semibold text-ink">Delete my account</p>
            <p className="mb-3 text-2xs text-ink-mute">
              Your identity and devices are removed. Financial records stay in anonymised form,
              because we are required to keep them.
            </p>
            {pendingErase ? (
              <div className="flex items-center gap-2">
                <Badge tone="warn">deletion requested {dateTime(pendingErase.requestedAt)}</Badge>
                <Button size="sm" variant="ghost" onClick={() => cancel.mutate(pendingErase.id)}>Cancel</Button>
              </div>
            ) : (
              <Button size="sm" variant="danger" onClick={() => setErasing(true)}>Request deletion</Button>
            )}
          </div>
        </Card>

        {data.requests.length > 0 && (
          <Card pad={false} className="lg:col-span-2">
            <div className="p-5 pb-0"><CardHeader title="Request history" /></div>
            <Table head={['Requested', 'Type', 'Status', 'Completed', 'Note']}>
              {data.requests.map((r) => (
                <tr key={r.id}>
                  <Td className="text-xs">{dateTime(r.requestedAt)}</Td>
                  <Td><Badge>{r.type.toLowerCase()}</Badge></Td>
                  <Td><StatusBadge status={r.status} /></Td>
                  <Td className="text-xs">{r.completedAt ? dateTime(r.completedAt) : '—'}</Td>
                  <Td className="max-w-[18rem] truncate text-xs" title={r.note}>{r.note || '—'}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}
      </div>

      <EraseModal open={erasing} onClose={() => setErasing(false)} email={user?.email ?? ''} />
    </>
  );
}

function EraseModal({ open, onClose, email }: { open: boolean; onClose: () => void; email: string }) {
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [blockers, setBlockers] = useState<string[]>([]);
  const invalidate = useInvalidate();
  const toast = useToast();

  const request = useMutation({
    mutationFn: () => post<{ blockers: string[] }>('/privacy/erase', { reason }),
    onSuccess: (res) => {
      setBlockers(res.blockers);
      invalidate('/privacy');
      toast.push(res.blockers.length ? 'Request logged — settle the items below first' : 'Deletion requested');
      if (!res.blockers.length) onClose();
    },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  return (
    <Modal open={open} onClose={onClose} title="Request account deletion"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" loading={request.isPending} disabled={confirm !== 'DELETE'} onClick={() => request.mutate()}>
          Request deletion
        </Button></>}>
      <div className="space-y-4">
        <p className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
          This removes your name, email, devices and location from AdPilot and signs you out everywhere.
          Ad delivery records stay, detached from you, because they are an advertiser's billing record.
        </p>
        {blockers.length > 0 && (
          <ul className="space-y-1 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-xs text-bad">
            {blockers.map((b) => <li key={b}>• {b}</li>)}
          </ul>
        )}
        <Field label="Why are you leaving?" hint="Optional, but it helps us">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label={`Type DELETE to confirm`} hint={`This affects ${email}`}>
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value.toUpperCase())} placeholder="DELETE" />
        </Field>
      </div>
    </Modal>
  );
}
