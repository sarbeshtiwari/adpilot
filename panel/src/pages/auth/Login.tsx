import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { HOME_FOR, useAuth, type LoginOutcome, type Portal } from '../../lib/auth';
import { Button, Field, Input } from '../../components/ui';
import { GoogleButton } from '../../components/GoogleButton';
import { LoginLayout, Divider } from './LoginLayout';
import { MfaChallenge } from './MfaChallenge';

type Copy = {
  badge: string; title: string; subtitle: string;
  tone: 'brand' | 'admin' | 'earn';
  demo?: { label: string; email: string }[];
  footer?: React.ReactNode;
};

const COPY: Record<Portal, Copy> = {
  USER: {
    badge: 'Earner', title: 'Your earnings', subtitle: 'Sign in to see what your thinking time has paid out.',
    tone: 'earn',
    demo: [{ label: 'Aarav', email: 'aarav@example.com' }, { label: 'Diya', email: 'diya@example.com' }],
  },
  VENDOR: {
    badge: 'Advertiser', title: 'Advertiser panel', subtitle: 'Run campaigns while people wait on their AI.',
    tone: 'brand',
    demo: [{ label: 'Owner', email: 'ads@vectordb.io' }, { label: 'Campaigns only', email: 'analyst@vectordb.io' }],
    footer: (
      <p className="mt-5 text-center text-xs text-ink-mute">
        New here? <Link to="/register/vendor" className="font-medium text-brand hover:underline">Create an advertiser account</Link>
      </p>
    ),
  },
  ADMIN: {
    badge: 'Platform console', title: 'AdPilot console', subtitle: 'Every vendor, every earner, every dollar.',
    tone: 'admin',
    demo: [{ label: 'Owner', email: 'admin@adpilot.io' }, { label: 'Finance only', email: 'finance@adpilot.io' }],
  },
};

export default function Login({ portal }: { portal: Portal }) {
  const { user, config, loginPassword, loginGoogle } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [challengeToken, setChallengeToken] = useState<string | null>(null);

  if (user) return <Navigate to={HOME_FOR[user.role]} replace />;

  const copy = COPY[portal];
  const rules = config?.portals[portal];
  const passwordAllowed = rules?.password ?? true;
  const googleAllowed = rules?.google ?? false;

  function handle(outcome: LoginOutcome) {
    if (outcome.kind === 'mfa') return setChallengeToken(outcome.challengeToken);
    nav(outcome.mfaSetupRequired ? '/security/two-step' : HOME_FOR[outcome.user.role], { replace: true });
  }

  async function run(fn: () => Promise<LoginOutcome>) {
    setBusy(true); setError('');
    try { handle(await fn()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Sign in failed'); }
    finally { setBusy(false); }
  }

  if (challengeToken) {
    return <MfaChallenge portal={portal} challengeToken={challengeToken} onCancel={() => setChallengeToken(null)} />;
  }

  return (
    <LoginLayout badge={copy.badge} title={copy.title} subtitle={copy.subtitle} tone={copy.tone} footer={copy.footer}>
      {googleAllowed && (
        <>
          <GoogleButton onCredential={(credential) => void run(() => loginGoogle(credential, portal))} />
          {passwordAllowed && <Divider />}
        </>
      )}

      {passwordAllowed ? (
        <form onSubmit={(e) => { e.preventDefault(); void run(() => loginPassword(email, password, portal)); }} className="space-y-4">
          <Field label="Email">
            <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </Field>
          <Field label="Password">
            <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </Field>
          {error && <p className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-xs text-bad">{error}</p>}
          <Button type="submit" variant="primary" loading={busy} className="w-full">Sign in</Button>
          <Link to={`/forgot-password?portal=${portal}`} className="block text-center text-xs text-ink-mute hover:text-ink">
            Forgot your password?
          </Link>
        </form>
      ) : (
        <>
          {error && <p className="mt-3 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-xs text-bad">{error}</p>}
          <p className="mt-4 rounded-lg bg-surface px-3 py-2.5 text-center text-xs text-ink-mute">
            Earner accounts sign in with Google only — no password to lose, and your payout details stay tied to a verified address.
          </p>
        </>
      )}

      {portal === 'ADMIN' && (
        <p className="mt-4 rounded-lg border border-hairline px-3 py-2 text-2xs text-ink-mute">
          Console accounts require an authenticator app. You will be asked for a code, or walked through setup on first sign-in.
        </p>
      )}

      {copy.demo && passwordAllowed && (
        <div className="mt-5 border-t border-hairline pt-4">
          <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-mute">Demo accounts · Passw0rd!23</p>
          <div className="flex flex-wrap gap-1.5">
            {copy.demo.map((d) => (
              <button key={d.email} type="button"
                onClick={() => { setEmail(d.email); setPassword('Passw0rd!23'); }}
                className="rounded-md border border-hairline px-2 py-1 text-2xs text-ink-soft hover:bg-surface hover:text-ink">
                {d.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </LoginLayout>
  );
}
