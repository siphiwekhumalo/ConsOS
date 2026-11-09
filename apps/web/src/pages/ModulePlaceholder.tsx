import { Card, PageHeader } from '../components/ui';

export function ModulePlaceholder({ title }: { title: string }) {
  return (
    <section>
      <PageHeader title={title} />
      <Card>
        <p className="text-sm text-slate-600">This module is active for your organisation and is being built. See docs/backend-architecture.md for the roadmap.</p>
      </Card>
    </section>
  );
}
