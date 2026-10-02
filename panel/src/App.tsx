import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { HOME_FOR, useAuth, type Role } from './lib/auth';
import { Shell } from './components/Layout';
import { Card, Loading, PageHeader } from './components/ui';

import PortalChooser from './pages/auth/PortalChooser';
import Login from './pages/auth/Login';
import TwoStepSetup from './pages/auth/TwoStepSetup';
import RegisterVendor from './pages/auth/RegisterVendor';
import ForgotPassword from './pages/auth/ForgotPassword';
import ResetPassword from './pages/auth/ResetPassword';
import AcceptInvite from './pages/auth/AcceptInvite';
import Privacy from './pages/Privacy';
import VendorInvoices from './pages/vendor/Invoices';
import TrustSafety from './pages/admin/TrustSafety';
import Security from './pages/Security';
import TeamPage from './pages/Team';

import AdminOverview from './pages/admin/Overview';
import AdminVendors from './pages/admin/Vendors';
import AdminVendorDetail from './pages/admin/VendorDetail';
import AdminEndUsers from './pages/admin/EndUsers';
import AdminEndUserDetail from './pages/admin/EndUserDetail';
import AdminCampaigns from './pages/admin/Campaigns';
import AdminModeration from './pages/admin/Moderation';
import AdminPayouts from './pages/admin/Payouts';
import AdminRecharges from './pages/admin/Recharges';
import AdminLedger from './pages/admin/Ledger';
import AdminImpressions from './pages/admin/Impressions';
import AdminReports from './pages/admin/Reports';
import AdminSettings from './pages/admin/Settings';
import AdminAudit from './pages/admin/Audit';
import AdminHealth from './pages/admin/Health';

import VendorOverview from './pages/vendor/Overview';
import VendorCampaigns from './pages/vendor/Campaigns';
import VendorCampaignDetail from './pages/vendor/CampaignDetail';
import VendorWallet from './pages/vendor/Wallet';
import VendorReports from './pages/vendor/Reports';
import VendorSettings from './pages/vendor/Settings';

import UserOverview from './pages/user/Overview';
import UserDevices from './pages/user/Devices';
import UserEarnings from './pages/user/Earnings';
import UserPayouts from './pages/user/Payouts';
import UserSettings from './pages/user/Settings';

/** Shown when a member reaches a page their permissions do not cover. */
function NoAccess({ section }: { section: string }) {
  return (
    <>
      <PageHeader title="No access to this section" subtitle={`Your account does not have permission to view ${section}.`} />
      <Card>
        <p className="text-sm text-ink-soft">
          Ask an owner or administrator on your team to grant it, then reload the page.
        </p>
      </Card>
    </>
  );
}

function Protected({ roles }: { roles: Role[] }) {
  const { user, loading, mfaSetupRequired } = useAuth();
  const location = useLocation();

  if (loading) return <Loading label="Checking your session" />;
  if (!user) {
    const target = roles.includes('SUPER_ADMIN') ? '/login/admin' : roles.includes('VENDOR') ? '/login/vendor' : '/login/user';
    return <Navigate to={target} replace state={{ from: location.pathname }} />;
  }
  // A console account without a second factor cannot go anywhere but enrolment.
  if (mfaSetupRequired) return <Navigate to="/security/two-step" replace />;
  if (!roles.includes(user.role)) return <Navigate to={HOME_FOR[user.role]} replace />;
  return <Shell />;
}

/** Wraps a page in its permission check so the guard lives beside the route. */
function Guarded({ section, children }: { section: string; children: React.ReactNode }) {
  const { can } = useAuth();
  return can(section) ? <>{children}</> : <NoAccess section={section} />;
}

function RootRedirect() {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  return <Navigate to={user ? HOME_FOR[user.role] : '/login'} replace />;
}

export default function App() {
  return (
    <Routes>
      {/* ── public ─────────────────────────────────────────────── */}
      <Route path="/login" element={<PortalChooser />} />
      <Route path="/login/admin" element={<Login portal="ADMIN" />} />
      <Route path="/login/vendor" element={<Login portal="VENDOR" />} />
      <Route path="/login/user" element={<Login portal="USER" />} />
      <Route path="/register" element={<Navigate to="/register/vendor" replace />} />
      <Route path="/register/vendor" element={<RegisterVendor />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      {/* Reachable while signed in but not yet enrolled. */}
      <Route path="/security/two-step" element={<TwoStepSetup />} />

      {/* ── console ────────────────────────────────────────────── */}
      <Route element={<Protected roles={['SUPER_ADMIN']} />}>
        <Route path="/admin" element={<Guarded section="dashboard"><AdminOverview /></Guarded>} />
        <Route path="/admin/vendors" element={<Guarded section="vendors"><AdminVendors /></Guarded>} />
        <Route path="/admin/vendors/:id" element={<Guarded section="vendors"><AdminVendorDetail /></Guarded>} />
        <Route path="/admin/end-users" element={<Guarded section="endusers"><AdminEndUsers /></Guarded>} />
        <Route path="/admin/end-users/:id" element={<Guarded section="endusers"><AdminEndUserDetail /></Guarded>} />
        <Route path="/admin/campaigns" element={<Guarded section="campaigns"><AdminCampaigns /></Guarded>} />
        <Route path="/admin/moderation" element={<Guarded section="moderation"><AdminModeration /></Guarded>} />
        <Route path="/admin/payouts" element={<Guarded section="payouts"><AdminPayouts /></Guarded>} />
        <Route path="/admin/recharges" element={<Guarded section="recharges"><AdminRecharges /></Guarded>} />
        <Route path="/admin/ledger" element={<Guarded section="ledger"><AdminLedger /></Guarded>} />
        <Route path="/admin/impressions" element={<Guarded section="delivery"><AdminImpressions /></Guarded>} />
        <Route path="/admin/reports" element={<Guarded section="dashboard"><AdminReports /></Guarded>} />
        <Route path="/admin/settings" element={<Guarded section="settings"><AdminSettings /></Guarded>} />
        <Route path="/admin/audit" element={<Guarded section="audit"><AdminAudit /></Guarded>} />
        <Route path="/admin/health" element={<Guarded section="health"><AdminHealth /></Guarded>} />
        <Route path="/admin/team" element={<Guarded section="team"><TeamPage /></Guarded>} />
        <Route path="/admin/trust-safety" element={<Guarded section="delivery"><TrustSafety /></Guarded>} />
        <Route path="/security" element={<Security />} />
        <Route path="/privacy" element={<Privacy />} />
      </Route>

      {/* ── advertiser ─────────────────────────────────────────── */}
      <Route element={<Protected roles={['VENDOR']} />}>
        <Route path="/vendor" element={<Guarded section="dashboard"><VendorOverview /></Guarded>} />
        <Route path="/vendor/campaigns" element={<Guarded section="campaigns"><VendorCampaigns /></Guarded>} />
        <Route path="/vendor/campaigns/:id" element={<Guarded section="campaigns"><VendorCampaignDetail /></Guarded>} />
        <Route path="/vendor/wallet" element={<Guarded section="wallet"><VendorWallet /></Guarded>} />
        <Route path="/vendor/reports" element={<Guarded section="reports"><VendorReports /></Guarded>} />
        <Route path="/vendor/settings" element={<Guarded section="settings"><VendorSettings /></Guarded>} />
        <Route path="/vendor/team" element={<Guarded section="team"><TeamPage /></Guarded>} />
        <Route path="/vendor/invoices" element={<Guarded section="wallet"><VendorInvoices /></Guarded>} />
        <Route path="/security" element={<Security />} />
        <Route path="/privacy" element={<Privacy />} />
      </Route>

      {/* ── earner ─────────────────────────────────────────────── */}
      <Route element={<Protected roles={['END_USER']} />}>
        <Route path="/app" element={<UserOverview />} />
        <Route path="/app/devices" element={<UserDevices />} />
        <Route path="/app/earnings" element={<UserEarnings />} />
        <Route path="/app/payouts" element={<UserPayouts />} />
        <Route path="/app/settings" element={<UserSettings />} />
        <Route path="/security" element={<Security />} />
        <Route path="/privacy" element={<Privacy />} />
      </Route>

      <Route path="/" element={<RootRedirect />} />
      <Route path="*" element={<RootRedirect />} />
    </Routes>
  );
}
