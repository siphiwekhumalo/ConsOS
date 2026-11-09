import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import type { Me } from '../api';
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
      <aside className="flex shrink-0 flex-col border-b border-slate-200 bg-slate-900 text-slate-100 md:w-60 md:border-b-0 md:border-r">
        <div className="px-5 py-4">
          <div className="text-lg font-semibold tracking-tight">ConstructOS</div>
          <div className="truncate text-xs text-slate-400" title={me.tenant.name}>
            {me.tenant.name}
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:overflow-visible">
          {nav.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-md px-3 py-2 text-sm ${
                  isActive ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto hidden border-t border-slate-800 px-5 py-4 text-xs md:block">
          <div className="truncate text-slate-300">{me.user.fullName}</div>
          <div className="text-slate-500">{me.user.role.replace('_', ' ')}</div>
          <button onClick={onLogout} className="mt-2 text-slate-400 underline hover:text-white">
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 p-4 md:p-8">{children}</main>
    </div>
  );
}
