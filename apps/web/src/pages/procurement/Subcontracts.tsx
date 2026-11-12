import { useEffect, useState } from 'react';
import { BadgeCheck, HardHat, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { api, type Me, type Party, type Project, type Subcontract, type SubcontractCertificate } from '../../api';
import { useAsync } from '../../lib/useAsync';
import { date, zar } from '../../lib/format';
import { AmountInput, FormDialog, useAction } from '../../components/forms';
import { Alert, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Progress, Select, Skeleton, Table, Td, Textarea, Th, Tr } from '../../components/ui';
import { StatusBadge, today, useCostCodes } from './shared';

const CERTIFIERS = ['owner', 'admin', 'finance'];

export function Subcontracts({ me, suppliers, projects }: { me: Me; suppliers: Party[]; projects: Project[] }) {
  const list = useAsync(() => api.procurement.subcontracts(), []);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const subs = suppliers.filter((s) => s.isSubcontractor && s.isActive);
  return (
    <>
      <Card padded={false}>
        <div className="p-5 pb-4">
          <CardHeader
            title="Subcontracts"
            subtitle="Fixed-value subcontracts with monthly payment certificates. Retention is held back and owed to the subcontractor later."
            actions={<Button size="sm" icon={Plus} disabled={!subs.length} title={subs.length ? undefined : 'Mark a supplier as a subcontractor first'} onClick={() => setCreating(true)}>New subcontract</Button>}
          />
        </div>
        {!list.data ? <Skeleton className="m-5 h-24" /> : list.data.length === 0 ? <EmptyState icon={HardHat} title="No subcontracts yet" /> : (
          <Table>
            <thead><tr><Th>Ref</Th><Th>Subcontractor</Th><Th>Project</Th><Th>Status</Th><Th right>Value</Th><Th right>Certified</Th><Th className="w-36">Progress</Th><Th right>Retention held</Th></tr></thead>
            <tbody>
              {list.data.map((s) => (
                <Tr key={s.id} onClick={() => setViewing(s.id)}>
                  <Td mono>{s.ref}</Td>
                  <Td className="font-medium">{s.supplierName}</Td>
                  <Td className="text-ink-2">{s.projectCode}</Td>
                  <Td><StatusBadge status={s.status} /></Td>
                  <Td right>{zar(s.contractValue)}</Td>
                  <Td right>{zar(s.certifiedToDate)}</Td>
                  <Td><div className="flex items-center gap-2"><Progress value={Number(s.percentComplete ?? 0)} /><span className="num w-10 text-right text-xs text-ink-2">{s.percentComplete ?? 0}%</span></div></Td>
                  <Td right className="text-ink-2">{zar(s.retentionHeld)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <NewSubcontract open={creating} onClose={() => setCreating(false)} subcontractors={subs} projects={projects} onSaved={(s) => { void list.reload(); setViewing(s.id); }} />
      <SubcontractDetail id={viewing} me={me} onClose={() => setViewing(null)} onChanged={() => void list.reload()} />
    </>
  );
}

function NewSubcontract({ open, onClose, subcontractors, projects, onSaved }: { open: boolean; onClose: () => void; subcontractors: Party[]; projects: Project[]; onSaved: (s: Subcontract) => void }) {
  const { codes, ensure } = useCostCodes();
  const blank = { projectId: '', supplierId: '', ref: '', scope: '', costCodeId: '', contractValue: '', retentionPct: '5', retentionLimitPct: '5', startDate: '', endDate: '' };
  const [f, setF] = useState(blank);
  useEffect(() => { if (open) setF(blank); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <FormDialog open={open} onClose={onClose} title="New subcontract" description="Starts as a draft. Activate it once signed; its value and retention terms are then fixed." submitLabel="Create subcontract" wide
      onSubmit={async () => onSaved(await api.procurement.addSubcontract({ ...f, startDate: f.startDate || null, endDate: f.endDate || null }))}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Project">
          <Select value={f.projectId} onChange={(e) => { ensure(e.target.value); setF({ ...f, projectId: e.target.value, costCodeId: '' }); }} required>
            <option value="">Choose…</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
          </Select>
        </Field>
        <Field label="Cost code">
          <Select value={f.costCodeId} onChange={set('costCodeId')} required disabled={!f.projectId}>
            <option value="">Choose…</option>
            {(codes[f.projectId] ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.description}</option>)}
          </Select>
        </Field>
        <Field label="Subcontractor">
          <Select value={f.supplierId} onChange={set('supplierId')} required>
            <option value="">Choose…</option>
            {subcontractors.map((s) => <option key={s.id} value={s.id}>{s.name}{s.cidbGrading ? ` · CIDB ${s.cidbGrading}` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Reference"><Input value={f.ref} onChange={set('ref')} required maxLength={30} placeholder="SC-01" /></Field>
        <Field label="Subcontract value (R, excl. VAT)"><AmountInput value={f.contractValue} onChange={(contractValue) => setF({ ...f, contractValue })} required /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Retention %"><Input inputMode="decimal" value={f.retentionPct} onChange={set('retentionPct')} pattern="\d{1,2}(\.\d{1,2})?" required /></Field>
          <Field label="Limit %"><Input inputMode="decimal" value={f.retentionLimitPct} onChange={set('retentionLimitPct')} pattern="\d{1,2}(\.\d{1,2})?" required /></Field>
        </div>
        <Field label="Start"><Input type="date" value={f.startDate} onChange={set('startDate')} /></Field>
        <Field label="End"><Input type="date" value={f.endDate} onChange={set('endDate')} /></Field>
      </div>
      <Field label="Scope of work"><Textarea rows={3} value={f.scope} onChange={set('scope')} required maxLength={2000} /></Field>
    </FormDialog>
  );
}

function SubcontractDetail({ id, me, onClose, onChanged }: { id: string | null; me: Me; onClose: () => void; onChanged: () => void }) {
  const [sc, setSc] = useState<Subcontract>();
  const [editingCert, setEditingCert] = useState<SubcontractCertificate | 'new' | null>(null);
  const [certifying, setCertifying] = useState<SubcontractCertificate | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAction();
  const canCertify = CERTIFIERS.includes(me.user.role);
  useEffect(() => { setSc(undefined); setNotice(null); if (id) void api.procurement.subcontract(id).then(setSc); }, [id]);
  const update = (s: Subcontract) => { setSc(s); onChanged(); };
  const openDraft = sc?.certificates?.find((c) => c.status === 'draft');

  return (
    <Dialog open={id !== null} onClose={onClose} title={sc ? `${sc.ref} · ${sc.supplierName}` : 'Subcontract'} description={sc ? `${sc.projectCode} · ${zar(sc.contractValue, true)} excl. VAT · retention ${Number(sc.retentionPct)}% to a limit of ${Number(sc.retentionLimitPct)}%` : undefined} wide>
      {!sc ? <Skeleton className="h-48" /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={sc.status} />
            <span className="text-xs text-ink-3">{sc.percentComplete ?? 0}% certified · {zar(sc.remaining)} remaining</span>
            <div className="ml-auto flex gap-1.5">
              {sc.status === 'draft' && <Button size="sm" icon={Play} loading={action.busy} onClick={() => void action.run(async () => update(await api.procurement.transitionSubcontract(sc.id, 'active')))}>Activate</Button>}
              {sc.status === 'active' && <Button size="sm" variant="secondary" icon={Plus} disabled={Boolean(openDraft)} onClick={() => setEditingCert('new')}>New certificate</Button>}
              {sc.status === 'active' && canCertify && <Button size="sm" variant="ghost" onClick={() => void action.run(async () => update(await api.procurement.transitionSubcontract(sc.id, 'completed')))}>Mark complete</Button>}
            </div>
          </div>
          <p className="whitespace-pre-wrap text-sm text-ink-2">{sc.scope}</p>
          {notice && <Alert tone="good">{notice}</Alert>}
          {action.error && <Alert>{action.error}</Alert>}
          {(sc.certificates?.length ?? 0) === 0 ? <EmptyState icon={BadgeCheck} title="No payment certificates yet" /> : (
            <div className="overflow-x-auto rounded-lg border border-line">
              <Table>
                <thead><tr><Th>No.</Th><Th>Period end</Th><Th>Status</Th><Th right>Work to date</Th><Th right>Retention</Th><Th right>Less previous</Th><Th right>Due</Th><Th /></tr></thead>
                <tbody>
                  {sc.certificates!.map((c) => (
                    <Tr key={c.id}>
                      <Td className="font-medium">{c.certNo}</Td>
                      <Td className="text-ink-2">{date(c.periodEnd)}</Td>
                      <Td><StatusBadge status={c.status} />{c.invoice && <div className="mt-1 text-xs text-ink-3">Invoice {c.invoice.invoiceNo} · {c.invoice.status}</div>}</Td>
                      <Td right>{zar(c.workDoneToDate, true)}</Td>
                      <Td right className="text-ink-2">{zar(c.retentionToDate, true)}</Td>
                      <Td right className="text-ink-2">{zar(c.previouslyCertified, true)}</Td>
                      <Td right className="font-semibold">{zar(c.amountDue, true)}</Td>
                      <Td className="text-right">
                        {c.status === 'draft' && (
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="ghost" icon={Pencil} aria-label="Edit" onClick={() => setEditingCert(c)} />
                            <Button size="sm" variant="ghost" icon={Trash2} aria-label="Delete" onClick={() => void action.run(async () => update(await api.procurement.deleteCertificate(sc.id, c.id)))} />
                            {canCertify && <Button size="sm" onClick={() => setCertifying(c)}>Certify</Button>}
                          </div>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
          <CertificateDialog sc={sc} cert={editingCert} onClose={() => setEditingCert(null)} onDone={update} />
          <CertifyDialog sc={sc} cert={certifying} onClose={() => setCertifying(null)} onDone={(s) => { update(s); setNotice('Certified. The subcontractor’s invoice is drafted under Finance › Payables for approval.'); }} />
        </div>
      )}
    </Dialog>
  );
}

function CertificateDialog({ sc, cert, onClose, onDone }: { sc: Subcontract; cert: SubcontractCertificate | 'new' | null; onClose: () => void; onDone: (s: Subcontract) => void }) {
  const existing = cert && cert !== 'new' ? cert : null;
  const [f, setF] = useState({ periodEnd: today(), workDoneToDate: '', notes: '' });
  useEffect(() => { if (cert) setF(existing ? { periodEnd: existing.periodEnd, workDoneToDate: existing.workDoneToDate, notes: existing.notes } : { periodEnd: today(), workDoneToDate: '', notes: '' }); }, [cert]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <FormDialog open={cert !== null} onClose={onClose} title={existing ? `Edit certificate ${existing.certNo}` : 'New payment certificate'} description="Enter the cumulative value of work done to date, as measured on site. Retention and the amount due are calculated." submitLabel="Save draft"
      onSubmit={async () => onDone(existing ? await api.procurement.updateCertificate(sc.id, existing.id, f) : await api.procurement.addCertificate(sc.id, { ...f, notes: f.notes || undefined }))}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Period end"><Input type="date" value={f.periodEnd} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} required /></Field>
        <Field label="Work done to date (R)" hint={`Certified so far ${zar(sc.certifiedToDate, true)}`}><AmountInput value={f.workDoneToDate} onChange={(workDoneToDate) => setF({ ...f, workDoneToDate })} required /></Field>
      </div>
      <Field label="Notes"><Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={2000} /></Field>
    </FormDialog>
  );
}

function CertifyDialog({ sc, cert, onClose, onDone }: { sc: Subcontract; cert: SubcontractCertificate | null; onClose: () => void; onDone: (s: Subcontract) => void }) {
  const [f, setF] = useState({ invoiceNo: '', invoiceDate: today() });
  useEffect(() => { if (cert) setF({ invoiceNo: '', invoiceDate: today() }); }, [cert]);
  return (
    <FormDialog open={cert !== null} onClose={onClose} title={cert ? `Certify payment certificate ${cert.certNo}` : ''}
      description={cert ? `${zar(cert.amountDue, true)} excl. VAT is due after ${zar(cert.retentionToDate, true)} retention. Certifying drafts the subcontractor’s invoice for approval under Payables. A certified certificate cannot change.` : undefined}
      submitLabel="Certify"
      onSubmit={async () => onDone(await api.procurement.certify(sc.id, cert!.id, { invoiceNo: f.invoiceNo || undefined, invoiceDate: f.invoiceDate }))}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Subcontractor's invoice no." hint={`Blank: ${sc.ref}-PC${cert?.certNo ?? ''}`}><Input value={f.invoiceNo} onChange={(e) => setF({ ...f, invoiceNo: e.target.value })} maxLength={60} /></Field>
        <Field label="Invoice date"><Input type="date" value={f.invoiceDate} onChange={(e) => setF({ ...f, invoiceDate: e.target.value })} required /></Field>
      </div>
    </FormDialog>
  );
}
