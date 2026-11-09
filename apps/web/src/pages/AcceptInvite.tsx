import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ArrowRight, Check, KeyRound, X } from 'lucide-react';
import { api, session, type InviteInfo } from '../api';
import { Logo } from '../components/shell/AppShell';
import { Alert, Button, Card, Field, Input, Skeleton, cx, errorMessage } from '../components/ui';

/** Public page: an invited user (or one with a reset link) sets their own password. */
export function AcceptInvite({ onSignedIn }: { onSignedIn: () => void }) {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState<InviteInfo | null>();
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.inviteInfo(token).then(setInfo, (err) => {
      setInfo(null);
      setError(errorMessage(err));
    });
  }, [token]);

  const rules = [
    { ok: password.length >= 12, text: 'At least 12 characters' },
    { ok: password.length > 0 && password === confirm, text: 'Both passwords match' },
    { ok: !info || !password.toLowerCase().includes(info.email.split('@')[0]!.toLowerCase()), text: 'Doesn’t contain your email name' },
  ];
  const valid = rules.every((r) => r.ok);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.acceptInvite(token, password);
      session.set(res.accessToken);
      navigate('/', { replace: true });
      onSignedIn();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-bg px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <Logo />
          <span className="text-[15px] font-semibold text-ink">ConstructOS</span>
        </div>
        <Card className="p-7">
          {info === undefined && <Skeleton className="h-48" />}
          {info === null && (
            <div className="text-center">
              <span className="mx-auto grid size-11 place-items-center rounded-xl bg-critical-soft text-critical-ink"><X className="size-5" /></span>
              <h1 className="mt-4 text-lg font-semibold text-ink">This link can’t be used</h1>
              <p className="mt-1 text-sm text-ink-2">{error}</p>
              <Button variant="secondary" className="mt-6" onClick={() => navigate('/', { replace: true })}>Go to sign in</Button>
            </div>
          )}
          {info && (
            <form onSubmit={submit}>
              <span className="grid size-11 place-items-center rounded-xl bg-brand-soft text-brand-ink"><KeyRound className="size-5" /></span>
              <h1 className="mt-4 text-xl font-semibold tracking-tight text-ink">
                {info.purpose === 'invite' ? `Welcome, ${info.fullName.split(' ')[0]}` : 'Reset your password'}
              </h1>
              <p className="mt-1 text-sm text-ink-2">
                {info.purpose === 'invite' ? 'You’ve been invited to ' : 'Choose a new password for '}
                <span className="font-medium text-ink">{info.organisation.name}</span>.
              </p>
              <dl className="mt-5 grid grid-cols-2 gap-3 rounded-lg bg-surface-2 p-3 text-[13px]">
                <div><dt className="text-ink-3">Organisation ID</dt><dd className="font-mono text-ink">{info.organisation.id}</dd></div>
                <div><dt className="text-ink-3">Email</dt><dd className="truncate text-ink">{info.email}</dd></div>
              </dl>
              <p className="mt-2 text-xs text-ink-3">You’ll use these with your password to sign in.</p>

              <div className="mt-5 space-y-4">
                <Field label="New password">
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required autoFocus />
                </Field>
                <Field label="Confirm password">
                  <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
                </Field>
              </div>
              <ul className="mt-3 space-y-1">
                {rules.map((r) => (
                  <li key={r.text} className={cx('flex items-center gap-1.5 text-xs', r.ok ? 'text-good-ink' : 'text-ink-3')}>
                    <Check className={cx('size-3.5', !r.ok && 'opacity-30')} /> {r.text}
                  </li>
                ))}
              </ul>
              {error && <div className="mt-4"><Alert>{error}</Alert></div>}
              <Button type="submit" className="mt-6 h-10 w-full" loading={busy} disabled={!valid}>
                {info.purpose === 'invite' ? 'Set password and sign in' : 'Save password and sign in'} <ArrowRight className="size-4" />
              </Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
