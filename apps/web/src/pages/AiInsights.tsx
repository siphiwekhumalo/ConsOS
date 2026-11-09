import { useCallback, useEffect, useState } from 'react';
import { api, type AiJob } from '../api';
import { AiJobCard } from '../components/AiResults';
import { Empty, ErrorText, errorMessage, PageHeader } from '../components/ui';

export function AiInsights() {
  const [jobs, setJobs] = useState<AiJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.aiJobs().then(setJobs, (e) => setError(errorMessage(e))), []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!jobs?.some((j) => j.status === 'queued' || j.status === 'running')) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [jobs, load]);

  return (
    <section>
      <PageHeader
        title="AI insights"
        subtitle="Tender BOQ extraction and site diary risk reviews. Results are suggestions for a person to check."
      />
      <ErrorText error={error} />
      {jobs?.length === 0 && <Empty>No AI jobs yet. Start one from a project's Documents or AI insights tab.</Empty>}
      <div className="space-y-4">
        {jobs?.map((j) => (
          <AiJobCard key={j.id} job={j} />
        ))}
      </div>
    </section>
  );
}
