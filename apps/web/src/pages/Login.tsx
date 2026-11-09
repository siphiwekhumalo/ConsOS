import { useState, type FormEvent } from 'react';
import { api, session } from '../api';

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [tenant, setTenant] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { accessToken } = await api.login(tenant, email, password);
      session.set(accessToken);
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const field = 'mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none';

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <h1 className="text-xl font-semibold">Sign in to ConstructOS</h1>
        <label className="mt-5 block text-sm font-medium">
          Organisation
          <input className={field} value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="your-company" autoComplete="organization" required />
        </label>
        <label className="mt-3 block text-sm font-medium">
          Email
          <input className={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label className="mt-3 block text-sm font-medium">
          Password
          <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <button disabled={busy} className="mt-5 w-full rounded-md bg-slate-900 py-2 text-sm font-medium text-white disabled:opacity-50">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
