import { Link, Navigate } from 'react-router-dom';
import { HOME_FOR, useAuth } from '../../lib/auth';

const DOORS = [
  {
    to: '/login/user', title: 'Earner', tone: 'bg-good',
    line: 'You run the extension and get paid when ads appear',
    note: 'Sign in with Google',
  },
  {
    to: '/login/vendor', title: 'Advertiser', tone: 'bg-brand',
    line: 'You buy the attention and run the campaigns',
    note: 'Google or email · self-serve signup',
  },
  {
    to: '/login/admin', title: 'Platform console', tone: 'bg-ink',
    line: 'You run AdPilot itself',
    note: 'Two-step verification required',
  },
];

export default function PortalChooser() {
  const { user, loading } = useAuth();
  if (!loading && user) return <Navigate to={HOME_FOR[user.role]} replace />;

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <span className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-brand text-lg font-bold text-white">A</span>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Sign in to AdPilot</h1>
          <p className="mt-1 text-sm text-ink-mute">Three panels, three doors. Pick the one that describes you.</p>
        </div>

        <div className="space-y-3">
          {DOORS.map((d) => (
            <Link key={d.to} to={d.to}
              className="flex items-center gap-4 rounded-xl border border-hairline bg-panel p-4 shadow-card transition hover:border-brand/40 hover:shadow-pop">
              <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${d.tone} text-sm font-bold text-white`}>
                {d.title.slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-ink">{d.title}</span>
                <span className="block text-xs text-ink-soft">{d.line}</span>
                <span className="mt-0.5 block text-2xs text-ink-mute">{d.note}</span>
              </span>
              <span className="text-ink-mute" aria-hidden>→</span>
            </Link>
          ))}
        </div>

        <p className="mt-6 text-center text-xs text-ink-mute">
          Want to advertise with us?{' '}
          <Link to="/register/vendor" className="font-medium text-brand hover:underline">Create an advertiser account</Link>
        </p>
      </div>
    </div>
  );
}
