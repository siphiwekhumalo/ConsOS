import { lazy, Suspense, useCallback, useEffect, useState, type ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { api, ApiError, SESSION_EXPIRED, session, tokenSecondsLeft, type Me } from './api';
import { visibleGroups } from './modules';
import { AppShell, Logo } from './components/shell/AppShell';
import { Login } from './pages/Login';
import { Skeleton } from './components/ui';

// Route-level code splitting: each page (and the chart library) loads on first visit.
const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType<any>>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));
const Dashboard = page(() => import('./pages/Dashboard'), 'Dashboard');
const Projects = page(() => import('./pages/projects/Projects'), 'Projects');
const ProjectDetail = page(() => import('./pages/projects/ProjectDetail'), 'ProjectDetail');
const FieldOps = page(() => import('./pages/FieldOps'), 'FieldOps');
const Finance = page(() => import('./pages/Finance'), 'Finance');
const AiAgent = page(() => import('./pages/AiAgent'), 'AiAgent');
const Audit = page(() => import('./pages/Audit'), 'Audit');
const Payroll = page(() => import('./pages/people/Payroll'), 'Payroll');
const Crm = page(() => import('./pages/modules/Crm'), 'Crm');
const Estimating = page(() => import('./pages/modules/Estimating'), 'Estimating');
const Procurement = page(() => import('./pages/procurement/Procurement'), 'Procurement');
const Fleet = page(() => import('./pages/operations/Fleet'), 'Fleet');
const Hse = page(() => import('./pages/operations/Hse'), 'Hse');
const Portal = page(() => import('./pages/modules/Portal'), 'Portal');
const Pipeline = page(() => import('./pages/commercial/Pipeline'), 'Pipeline');
const Users = page(() => import('./pages/settings/Users'), 'Users');
const AcceptInvite = page(() => import('./pages/AcceptInvite'), 'AcceptInvite');
const EstimateDetail = page(() => import('./pages/commercial/EstimateDetail'), 'EstimateDetail');

function PageFallback() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-64" />
      <div className="grid gap-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}

export function App() {
  const location = useLocation();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(Boolean(session.token));

  const loadMe = useCallback(async () => {
    setLoading(true);
    try {
      setMe(await api.me());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) session.clear();
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session.token) void loadMe();
  }, [loadMe]);

  // The server rejected the session: back to sign-in, staying on the same page.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const onExpired = () => {
      setMe(null);
      setNotice('Your session expired. Sign in again to carry on where you left off.');
    };
    window.addEventListener(SESSION_EXPIRED, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED, onExpired);
  }, []);

  // Keep an active user signed in: renew the token shortly before it expires,
  // but only after recent activity, so an unattended screen still times out.
  useEffect(() => {
    if (!me) return;
    let lastActivity = Date.now();
    const touch = () => { lastActivity = Date.now(); };
    const events = ['pointerdown', 'keydown', 'wheel'] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const timer = setInterval(() => {
      const left = tokenSecondsLeft(session.token);
      if (left === null || left > 180 || Date.now() - lastActivity > 10 * 60_000) return;
      api.refresh().then((r) => session.set(r.accessToken), () => { /* a 401 here ends the session via SESSION_EXPIRED */ });
    }, 60_000);
    return () => {
      clearInterval(timer);
      events.forEach((e) => window.removeEventListener(e, touch));
    };
  }, [me]);

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-bg">
        <div className="flex flex-col items-center gap-3 text-sm text-ink-3">
          <Logo />
          Loading your workspace…
        </div>
      </div>
    );
  }
  // Invite / password-reset links work without (and replace) any current session.
  if (location.pathname.startsWith('/invite/')) {
    return (
      <Suspense fallback={null}>
        <Routes>
          <Route path="/invite/:token" element={<AcceptInvite onSignedIn={loadMe} />} />
        </Routes>
      </Suspense>
    );
  }
  if (!me) return <Login notice={notice} onLoggedIn={() => { setNotice(null); void loadMe(); }} />;

  const groups = visibleGroups(me.modules, me.user.role);
  const allowed = new Set(groups.flatMap((g) => g.items.map((i) => i.path)));
  const guard = (path: string, el: ReactElement) => (allowed.has(path) ? el : <Navigate to="/" replace />);

  return (
    <AppShell
      me={me}
      groups={groups}
      onLogout={() => {
        session.clear();
        setMe(null);
      }}
    >
      <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/" element={<Dashboard me={me} />} />
        <Route path="/projects" element={<Projects me={me} />} />
        <Route path="/projects/:projectId" element={<ProjectDetail me={me} />} />
        <Route path="/commercial" element={guard('/commercial', <Pipeline me={me} />)} />
        <Route path="/commercial/:estimateId" element={guard('/commercial', <EstimateDetail me={me} />)} />
        <Route path="/field" element={guard('/field', <FieldOps />)} />
        <Route path="/hse" element={guard('/hse', <Hse me={me} />)} />
        <Route path="/fleet" element={guard('/fleet', <Fleet me={me} />)} />
        <Route path="/crm" element={guard('/crm', <Crm />)} />
        <Route path="/estimating" element={guard('/estimating', <Estimating />)} />
        <Route path="/finance" element={guard('/finance', <Finance me={me} />)} />
        <Route path="/procurement" element={guard('/procurement', <Procurement me={me} />)} />
        <Route path="/payroll" element={guard('/payroll', <Payroll me={me} />)} />
        {/* Not /ai: that prefix belongs to the AI service behind the gateway. */}
        <Route path="/agent" element={guard('/agent', <AiAgent />)} />
        <Route path="/portal" element={guard('/portal', <Portal />)} />
        <Route path="/audit" element={guard('/audit', <Audit />)} />
        <Route path="/settings/users" element={guard('/settings/users', <Users me={me} />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </AppShell>
  );
}
