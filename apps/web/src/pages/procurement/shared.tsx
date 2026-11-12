import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, type CostCategory, type OrderLineInput, type Project } from '../../api';
import { sentence, zar } from '../../lib/format';
import { AmountInput } from '../../components/forms';
import { Badge, Button, Input, Select } from '../../components/ui';

export const CATEGORIES: CostCategory[] = ['labour', 'material', 'plant', 'subcontract', 'overhead', 'other'];
export const today = () => new Date().toISOString().slice(0, 10);

type CostCode = { id: string; code: string; description: string };

/** Cost codes per project, fetched on demand and cached. */
export function useCostCodes() {
  const [codes, setCodes] = useState<Record<string, CostCode[]>>({});
  const ensure = useCallback(
    (projectId: string) => {
      if (!projectId || codes[projectId]) return;
      setCodes((c) => ({ ...c, [projectId]: [] }));
      void api.procurement.costCodes(projectId).then((list) => setCodes((c) => ({ ...c, [projectId]: list })));
    },
    [codes],
  );
  return { codes, ensure };
}

const TONE: Record<string, 'neutral' | 'brand' | 'good' | 'warning' | 'critical'> = {
  draft: 'neutral',
  submitted: 'warning',
  open: 'brand',
  approved: 'brand',
  active: 'brand',
  awarded: 'good',
  certified: 'good',
  closed: 'good',
  completed: 'good',
  cancelled: 'critical',
  terminated: 'critical',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <Badge tone={TONE[status] ?? 'neutral'} dot>
      <span className="capitalize">{label ?? status.replace('_', ' ')}</span>
    </Badge>
  );
}

export const blankOrderLine = (projectId: string | null = null): OrderLineInput => ({
  description: '',
  unit: 'ea',
  quantity: '',
  unitPrice: '',
  vatRate: '15',
  projectId,
  costCodeId: null,
  category: projectId ? 'material' : null,
  accountId: null,
});

/** Line editor for purchase orders: project cost code lines or overhead account lines. */
export function OrderLinesEditor({
  lines,
  onChange,
  projects,
  accounts,
}: {
  lines: OrderLineInput[];
  onChange: (lines: OrderLineInput[]) => void;
  projects: Project[];
  accounts: { id: string; code: string; name: string }[];
}) {
  const { codes, ensure } = useCostCodes();
  useEffect(() => {
    lines.forEach((l) => l.projectId && ensure(l.projectId));
  }, [lines, ensure]);
  const set = (i: number, patch: Partial<OrderLineInput>) => onChange(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const cents = (q: string, p: string) => Math.round(Number(q || 0) * Number(p || 0) * 100);
  const subtotal = lines.reduce((s, l) => s + cents(l.quantity, l.unitPrice), 0);
  const vat = lines.reduce((s, l) => s + Math.round((cents(l.quantity, l.unitPrice) * Number(l.vatRate)) / 100), 0);

  return (
    <div className="space-y-3">
      {lines.map((l, i) => (
        <div key={i} className="rounded-lg border border-line p-3">
          <div className="grid gap-2 sm:grid-cols-[2fr_5rem_6rem_7rem_5rem_auto]">
            <Input placeholder="Description" value={l.description} onChange={(e) => set(i, { description: e.target.value })} required maxLength={300} />
            <Input placeholder="Unit" value={l.unit} onChange={(e) => set(i, { unit: e.target.value })} required maxLength={20} aria-label="Unit" />
            <Input placeholder="Qty" inputMode="decimal" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} required pattern="\d{1,15}(\.\d{1,3})?" aria-label="Quantity" />
            <AmountInput value={l.unitPrice} onChange={(unitPrice) => set(i, { unitPrice })} required />
            <Select value={l.vatRate} onChange={(e) => set(i, { vatRate: e.target.value })} aria-label="VAT rate">
              <option value="15">15%</option>
              <option value="0">0%</option>
            </Select>
            <Button type="button" variant="ghost" icon={Trash2} aria-label="Remove line" disabled={lines.length === 1} onClick={() => onChange(lines.filter((_, n) => n !== i))} />
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-[1.3fr_1.3fr_1fr]">
            <Select
              value={l.projectId ?? ''}
              onChange={(e) => {
                const projectId = e.target.value || null;
                if (projectId) ensure(projectId);
                set(i, { projectId, costCodeId: null, category: projectId ? (l.category ?? 'material') : null, accountId: null });
              }}
              aria-label="Project"
            >
              <option value="">Overhead (no project)</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
            </Select>
            {l.projectId ? (
              <>
                <Select value={l.costCodeId ?? ''} onChange={(e) => set(i, { costCodeId: e.target.value || null })} required aria-label="Cost code">
                  <option value="">{codes[l.projectId]?.length === 0 ? 'No cost codes on this project' : 'Cost code…'}</option>
                  {(codes[l.projectId] ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.description}</option>)}
                </Select>
                <Select value={l.category ?? 'material'} onChange={(e) => set(i, { category: e.target.value as CostCategory })} aria-label="Category">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{sentence(c)}</option>)}
                </Select>
              </>
            ) : (
              <Select value={l.accountId ?? ''} onChange={(e) => set(i, { accountId: e.target.value || null })} required className="sm:col-span-2" aria-label="Account">
                <option value="">{accounts.length ? 'Expense or asset account…' : 'Set up the chart of accounts in Finance first'}</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
              </Select>
            )}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button type="button" size="sm" variant="secondary" icon={Plus} onClick={() => onChange([...lines, blankOrderLine(lines[lines.length - 1]?.projectId ?? null)])}>Add line</Button>
        <span className="num text-sm text-ink-2">
          Excl. VAT {zar((subtotal / 100).toFixed(2), true)} · VAT {zar((vat / 100).toFixed(2), true)} · <span className="font-semibold text-ink">Total {zar(((subtotal + vat) / 100).toFixed(2), true)}</span>
        </span>
      </div>
    </div>
  );
}
