import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { get } from '../../lib/api';
import { HOME_FOR, useAuth } from '../../lib/auth';
import { post } from '../../lib/api';
import { Button, Field, Input, Loading } from '../../components/ui';
import { LoginLayout } from './LoginLayout';

/** Landing page for the link a team invite emails out. */
export default function AcceptInvite() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const token = params.get('token') ?? '';
  const [invite, setInvite] = useState<{ email: string; name: string; organisation: string } | null>(null);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) { setError('This invitation is missing its token.'); setChecking(false); return; }
    get<{ email: string; name: string; organisation: string }>(`/auth/accept-invite?token=${encodeURIComponent(token)}`)
      .then(setInvite)
      .catch((e) => setError(e instanceof Error ? e.message : 'This invitation is no longer valid'))
      .finally(() => setChecking(false));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await post<{ user?: { role: keyof typeof HOME_FOR }; mfaSetupRequired?: boolean }>('/auth/accept-invite', { token, password });
      await refresh();
      nav(res.mfaSetupRequired ? '/security/two-step' : res.user ? HOME_FOR[res.user.role] : '/login', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not accept the invitation');
    } finally {
      setBusy(false);
    }
  }

  if (checking) return <Loading label="Checking your invitation" />;

  return (
    <LoginLayout badge="Invitation" title={invite ? `Join ${invite.organisation}` : 'Invitation not valid'}
      subtitle={invite ? `Set a password for ${invite.email}` : 'It may have expired or already been used.'}>
      {invite ? (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Choose a password" hint="At least 8 characters">
            <Input type="password" required minLength={8} autoFocus autoComplete="new-password"
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <p className="rounded-lg bg-surface px-3 py-2 text-xs text-ink-mute">
            Console accounts also need an authenticator app — you will be walked through it next.
          </p>
          {error && <p className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-xs text-bad">{error}</p>}
          <Button type="submit" variant="primary" loading={busy} disabled={password.length < 8} className="w-full">
            Accept and sign in
          </Button>
        </form>
      ) : (
        <div className="space-y-3">
          <p className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-xs text-bad">{error}</p>
          <p className="text-xs text-ink-mute">Ask whoever invited you to send a new one.</p>
          <Link to="/login" className="block text-center text-xs font-medium text-brand hover:underline">Back to sign in</Link>
        </div>
      )}
    </LoginLayout>
  );
}
