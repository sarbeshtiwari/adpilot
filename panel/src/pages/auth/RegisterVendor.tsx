import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { HOME_FOR, useAuth, type LoginOutcome } from '../../lib/auth';
import { Button, Field, Input, Select, cx } from '../../components/ui';
import { GoogleButton } from '../../components/GoogleButton';
import { Divider } from './LoginLayout';

const INDUSTRIES = ['developer-tools', 'saas', 'ai-ml', 'finance', 'education', 'ecommerce', 'gaming', 'health', 'travel', 'general'];

const STEPS = ['Business', 'Address', 'Account'] as const;

/** Vendor self-onboarding. Ends with a PENDING account awaiting platform review. */
export default function RegisterVendor() {
  const { user, registerVendor } = useAuth();
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [googleCredential, setGoogleCredential] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    companyName: '', legalName: '', taxId: '', website: '', industry: 'general', contactPhone: '', billingEmail: '',
    addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '', country: '',
    name: '', email: '', password: '',
  });

  if (user) return <Navigate to={HOME_FOR[user.role]} replace />;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((prev) => ({ ...prev, [k]: e.target.value }));

  const stepValid = [
    f.companyName.trim().length >= 2,
    true,
    f.name.trim().length >= 2 && (googleCredential ? true : /\S+@\S+\.\S+/.test(f.email) && f.password.length >= 8),
  ];

  async function submit(credential?: string) {
    setBusy(true); setError('');
    try {
      const outcome: LoginOutcome = await registerVendor({
        ...f,
        website: f.website || undefined,
        billingEmail: f.billingEmail || undefined,
        country: f.country ? f.country.toUpperCase().slice(0, 2) : undefined,
        password: credential ?? googleCredential ? undefined : f.password,
        googleCredential: credential ?? googleCredential ?? undefined,
      });
      if (outcome.kind === 'mfa') return nav('/login/vendor', { replace: true });
      nav(HOME_FOR[outcome.user.role], { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the account');
      setStep(2);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-brand text-lg font-bold text-white">A</span>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Advertise on AdPilot</h1>
          <p className="mt-1 text-sm text-ink-mute">Reach people in the seconds their model is thinking.</p>
        </div>

        <ol className="mb-5 flex items-center justify-center gap-2">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <span className={cx('grid h-6 w-6 place-items-center rounded-full text-2xs font-semibold',
                i < step ? 'bg-good text-white' : i === step ? 'bg-brand text-white' : 'bg-surface text-ink-mute border border-hairline')}>
                {i < step ? '✓' : i + 1}
              </span>
              <span className={cx('text-xs', i === step ? 'font-medium text-ink' : 'text-ink-mute')}>{s}</span>
              {i < STEPS.length - 1 && <span className="h-px w-5 bg-hairline" aria-hidden />}
            </li>
          ))}
        </ol>

        <div className="rounded-xl border border-hairline bg-panel p-6 shadow-card">
          {step === 0 && (
            <div className="space-y-4">
              <Field label="Company name"><Input required value={f.companyName} onChange={set('companyName')} placeholder="Acme Inc." /></Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Registered legal name" hint="If different"><Input value={f.legalName} onChange={set('legalName')} /></Field>
                <Field label="Tax ID" hint="GSTIN / VAT / EIN"><Input value={f.taxId} onChange={set('taxId')} /></Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Website"><Input type="url" value={f.website} onChange={set('website')} placeholder="https://acme.com" /></Field>
                <Field label="Industry">
                  <Select value={f.industry} onChange={set('industry')}>
                    {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
                  </Select>
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Contact phone"><Input value={f.contactPhone} onChange={set('contactPhone')} /></Field>
                <Field label="Billing email" hint="Where invoices go"><Input type="email" value={f.billingEmail} onChange={set('billingEmail')} /></Field>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <Field label="Address line 1"><Input value={f.addressLine1} onChange={set('addressLine1')} /></Field>
              <Field label="Address line 2"><Input value={f.addressLine2} onChange={set('addressLine2')} /></Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="City"><Input value={f.city} onChange={set('city')} /></Field>
                <Field label="State / region"><Input value={f.state} onChange={set('state')} /></Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Postal code"><Input value={f.postalCode} onChange={set('postalCode')} /></Field>
                <Field label="Country" hint="Two-letter code"><Input maxLength={2} value={f.country} onChange={set('country')} placeholder="IN" /></Field>
              </div>
              <p className="rounded-lg bg-surface px-3 py-2 text-xs text-ink-mute">
                Billing details are used for invoices and tax records. They are never shown to earners.
              </p>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <GoogleButton text="signup_with" onCredential={(c) => { setGoogleCredential(c); void submit(c); }} />
              <Divider label="or use an email and password" />
              <Field label="Your name"><Input required value={f.name} onChange={set('name')} placeholder="Jane Doe" /></Field>
              <Field label="Work email"><Input type="email" required value={f.email} onChange={set('email')} /></Field>
              <Field label="Password" hint="At least 8 characters">
                <Input type="password" required minLength={8} value={f.password} onChange={set('password')} />
              </Field>
              <p className="rounded-lg bg-surface px-3 py-2 text-xs text-ink-mute">
                Your account is created straight away. Campaigns go live once the platform team reviews your business details.
              </p>
            </div>
          )}

          {error && <p className="mt-4 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-xs text-bad">{error}</p>}

          <div className="mt-5 flex gap-2">
            {step > 0 && <Button onClick={() => setStep((s) => s - 1)} className="flex-1">Back</Button>}
            {step < 2 ? (
              <Button variant="primary" className="flex-1" disabled={!stepValid[step]} onClick={() => setStep((s) => s + 1)}>Continue</Button>
            ) : (
              <Button variant="primary" className="flex-1" loading={busy} disabled={!stepValid[2]} onClick={() => void submit()}>
                Create account
              </Button>
            )}
          </div>
        </div>

        <p className="mt-5 text-center text-xs text-ink-mute">
          Already have an account? <Link to="/login/vendor" className="font-medium text-brand hover:underline">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
