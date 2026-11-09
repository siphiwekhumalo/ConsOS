import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { CornerDownLeft, FolderKanban, Search } from 'lucide-react';
import { api, type Project } from '../../api';
import type { NavGroup } from '../../modules';
import { cx } from '../ui';

interface Entry {
  id: string;
  label: string;
  hint: string;
  icon: typeof Search;
  to: string;
  section: string;
}

export function CommandPalette({ open, onClose, groups }: { open: boolean; onClose: () => void; groups: NavGroup[] }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
    setTimeout(() => input.current?.focus(), 0);
    api.projects().then(setProjects, () => setProjects([]));
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const pages = groups.flatMap((g) =>
      g.items.map((i) => ({ id: i.path, label: i.label, hint: i.description, icon: i.icon, to: i.path, section: 'Go to' })),
    );
    const projs = projects.map((p) => ({
      id: p.id,
      label: `${p.code} · ${p.name}`,
      hint: 'Project',
      icon: FolderKanban,
      to: `/projects/${p.id}`,
      section: 'Projects',
    }));
    const q = query.trim().toLowerCase();
    const all = [...pages, ...projs];
    return q ? all.filter((e) => `${e.label} ${e.hint}`.toLowerCase().includes(q)) : all;
  }, [groups, projects, query]);

  useEffect(() => setIndex(0), [query]);

  if (!open) return null;

  const go = (e: Entry | undefined) => {
    if (!e) return;
    navigate(e.to);
    onClose();
  };

  let lastSection = '';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      <div className="fixed inset-0 bg-[var(--overlay)] backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface shadow-pop">
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search className="size-4 text-ink-3" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, entries.length - 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              }
              if (e.key === 'Enter') go(entries[index]);
            }}
            placeholder="Search modules and projects…"
            className="h-12 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
          />
          <kbd className="rounded border border-line px-1.5 text-[11px] text-ink-3">Esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {entries.length === 0 && <div className="px-3 py-8 text-center text-sm text-ink-3">No results for “{query}”</div>}
          {entries.map((e, i) => {
            const header = e.section !== lastSection ? e.section : null;
            lastSection = e.section;
            return (
              <div key={e.id}>
                {header && <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">{header}</div>}
                <button
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => go(e)}
                  className={cx('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left', i === index ? 'bg-surface-3' : '')}
                >
                  <e.icon className="size-4 shrink-0 text-ink-2" />
                  <span className="flex-1 truncate text-sm text-ink">{e.label}</span>
                  <span className="truncate text-xs text-ink-3">{e.hint}</span>
                  {i === index && <CornerDownLeft className="size-3.5 text-ink-3" />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
