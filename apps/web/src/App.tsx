import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { api, ApiError, session, type Me } from './api';
import { visibleNav } from './modules';
import { Login } from './pages/Login';
import { Shell } from './components/Shell';
import { Projects } from './pages/Projects';
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

  const nav = visibleNav(me.modules);

  return (
    <Shell me={me} nav={nav} onLogout={logout}>
      <Routes>
        <Route path="/projects" element={<Projects />} />
        {nav
          .filter((item) => item.module !== null)
          .map((item) => (
            <Route
              key={item.path}
              path={item.path}
              element={<ModulePlaceholder title={item.label} />}
            />
          ))}
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </Shell>
  );
}
