import { useState, type FormEvent } from 'react';
import { ArrowRight, CloudOff, Lock, ScrollText } from 'lucide-react';
import { api, session } from '../api';
import { Logo } from '../components/shell/AppShell';
import { Alert, Button, Field, Input, errorMessage } from '../components/ui';

const POINTS = [
  { icon: Lock, title: 'Isolated by design', text: 'Every organisation’s data is sealed at the database layer.' },
  { icon: CloudOff, title: 'Built for remote sites', text: 'Site diaries keep working through loadshedding and dead zones.' },
  { icon: ScrollText, title: 'Audit-ready', text: 'A tamper-evident ledger for FIDIC, NEC and SARS reporting.' },
];

export function Login({ onLoggedIn, notice }: { onLoggedIn: () => void; notice?: string | null }) {
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
      setError(errorMessage(err) === 'Failed to fetch' ? 'Cannot reach the server. Check that the services are running.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen bg-surface lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel */}
      <div className="relative hidden overflow-hidden bg-[#0b1530] lg:flex lg:flex-col">
        <div
          className="absolute inset-0 opacity-[0.18]"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(255,255,255,.12) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,.12) 1px, transparent 1px)',
            backgroundSize: '44px 44px',
            maskImage: 'radial-gradient(ellipse at 30% 40%, black 30%, transparent 75%)',
          }}
        />
        <div className="absolute -left-32 top-1/3 size-[520px] rounded-full bg-[#2f5bd3] opacity-25 blur-[120px]" />
        <div className="absolute -bottom-40 right-0 size-[420px] rounded-full bg-[#f59e0b] opacity-10 blur-[120px]" />

        <div className="relative flex flex-1 flex-col justify-between p-12 text-white">
          <div className="flex items-center gap-3">
            <Logo />
            <span className="text-[15px] font-semibold tracking-tight">ConstructOS</span>
          </div>

          <div className="max-w-md">
            <h1 className="text-[34px] font-semibold leading-[1.15] tracking-tight">
              The operating system for South African construction.
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-white/65">
              Projects, field operations, commercial control, payroll and safety for CIDB Grade 5–9 contractors and mining
              corridors, in one platform.
            </p>
            <div className="mt-10 space-y-5">
              {POINTS.map((p) => (
                <div key={p.title} className="flex gap-3.5">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-white/[0.08] ring-1 ring-white/10">
                    <p.icon className="size-[18px] text-white/85" />
                  </span>
                  <div>
                    <div className="text-sm font-medium">{p.title}</div>
                    <div className="mt-0.5 text-sm text-white/55">{p.text}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="text-xs text-white/40">Hosted in South Africa (af-south-1) · POPIA-aligned data handling</div>
        </div>
      </div>

      {/* Form */}
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <Logo />
            <span className="text-[15px] font-semibold text-ink">ConstructOS</span>
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-ink">Sign in</h2>
          <p className="mt-1.5 text-sm text-ink-2">Use the organisation ID your administrator gave you.</p>

          <form onSubmit={submit} className="mt-8 space-y-4">
            <Field label="Organisation ID">
              <Input value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="your-company" autoComplete="organization" required autoFocus />
            </Field>
            <Field label="Work email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.co.za" autoComplete="username" required />
            </Field>
            <Field label="Password">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </Field>
            {notice && !error && <Alert tone="info">{notice}</Alert>}
            {error && <Alert>{error}</Alert>}
            <Button type="submit" loading={busy} className="h-10 w-full">
              Sign in <ArrowRight className="size-4" />
            </Button>
          </form>

          <p className="mt-8 text-center text-xs text-ink-3">Protected by rate limiting and audit logging.</p>
        </div>
      </div>
    </div>
  );
}
