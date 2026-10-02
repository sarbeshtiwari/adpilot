import { useState } from 'react';
import { useApi, useInvalidate, useMutation } from '../lib/useApi';
import { del, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, CardHeader, ErrorNote, Field, Input, Loading, Modal, PageHeader, Table, Td, useToast } from '../components/ui';
import { dateTime, relative } from '../lib/format';

type SessionRow = { id: string; userAgent: string; createdAt: string; lastSeenAt: string; expiresAt: string; current: boolean };

/** Where anyone, in any panel, manages their own login security. */
export default function Security() {
  const { user, refresh } = useAuth();
  const { data, isLoading, error, refetch } = useApi<{ sessions: SessionRow[] }>('/auth/sessions');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [disabling, setDisabling] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const invalidate = useInvalidate();
  const toast = useToast();

  const changePw = useMutation({
    mutationFn: () => post('/auth/change-password', {
      currentPassword: pw.currentPassword || undefined,
      newPassword: pw.newPassword,
    }),
    onSuccess: () => {
      toast.push('Password updated — other sessions were signed out');
      setPw({ currentPassword: '', newPassword: '', confirm: '' });
      invalidate('/auth/');
    },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => del(`/auth/sessions/${id}`),
    onSuccess: () => { invalidate('/auth/'); toast.push('Session signed out'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  const revokeOthers = useMutation({
    mutationFn: () => post('/auth/sessions/revoke-others'),
    onSuccess: () => { invalidate('/auth/'); toast.push('Signed out everywhere else'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} retry={() => void refetch()} />;
  if (!user) return null;

  const mismatch = pw.newPassword !== '' && pw.newPassword !== pw.confirm;
  const mandatory2fa = user.role === 'SUPER_ADMIN';

  return (
    <>
      <PageHeader title="Security" subtitle="Your password, your second factor and everywhere you are signed in" />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Two-step verification"
            subtitle={mandatory2fa ? 'Mandatory for console accounts' : 'Strongly recommended'}
            action={user.totpEnabled ? <Badge tone="good">on</Badge> : <Badge tone="warn">off</Badge>}
          />
          {user.totpEnabled ? (
            <div className="space-y-3">
              <p className="text-xs text-ink-soft">
                An authenticator app is protecting this account. Keep your recovery codes somewhere safe —
                they are the way back in if you lose your phone.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setRegenerating(true)}>Generate new recovery codes</Button>
                {!mandatory2fa && <Button size="sm" variant="ghost" onClick={() => setDisabling(true)}>Turn off</Button>}
              </div>
              {mandatory2fa && <p className="text-2xs text-ink-mute">Console accounts cannot switch this off.</p>}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-ink-soft">
                Add a code from an authenticator app on top of your password. It takes about a minute to set up.
              </p>
              <a href="/security/two-step"
                className="inline-flex rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:brightness-110">
                Set up two-step verification
              </a>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Password" subtitle={user.hasPassword ? 'At least 8 characters' : 'Add a password as a backup to Google sign-in'} />
          <div className="space-y-4">
            {user.hasPassword && (
              <Field label="Current password">
                <Input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
              </Field>
            )}
            <Field label="New password"><Input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
            <Field label="Confirm new password" error={mismatch ? 'Passwords do not match' : undefined}>
              <Input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
            </Field>
            <Button variant="primary" loading={changePw.isPending}
              disabled={pw.newPassword.length < 8 || mismatch || (user.hasPassword && !pw.currentPassword)}
              onClick={() => changePw.mutate()}>
              {user.hasPassword ? 'Update password' : 'Set password'}
            </Button>
          </div>
        </Card>

        <Card pad={false} className="lg:col-span-2">
          <div className="p-5 pb-0">
            <CardHeader title="Active sessions" subtitle="Every browser currently signed in as you"
              action={<Button size="sm" loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>Sign out everywhere else</Button>} />
          </div>
          <Table head={['Device', 'Signed in', 'Last seen', 'Expires', '']} empty={!data?.sessions.length}>
            {data?.sessions.map((s) => (
              <tr key={s.id} className="hover:bg-surface/60">
                <Td className="max-w-[24rem] truncate text-xs text-ink" title={s.userAgent}>
                  {s.userAgent || 'Unknown device'}
                  {s.current && <Badge tone="good">this device</Badge>}
                </Td>
                <Td className="text-xs">{dateTime(s.createdAt)}</Td>
                <Td className="text-xs">{relative(s.lastSeenAt)}</Td>
                <Td className="text-xs">{dateTime(s.expiresAt)}</Td>
                <Td>
                  <div className="flex justify-end">
                    {!s.current && <Button size="sm" variant="ghost" onClick={() => revoke.mutate(s.id)}>Sign out</Button>}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <CodeModal open={disabling} onClose={() => setDisabling(false)} title="Turn off two-step verification"
        confirmLabel="Turn off" danger
        note="Your account will only be protected by its password afterwards."
        onSubmit={async (code) => { await post('/auth/mfa/disable', { code }); await refresh(); toast.push('Two-step verification turned off'); }} />

      <CodeModal open={regenerating} onClose={() => setRegenerating(false)} title="Generate new recovery codes"
        confirmLabel="Generate" note="Your existing codes stop working immediately." showCodes />
    </>
  );
}

/** Confirms a sensitive change with a live authenticator code. */
function CodeModal({ open, onClose, title, note, confirmLabel, danger, showCodes, onSubmit }: {
  open: boolean; onClose: () => void; title: string; note: string; confirmLabel: string;
  danger?: boolean; showCodes?: boolean;
  onSubmit?: (code: string) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function close() { setCode(''); setCodes(null); setError(''); onClose(); }

  async function submit() {
    setBusy(true); setError('');
    try {
      if (showCodes) {
        const res = await post<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { code });
        setCodes(res.recoveryCodes);
      } else {
        await onSubmit!(code);
        close();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={close} title={title}
      footer={codes
        ? <Button variant="primary" onClick={close}>Done</Button>
        : <><Button onClick={close}>Cancel</Button>
            <Button variant={danger ? 'danger' : 'primary'} loading={busy} disabled={code.length !== 6} onClick={submit}>{confirmLabel}</Button></>}>
      {codes ? (
        <>
          <p className="mb-3 text-xs text-ink-soft">Save these somewhere safe. Each one works once.</p>
          <ul className="tnum grid grid-cols-2 gap-2 rounded-lg border border-hairline bg-surface p-3 font-mono text-sm">
            {codes.map((c) => <li key={c} className="text-center text-ink">{c}</li>)}
          </ul>
        </>
      ) : (
        <div className="space-y-4">
          <p className="rounded-lg bg-surface px-3 py-2 text-xs text-ink-mute">{note}</p>
          <Field label="Code from your authenticator app">
            <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000" inputMode="numeric" className="tnum text-center text-lg tracking-[0.35em]" />
          </Field>
          {error && <p className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-xs text-bad">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
