import { useEffect, useState } from 'react';
import { api, type Project } from '../api';

const zar = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' });

export function Projects() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.projects().then(setProjects, (err: Error) => setError(err.message));
  }, []);

  return (
    <section>
      <h1 className="text-2xl font-semibold">Projects</h1>
      {error && <p className="mt-4 text-red-600">{error}</p>}
      {!projects && !error && <p className="mt-4 text-slate-500">Loading…</p>}
      {projects && (
        <div className="mt-6 overflow-x-auto rounded-lg bg-white ring-1 ring-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Code</th>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Contract</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className="border-t border-slate-100">
                  <td className="px-4 py-2 font-mono">{p.code}</td>
                  <td className="px-4 py-2">{p.name}</td>
                  <td className="px-4 py-2">{p.contractForm?.replace(/_/g, ' ') ?? '—'}</td>
                  <td className="px-4 py-2 capitalize">{p.status.replace(/_/g, ' ')}</td>
                  {/* Display only — Number() is acceptable for formatting, never for arithmetic. */}
                  <td className="px-4 py-2 text-right tabular-nums">
                    {p.contractValue ? zar.format(Number(p.contractValue)) : '—'}
                  </td>
                </tr>
              ))}
              {projects.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-500">No projects yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
