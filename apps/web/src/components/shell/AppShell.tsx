import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { ChevronRight, LogOut, Menu, Monitor, Moon, Search, Sun, X } from 'lucide-react';
import type { Me } from '../../api';
import { label } from '../../lib/format';
import { useTheme, type ThemePref } from '../../lib/theme';
import { useCrumb } from '../../lib/crumb';
import { ALL_NAV, type NavGroup } from '../../modules';
import { Avatar, cx } from '../ui';
import { CommandPalette } from './CommandPalette';

export function AppShell({ me, groups, onLogout, children }: { me: Me; groups: NavGroup[]; onLogout: () => void; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setMobileOpen(false), [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="min-h-screen bg-bg lg:pl-64">
      {/* Sidebar */}
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-line bg-sidebar transition-transform lg:translate-x-0',
          mobileOpen ? 'translate-x-0 shadow-pop' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <Logo />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold leading-tight text-ink">ConstructOS</div>
            <div className="truncate text-xs text-ink-3" title={me.tenant.name}>
              {me.tenant.name}
            </div>
          </div>
          <button className="rounded-md p-1 text-ink-3 lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close menu">
            <X className="size-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-3">
          {groups.map((g, gi) => (
            <div key={gi} className={gi > 0 ? 'mt-5' : ''}>
              {g.label && <div className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">{g.label}</div>}
              <div className="space-y-0.5">
                {g.items.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    end={item.path === '/'}
                    className={({ isActive }) =>
                      cx(
                        'group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium transition-colors',
                        isActive ? 'bg-brand-soft text-brand-ink' : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
                      )
                    }
                  >
                    <item.icon className="size-4 shrink-0" strokeWidth={1.85} />
                    <span className="flex-1 truncate">{item.label}</span>
                    {!item.live && (
                      <span className="rounded border border-dashed border-line-strong px-1 text-[10px] font-medium text-ink-3" title="Design preview with sample data">
                        Preview
                      </span>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-line p-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <Avatar name={me.user.fullName} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-ink">{me.user.fullName}</div>
              <div className="truncate text-xs capitalize text-ink-3">{label(me.user.role)}</div>
            </div>
          </div>
        </div>
      </aside>
      {mobileOpen && <div className="fixed inset-0 z-30 bg-[var(--overlay)] lg:hidden" onClick={() => setMobileOpen(false)} />}

      {/* Top bar */}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-md md:px-6">
        <button className="rounded-md p-1.5 text-ink-2 hover:bg-surface-3 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
          <Menu className="size-5" />
        </button>
        <Breadcrumbs />
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => setPaletteOpen(true)}
            className="hidden h-8 w-64 items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 text-[13px] text-ink-3 transition hover:border-line-strong md:flex"
          >
            <Search className="size-4" />
            Search or jump to…
            <kbd className="ml-auto rounded border border-line bg-surface px-1.5 font-sans text-[11px] font-medium">Ctrl K</kbd>
          </button>
          <button className="rounded-lg p-2 text-ink-2 hover:bg-surface-3 md:hidden" onClick={() => setPaletteOpen(true)} aria-label="Search">
            <Search className="size-4" />
          </button>
          <ThemeMenu />
          <UserMenu me={me} onLogout={onLogout} />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 md:px-8 md:py-8">{children}</main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} groups={groups} />
    </div>
  );
}

function Logo() {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-[#2f5bd3] to-[#1d3f9e] shadow-card">
      <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" aria-hidden>
        <path d="M4 20V9l8-5 8 5v11" stroke="white" strokeWidth="2" strokeLinejoin="round" />
        <path d="M9 20v-6h6v6" stroke="#f59e0b" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
export { Logo };

function Breadcrumbs() {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean);
  const root = ALL_NAV.find((n) => n.path === `/${parts[0] ?? ''}`) ?? ALL_NAV[0]!;
  const detail = useCrumb();
  return (
    <nav className="flex min-w-0 items-center gap-1.5 text-sm" aria-label="Breadcrumb">
      <Link to={root.path} className={cx('truncate font-medium', parts.length > 1 ? 'text-ink-3 hover:text-ink' : 'text-ink')}>
        {root.label}
      </Link>
      {parts.length > 1 && (
        <>
          <ChevronRight className="size-3.5 shrink-0 text-ink-3" />
          <span className="truncate font-medium text-ink">{detail ?? '…'}</span>
        </>
      )}
    </nav>
  );
}

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return { open, setOpen, ref };
}

function ThemeMenu() {
  const { pref, setPref } = useTheme();
  const { open, setOpen, ref } = usePopover();
  const options: { id: ThemePref; label: string; icon: typeof Sun }[] = [
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'dark', label: 'Dark', icon: Moon },
    { id: 'system', label: 'System', icon: Monitor },
  ];
  const Current = options.find((o) => o.id === pref)!.icon;
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)} className="rounded-lg p-2 text-ink-2 hover:bg-surface-3" aria-label="Theme">
        <Current className="size-4" />
      </button>
      {open && (
        <div className="absolute right-0 mt-1.5 w-36 rounded-xl border border-line bg-surface p-1 shadow-pop">
          {options.map((o) => (
            <button
              key={o.id}
              onClick={() => {
                setPref(o.id);
                setOpen(false);
              }}
              className={cx('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px]', pref === o.id ? 'bg-surface-3 font-medium text-ink' : 'text-ink-2 hover:bg-surface-3')}
            >
              <o.icon className="size-4" />
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function UserMenu({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)} className="ml-1 rounded-full" aria-label="Account">
        <Avatar name={me.user.fullName} />
      </button>
      {open && (
        <div className="absolute right-0 mt-1.5 w-64 rounded-xl border border-line bg-surface shadow-pop">
          <div className="border-b border-line p-3">
            <div className="text-sm font-medium text-ink">{me.user.fullName}</div>
            <div className="truncate text-xs text-ink-3">{me.user.email}</div>
            <div className="mt-2 flex items-center gap-1.5 text-xs text-ink-2">
              <span className="truncate">{me.tenant.name}</span>
              <span className="text-ink-3">·</span>
              <span className="capitalize">{label(me.tenant.tier)}</span>
            </div>
          </div>
          <div className="p-1">
            <button onClick={onLogout} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-2 hover:bg-surface-3 hover:text-ink">
              <LogOut className="size-4" /> Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
