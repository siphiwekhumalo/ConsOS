import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { api, ApiError, session, type Me } from './api';
import { visibleNav } from './modules';
import { Login } from './pages/Login';
import { Shell } from './components/Shell';
import { Projects } from './pages/Projects';
import { ProjectDetail } from './pages/ProjectDetail';
import { Audit } from './pages/Audit';
import { Rules } from './pages/Rules';
import { AiInsights } from './pages/AiInsights';
import { ModulePlaceholder } from './pages/ModulePlaceholder';

export function App() {
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

  const logout = () => {
    session.clear();
    setMe(null);
  };

  if (loading) {
    return <div className="grid min-h-screen place-items-center text-slate-500">Loading…</div>;
  }
  if (!me) {
    return <Login onLoggedIn={loadMe} />;
  }

  const nav = visibleNav(me.modules, me.user.role);
  const allowed = (path: string) => nav.some((n) => n.path === path);

  return (
    <Shell me={me} nav={nav} onLogout={logout}>
      <Routes>
        <Route path="/projects" element={<Projects me={me} />} />
        <Route path="/projects/:projectId" element={<ProjectDetail me={me} />} />
        {allowed('/audit') && <Route path="/audit" element={<Audit />} />}
        {allowed('/rules') && <Route path="/rules" element={<Rules />} />}
        {allowed('/ai') && <Route path="/ai" element={<AiInsights />} />}
        {nav
          .filter((n) => n.comingSoon)
          .map((n) => (
            <Route key={n.path} path={n.path} element={<ModulePlaceholder title={n.label} />} />
          ))}
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </Shell>
  );
}
