import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { post } from '../../lib/api';
import { Button, Field, Input } from '../../components/ui';
import { LoginLayout } from './LoginLayout';
import type { Portal } from '../../lib/auth';

export default function ForgotPassword() {
  const [params] = useSearchParams();
  const portal = (params.get('portal') as Portal | null) ?? undefined;
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await post('/auth/forgot-password', { email, portal });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the reset link');
    } finally {
      setBusy(false);
    }
  }

  return (
    <LoginLayout badge="Password" title="Reset your password"
      subtitle={sent ? 'Check your inbox.' : 'We will email you a link to choose a new one.'}>
      {sent ? (
        <div className="space-y-4">
          {/* Deliberately not "we found your account" — that would confirm the
              address exists to anyone who guesses it. */}
          <p className="rounded-lg bg-surface px-3 py-2.5 text-xs text-ink-soft">
            If <span className="font-medium text-ink">{email}</span> has an account, a reset link is on its way.
            It works once and expires in an hour.
          </p>
          <p className="text-xs text-ink-mute">
            Nothing arrived? Check spam, or try again in a few minutes. Accounts that only sign in with
            Google have no password to reset.
          </p>
          <Link to="/login" className="block text-center text-xs font-medium text-brand hover:underline">Back to sign in</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email">
            <Input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </Field>
          {error && <p className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-xs text-bad">{error}</p>}
          <Button type="submit" variant="primary" loading={busy} className="w-full">Send reset link</Button>
          <Link to="/login" className="block text-center text-xs text-ink-mute hover:text-ink">Back to sign in</Link>
        </form>
      )}
    </LoginLayout>
  );
}
