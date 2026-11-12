import { useEffect, useState } from 'react';
import { Award, Building2, FileQuestion, HardHat, Settings, ShoppingCart } from 'lucide-react';
import { api, type Me, type Party } from '../../api';
import { useAsync } from '../../lib/useAsync';
import { date, zar } from '../../lib/format';
import { AmountInput } from '../../components/forms';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, PageHeader, Skeleton, Stat, StatusPill, Table, Tabs, Td, Th, Tr } from '../../components/ui';
import { BarList, ChartCard, ORDINAL } from '../../components/charts';
import { PartyDialog } from '../finance/shared';
import { PartyTable } from '../finance/Payables';
import { Orders } from './Orders';
import { Rfqs } from './Rfqs';
import { Subcontracts } from './Subcontracts';
import { today } from './shared';

type Tab = 'orders' | 'rfqs' | 'subcontracts' | 'suppliers' | 'bbbee' | 'settings';
const BUYERS = ['owner', 'admin', 'project_manager', 'finance'];

export function Procurement({ me }: { me: Me }) {
  const role = me.user.role;
  const buyer = BUYERS.includes(role);
  const [tab, setTab] = useState<Tab>('orders');
  const suppliers = useAsync(() => api.procurement.suppliers(), []);
  const projects = useAsync(() => api.projects(), []);
  const accounts = useAsync(() => api.procurement.accounts(), []);
  const [party, setParty] = useState<Party | 'new' | null>(null);

  return (
    <div>
      <PageHeader
        title="Procurement & subcontracts"
        description="Requisitions and purchase orders with approval limits, quotes compared side by side, goods received on site, three-way invoice matching, subcontract payment certificates and B-BBEE procurement spend."
        eyebrow={<Badge tone="brand">Module 5</Badge>}
      />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'orders', label: 'Purchase orders', icon: ShoppingCart },
          ...(buyer
            ? [
                { id: 'rfqs' as Tab, label: 'Quotes (RFQs)', icon: FileQuestion },
                { id: 'subcontracts' as Tab, label: 'Subcontracts', icon: HardHat },
                { id: 'suppliers' as Tab, label: 'Suppliers', icon: Building2, count: suppliers.data?.length },
                { id: 'bbbee' as Tab, label: 'B-BBEE spend', icon: Award },
              ]
            : []),
          ...(role === 'owner' || role === 'admin' ? [{ id: 'settings' as Tab, label: 'Approval limits', icon: Settings }] : []),
        ]}
      />
      {suppliers.error && <Alert>{suppliers.error}</Alert>}
      {tab === 'orders' && <Orders me={me} suppliers={suppliers.data ?? []} projects={projects.data ?? []} accounts={accounts.data ?? []} />}
      {tab === 'rfqs' && <Rfqs suppliers={suppliers.data ?? []} projects={projects.data ?? []} accounts={accounts.data ?? []} />}
      {tab === 'subcontracts' && <Subcontracts me={me} suppliers={suppliers.data ?? []} projects={projects.data ?? []} />}
      {tab === 'suppliers' && (
        <>
          <PartyTable title="Suppliers" parties={suppliers.data} onAdd={() => setParty('new')} onEdit={setParty} />
          <SupplierCompliance suppliers={suppliers.data ?? []} />
        </>
      )}
      {tab === 'bbbee' && <Bbbee />}
      {tab === 'settings' && <ApprovalSettings />}
      <PartyDialog kind="supplier" via="procurement" party={party === 'new' ? null : party} open={party !== null} onClose={() => setParty(null)} onSaved={() => void suppliers.reload()} />
    </div>
  );
}

/** Suppliers whose B-BBEE certificate has lapsed or lapses within 60 days. */
function SupplierCompliance({ suppliers }: { suppliers: Party[] }) {
  const soon = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  const due = suppliers.filter((s) => s.isActive && s.bbbeeLevel && s.bbbeeExpiry && s.bbbeeExpiry <= soon);
  if (due.length === 0) return null;
  return (
    <Card className="mt-6">
      <CardHeader title="B-BBEE certificates to renew" subtitle="Spend with a supplier only counts at their level while the certificate is valid." />
      <ul className="mt-3 space-y-2 text-sm">
        {due.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3">
            <span>{s.name} · Level {s.bbbeeLevel}</span>
            <StatusPill status={s.bbbeeExpiry! < today() ? 'critical' : 'warning'}>{s.bbbeeExpiry! < today() ? 'Expired' : 'Expires'} {date(s.bbbeeExpiry!)}</StatusPill>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Bbbee() {
  const [range, setRange] = useState({ from: `${Number(today().slice(0, 4)) - 1}${today().slice(4)}`, to: today() });
  const report = useAsync(() => api.procurement.bbbee(range.from, range.to), [range.from, range.to]);
  const r = report.data;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
      </div>
      {report.error && <Alert>{report.error}</Alert>}
      {!r ? <Skeleton className="h-48" /> : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Measured procurement spend" value={zar(r.totalSpend)} hint="approved supplier invoices, excl. VAT" />
            <Stat label="B-BBEE recognised spend" value={zar(r.recognisedSpend)} hint="weighted by each supplier's level" />
            <Stat label="Recognised as % of spend" value={r.recognisedPct ? `${r.recognisedPct}%` : '—'} hint="above 100% means more Level 1–3 spend" />
          </div>
          <div className="grid gap-6 xl:grid-cols-[1fr_1.4fr]">
            <ChartCard title="Spend by B-BBEE level" table={{ columns: ['Level', 'Spend', 'Recognised'], rows: r.byLevel.map((l) => [l.level, zar(l.spend), zar(l.recognised)]) }}>
              <BarList
                rows={[...r.byLevel].sort((a, b) => a.level.localeCompare(b.level)).map((l) => ({ label: l.level, value: Number(l.spend), note: `recognised ${zar(l.recognised)}` }))}
                format={(v) => zar(v)}
                colorFor={(i) => ORDINAL[Math.min(i, ORDINAL.length - 1)]!}
              />
            </ChartCard>
            <Card padded={false}>
              <div className="p-5 pb-4"><CardHeader title="By supplier" subtitle="Recognition: L1 135%, L2 125%, L3 110%, L4 100%, L5 80%, L6 60%, L7 50%, L8 10%, otherwise 0%" /></div>
              <Table>
                <thead><tr><Th>Supplier</Th><Th>Level</Th><Th right>Spend</Th><Th right>Recognised</Th></tr></thead>
                <tbody>
                  {r.suppliers.map((s) => (
                    <Tr key={s.supplierId}>
                      <Td className="font-medium">{s.supplierName}</Td>
                      <Td>{s.recognitionPct ? `Level ${s.level} (${s.recognitionPct}%)` : <span className="text-critical-ink">{s.level ? 'Certificate expired' : 'Non-compliant'}</span>}</Td>
                      <Td right>{zar(s.spend)}</Td>
                      <Td right>{zar(s.recognised)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function ApprovalSettings() {
  const [form, setForm] = useState({ pmApprovalLimit: '', priceTolerancePct: '' });
  const [msg, setMsg] = useState<{ tone: 'good' | 'critical'; text: string } | null>(null);
  useEffect(() => { void api.procurement.settings().then((s) => setForm({ pmApprovalLimit: s.pmApprovalLimit, priceTolerancePct: s.priceTolerancePct })); }, []);
  const save = async () => {
    setMsg(null);
    try {
      const s = await api.procurement.updateSettings(form);
      setForm({ pmApprovalLimit: s.pmApprovalLimit, priceTolerancePct: s.priceTolerancePct });
      setMsg({ tone: 'good', text: 'Saved.' });
    } catch (err) {
      setMsg({ tone: 'critical', text: (err as Error).message });
    }
  };
  return (
    <Card className="max-w-2xl space-y-4">
      <CardHeader title="Approval limits and matching" subtitle="Finance, administrators and owners can approve any order. Nobody but an owner can approve an order they raised." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Project managers may approve up to (R, excl. VAT)"><AmountInput value={form.pmApprovalLimit} onChange={(pmApprovalLimit) => setForm({ ...form, pmApprovalLimit })} required /></Field>
        <Field label="Invoice price tolerance (%)" hint="How far above the order price an invoice may be before it is a mismatch"><Input inputMode="decimal" value={form.priceTolerancePct} onChange={(e) => setForm({ ...form, priceTolerancePct: e.target.value })} pattern="\d{1,2}(\.\d{1,2})?" /></Field>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="flex justify-end"><Button onClick={() => void save()}>Save</Button></div>
    </Card>
  );
}
