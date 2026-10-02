import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { get, post } from '../../lib/api';
import { LOGIN_FOR, type Portal } from '../../lib/auth';
import { Button, Field, Input, Loading } from '../../components/ui';
import { LoginLayout } from './LoginLayout';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') ?? '';
  const [account, setAccount] = useState<{ email: string; name: string } | null>(null);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) { setError('This link is missing its token.'); setChecking(false); return; }
    get<{ email: string; name: string }>(`/auth/reset-password?token=${encodeURIComponent(token)}`)
      .then(setAccount)
      .catch((e) => setError(e instanceof Error ? e.message : 'This link is no longer valid'))
      .finally(() => setChecking(false));
  }, [token]);

  const mismatch = confirm !== '' && password !== confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await post<{ portal: Portal }>('/auth/reset-password', { token, newPassword: password });
      nav(`${LOGIN_FOR[res.portal]}?reset=1`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset the password');
    } finally {
      setBusy(false);
    }
  }

  if (checking) return <Loading label="Checking your link" />;

  return (
    <LoginLayout badge="Password" title="Choose a new password"
      subtitle={account ? `For ${account.email}` : 'This link is no longer valid'}>
      {account ? (
        <form onSubmit={submit} className="space-y-4">
          <Field label="New password" hint="At least 8 characters">
            <Input type="password" required minLength={8} autoFocus autoComplete="new-password"
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Confirm password" error={mismatch ? 'Passwords do not match' : undefined}>
            <Input type="password" required autoComplete="new-password"
              value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <p className="rounded-lg bg-surface px-3 py-2 text-xs text-ink-mute">
            Setting a new password signs you out of every other device.
          </p>
          {error && <p className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-xs text-bad">{error}</p>}
          <Button type="submit" variant="primary" loading={busy} disabled={password.length < 8 || mismatch} className="w-full">
            Set new password
          </Button>
        </form>
      ) : (
        <div className="space-y-4">
          <p className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-xs text-bad">{error}</p>
          <Link to="/forgot-password" className="block text-center text-xs font-medium text-brand hover:underline">
            Request a new link
          </Link>
        </div>
      )}
    </LoginLayout>
  );
}
