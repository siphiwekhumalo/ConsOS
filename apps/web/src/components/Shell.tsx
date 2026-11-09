import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { label, type Me } from '../api';
import type { NavItem } from '../modules';

interface Props {
  me: Me;
  nav: NavItem[];
  onLogout: () => void;
  children: ReactNode;
}

export function Shell({ me, nav, onLogout, children }: Props) {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col bg-slate-900 text-slate-100 md:sticky md:top-0 md:h-screen md:w-60">
        <div className="flex items-center justify-between px-5 py-4 md:block">
          <div>
            <div className="text-lg font-semibold tracking-tight">ConstructOS</div>
            <div className="truncate text-xs text-slate-400" title={me.tenant.name}>
              {me.tenant.name}
            </div>
          </div>
          <button onClick={onLogout} className="text-xs text-slate-400 underline md:hidden">
            Sign out
          </button>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:overflow-visible">
          {nav.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `flex items-center justify-between whitespace-nowrap rounded-md px-3 py-2 text-sm ${
                  isActive ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'
                }`
              }
            >
              {item.label}
              {item.comingSoon && <span className="ml-2 text-[10px] uppercase text-slate-500">soon</span>}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto hidden border-t border-slate-800 px-5 py-4 text-xs md:block">
          <div className="truncate text-slate-300">{me.user.fullName}</div>
          <div className="capitalize text-slate-500">{label(me.user.role)}</div>
          <button onClick={onLogout} className="mt-2 text-slate-400 underline hover:text-white">
            Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
    </div>
  );
}
