export function ModulePlaceholder({ title }: { title: string }) {
  return (
    <section>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-slate-500">This module is active for your organisation and is under construction.</p>
    </section>
  );
}
