export type ModuleId =
  | 'mod_commercial'
  | 'mod_payroll'
  | 'mod_crm'
  | 'mod_finance'
  | 'mod_estimating'
  | 'mod_procurement'
  | 'mod_field'
  | 'mod_fleet'
  | 'mod_hse'
  | 'mod_portal'
  | 'mod_ai';

export type Role = 'owner' | 'admin' | 'project_manager' | 'site_foreman' | 'finance' | 'viewer';

export interface Me {
  user: { id: string; email: string; fullName: string; role: Role };
  tenant: { id: string; slug: string; name: string; tier: string };
  modules: ModuleId[];
}

export interface Project {
  id: string;
  code: string;
  name: string;
  status: string;
  contractForm: string | null;
  contractValue: string | null;
  retentionPct?: string;
  retentionLimitPct?: string;
  startDate?: string | null;
  plannedCompletion?: string | null;
  createdAt: string;
}

export interface DiaryEntry {
  id: string;
  entryDate: string;
  weather: string | null;
  workforceCount: number | null;
  workCompleted: string;
  delays: string;
  safetyNotes: string;
  deviceId: string | null;
  version: number;
  createdAt: string;
}

export interface FileRecord {
  id: string;
  projectId: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number;
  category: string;
  status: string;
  createdAt: string;
}

export interface AuditEvent {
  seq: number;
  occurredAt: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  payload: Record<string, unknown>;
}

export interface ChainVerification {
  intact: boolean;
  eventsChecked: number;
  firstBrokenSeq: number | null;
  headHash: string;
  verifiedAt: string;
}

export interface BoqResult {
  document_title: string | null;
  currency: string;
  sections: {
    name: string;
    items: { item_no: string; description: string; unit: string; quantity: string | null; rate: string | null; amount: string | null }[];
  }[];
  warnings: string[];
}

export interface DiaryReviewResult {
  summary: string;
  risks: { category: string; severity: 'low' | 'medium' | 'high'; finding: string; evidence_dates: string[]; recommendation: string }[];
}

export interface AiJob {
  id: string;
  kind: 'boq_extraction' | 'diary_risk_review';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  projectId: string | null;
  fileId: string | null;
  model: string | null;
  result: BoqResult | DiaryReviewResult | null;
  error: string | null;
  createdAt: string;
}

export type EstimateStage = 'intake' | 'technical_review' | 'client_approval' | 'baseline_locked' | 'rejected';
export type LineFlag = 'missing_internal' | 'missing_client' | 'qty_mismatch' | 'rate_variance' | 'under_recovery';

export interface EstimateSummary {
  clientTotal: string;
  internalTotal: string;
  margin: string;
  marginPct: string | null;
  leakage: string;
  lines: number;
  flaggedLines: number;
  flagCounts: Record<LineFlag, number>;
}

export interface EstimateLine {
  id: string;
  lineNo: string;
  description: string;
  unit: string;
  source: string;
  clientQty: string | null;
  clientRate: string | null;
  clientAmount: string | null;
  internalQty: string | null;
  internalRate: string | null;
  internalAmount: string | null;
  margin: string | null;
  flags: LineFlag[];
}

export interface EstimateHeader {
  id: string;
  ref: string;
  title: string;
  clientName: string;
  clientReference: string | null;
  stage: EstimateStage;
  projectId: string | null;
  clientApprovalRef: string | null;
  rejectionReason: string | null;
  baselineClientTotal: string | null;
  baselineInternalTotal: string | null;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
  summary: EstimateSummary;
}

export interface Estimate extends EstimateHeader {
  lines: EstimateLine[];
}

export interface LineInput {
  lineNo: string;
  description: string;
  unit: string;
  clientQty?: string | null;
  clientRate?: string | null;
  internalQty?: string | null;
  internalRate?: string | null;
}

export interface OrgUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  status: 'active' | 'invited' | 'deactivated';
  inviteExpiresAt: string | null;
  createdAt: string;
}

export interface InviteLink {
  inviteUrl: string;
  expiresAt: string;
  purpose?: 'invite' | 'reset';
}

export interface InviteInfo {
  purpose: 'invite' | 'reset';
  email: string;
  fullName: string;
  organisation: { name: string; id: string };
  expiresAt: string;
}

// ------------------------------------------------------------------ project controls

export type CostCategory = 'labour' | 'material' | 'plant' | 'subcontract' | 'overhead' | 'other';
export type VariationStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
export type ValuationStatus = 'draft' | 'submitted' | 'certified' | 'paid';

export interface CvrSummary {
  contractValue: string;
  approvedVariations: string;
  pendingVariations: string;
  revisedContractValue: string;
  originalBudget: string;
  revisedBudget: string;
  costToDate: string;
  committedCost: string;
  certifiedValue: string;
  retentionHeld: string;
  certifiedNet: string;
  paidToDate: string;
  marginToDate: string;
  marginToDatePct: string | null;
  forecastFinalCost: string;
  forecastMargin: string;
  forecastMarginPct: string | null;
  costCompletePct: string | null;
  valueCompletePct: string | null;
}

export interface CostCodeRow {
  id: string;
  code: string;
  description: string;
  budget: string;
  variationBudget: string;
  revisedBudget: string;
  cost: string;
  committed: string;
  costToComplete: string;
  forecastFinalCost: string;
  overrun: string;
  usedPct: string | null;
}

export interface CostEntryView {
  id: string;
  costCodeId: string;
  costCode: string | null;
  entryDate: string;
  category: CostCategory;
  description: string;
  amount: string;
  reference: string | null;
  source: string;
  reversesId: string | null;
  reversed: boolean;
  createdAt: string;
}

export interface VariationView {
  id: string;
  ref: string;
  title: string;
  description: string;
  instructionRef: string | null;
  status: VariationStatus;
  notifiedOn: string;
  timeBarDays: number | null;
  timeBarDaysLeft: number | null;
  valueClaimed: string;
  valueApproved: string | null;
  costEstimate: string;
  costCodeId: string | null;
  timeImpactDays: number;
  decisionNote: string | null;
  decidedAt: string | null;
}

export interface ValuationView {
  id: string;
  valuationNo: number;
  periodEnd: string;
  status: ValuationStatus;
  workDoneToDate: string;
  materialsOnSite: string;
  grossToDate: string;
  retentionPct: string;
  retentionToDate: string;
  netToDate: string;
  previouslyCertified: string;
  amountDue: string;
  certificateRef: string | null;
  notes: string;
  certifiedAt: string | null;
  paidOn: string | null;
}

export interface CvrMonth {
  month: string;
  cost: string;
  value: string;
}

export interface ProjectControls {
  project: Pick<Project, 'id' | 'code' | 'name' | 'status' | 'contractValue'> & {
    retentionPct: string;
    retentionLimitPct: string;
    startDate: string | null;
    plannedCompletion: string | null;
  };
  summary: CvrSummary;
  costCodes: CostCodeRow[];
  monthly: CvrMonth[];
  costs: CostEntryView[];
  variations: VariationView[];
  valuations: ValuationView[];
}

export interface Portfolio {
  projects: { project: Pick<Project, 'id' | 'code' | 'name' | 'status'>; summary: CvrSummary; overrunCodes: number }[];
  totals: CvrSummary;
  monthly: CvrMonth[];
}

export interface ProjectUpdate {
  name?: string;
  status?: string;
  contractForm?: string | null;
  contractValue?: string | null;
  retentionPct?: string;
  retentionLimitPct?: string;
  startDate?: string | null;
  plannedCompletion?: string | null;
}

// ------------------------------------------------------------------ general ledger

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface FinanceSettings {
  setUp: boolean;
  lockedThrough: string | null;
  vatRegistered: boolean;
  vatNumber: string | null;
  fiscalYearStartMonth: number;
}

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  systemKey: string | null;
  isBank: boolean;
  isActive: boolean;
  balance: string;
  hasPostings: boolean;
}

export interface JournalView {
  id: string;
  journalNo: number;
  entryDate: string;
  description: string;
  source: string;
  sourceId: string | null;
  reversesId: string | null;
  reversed: boolean;
  createdAt: string;
  lines: { id: string; accountId: string; accountCode?: string; accountName?: string; projectId: string | null; description: string | null; debit: string; credit: string }[];
}

export interface AccountLedger {
  account: Account;
  openingBalance: string;
  closingBalance: string;
  lines: { id: string; journalId: string; journalNo: number; entryDate: string; description: string; source: string; debit: string; credit: string; balance: string }[];
}

export interface Party {
  id: string;
  name: string;
  vatNumber: string | null;
  registrationNo: string | null;
  email: string | null;
  phone: string | null;
  paymentTermsDays: number;
  isActive: boolean;
  billingAddress?: string | null;
  bbbeeLevel?: number | null;
  bbbeeExpiry?: string | null;
  cidbGrading?: string | null;
  isSubcontractor?: boolean;
}

export type PartyInput = Partial<Omit<Party, 'id'>> & { name: string };

interface InvoiceBase {
  id: string;
  invoiceDate: string;
  dueDate: string;
  subtotal: string;
  vatTotal: string;
  total: string;
  amountPaid: string;
  notes: string;
  journalId: string | null;
  createdAt: string;
  payments?: { amount: string; paymentNo: number; paymentDate: string; reference: string | null }[];
}

export type SupplierInvoiceStatus = 'draft' | 'approved' | 'part_paid' | 'paid' | 'void';
export interface SupplierInvoiceLine {
  id?: string;
  description: string;
  amount: string;
  vatRate: string;
  vatAmount?: string;
  projectId: string | null;
  costCodeId: string | null;
  category: CostCategory | null;
  accountId: string | null;
}
export interface SupplierInvoice extends InvoiceBase {
  supplierId: string;
  supplierName: string;
  invoiceNo: string;
  status: SupplierInvoiceStatus;
  lines?: SupplierInvoiceLine[];
}

export type CustomerInvoiceStatus = 'draft' | 'issued' | 'part_paid' | 'paid' | 'void';
export interface CustomerInvoiceLine {
  id?: string;
  description: string;
  accountId: string;
  amount: string;
  vatRate: string;
  vatAmount?: string;
}
export interface CustomerInvoice extends InvoiceBase {
  customerId: string;
  customerName: string;
  invoiceNo: number | null;
  number: string;
  status: CustomerInvoiceStatus;
  projectId: string | null;
  valuationId: string | null;
  customerRef: string | null;
  lines?: CustomerInvoiceLine[];
  customer?: Party;
}

export interface PaymentView {
  id: string;
  direction: 'in' | 'out';
  number: string;
  partyName: string;
  bankName: string;
  paymentDate: string;
  amount: string;
  reference: string | null;
}

export interface BankWorkspace {
  account: { id: string; code: string; name: string };
  bookBalance: string;
  statementTotal: string;
  lastStatementDate: string | null;
  unmatchedStatement: { id: string; txnDate: string; description: string; reference: string | null; amount: string }[];
  unmatchedLedger: { id: string; entryDate: string; journalNo: number; description: string; amount: string }[];
  recentlyMatched: { id: string; txnDate: string; description: string; amount: string; matchedAt: string }[];
  outstanding: { inLedgerNotOnStatement: string; onStatementNotInLedger: string };
  reconciledBalance: string;
  imported?: number;
  duplicates?: number;
  matched?: number;
}

export interface ReportRow { id: string; code: string; name: string; amount: string }
export interface ReportSection { rows: ReportRow[]; total: string }
export interface TrialBalance { asAt: string; rows: { id: string; code: string; name: string; type: AccountType; debit: string; credit: string }[]; totalDebit: string; totalCredit: string; balanced: boolean }
export interface IncomeStatement { from: string; to: string; revenue: ReportSection; costOfSales: ReportSection; grossProfit: string; grossMarginPct: string | null; operatingExpenses: ReportSection; netProfit: string }
export interface BalanceSheet { asAt: string; assets: ReportSection; liabilities: ReportSection; equity: ReportSection & { accumulatedProfit: string }; liabilitiesAndEquity: string; balanced: boolean }
export type AgeBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus';
export type AgeRow = Record<AgeBucket | 'total', string>;
export interface Ageing { asAt: string; rows: (AgeRow & { partyId: string; partyName: string })[]; totals: AgeRow }
export interface VatReport { from: string; to: string; standardRatedSupplies: string; zeroRatedSupplies: string; outputVat: string; standardRatedPurchases: string; inputVat: string; netVat: string }

// ------------------------------------------------------------------ procurement

export type PoStatus = 'draft' | 'submitted' | 'approved' | 'closed' | 'cancelled';

export interface OrderLineInput {
  description: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  vatRate: string;
  projectId: string | null;
  costCodeId: string | null;
  category: CostCategory | null;
  accountId: string | null;
}

export interface OrderLine extends OrderLineInput {
  id: string;
  lineNo: number;
  amount: string;
  ordered: string;
  received: string;
  invoiced: string;
  toInvoice: string;
  outstanding: string;
  committed: string;
}

export interface PurchaseOrder {
  id: string;
  poNo: number;
  number: string;
  supplierId: string;
  supplierName: string;
  projectId: string | null;
  rfqId: string | null;
  status: PoStatus;
  orderDate: string;
  requiredBy: string | null;
  deliveryAddress: string | null;
  notes: string;
  subtotal: string;
  vatTotal: string;
  total: string;
  createdBy: string;
  approvedAt: string | null;
  closeReason: string | null;
  delivery?: 'none' | 'part_received' | 'received';
  lines?: OrderLine[];
  receipts?: { id: string; number: string; receivedOn: string; deliveryNote: string | null }[];
  invoices?: { id: string; invoiceNo: string; status: string; total: string; invoiceDate: string }[];
  committed?: string;
}

export interface Rfq {
  id: string;
  number: string;
  title: string;
  projectId: string | null;
  closingDate: string;
  status: 'open' | 'awarded' | 'cancelled';
  awardedQuoteId: string | null;
  awardNote: string | null;
  quotes: number | RfqQuote[];
  items?: { id: string; lineNo: number; description: string; unit: string; quantity: string }[];
  purchaseOrderId?: string;
}

export interface RfqQuote {
  id: string;
  supplierId: string;
  supplierName: string;
  bbbeeLevel: number | null;
  quoteRef: string | null;
  validUntil: string | null;
  leadTimeDays: number | null;
  notes: string;
  prices: Record<string, string>;
  total: string;
  complete: boolean;
  lowestOn: number;
  rank: number | null;
}

export interface SubcontractCertificate {
  id: string;
  certNo: number;
  periodEnd: string;
  status: 'draft' | 'certified';
  workDoneToDate: string;
  retentionToDate: string;
  netToDate: string;
  previouslyCertified: string;
  amountDue: string;
  notes: string;
  invoice: { id: string; status: string; invoiceNo: string } | null;
}

export interface Subcontract {
  id: string;
  projectId: string;
  projectCode: string;
  supplierId: string;
  supplierName: string;
  ref: string;
  scope: string;
  costCodeId: string;
  contractValue: string;
  retentionPct: string;
  retentionLimitPct: string;
  status: 'draft' | 'active' | 'completed' | 'terminated';
  startDate: string | null;
  endDate: string | null;
  certifiedToDate: string;
  retentionHeld: string;
  remaining: string;
  percentComplete: string | null;
  certificates?: SubcontractCertificate[];
  supplierInvoiceId?: string | null;
}

export interface BbbeeReport {
  from: string;
  to: string;
  suppliers: { supplierId: string; supplierName: string; level: number | null; expiry: string | null; spend: string; recognitionPct: number; recognised: string }[];
  byLevel: { level: string; spend: string; recognised: string }[];
  totalSpend: string;
  recognisedSpend: string;
  recognisedPct: string | null;
}

// ------------------------------------------------------------------ plant, HSE, quality

export type AssetStatus = 'available' | 'on_site' | 'under_maintenance' | 'broken_down' | 'disposed';
export type DueStatus = 'ok' | 'due_soon' | 'overdue';
export interface ComplianceIssue { kind: 'licence' | 'roadworthy' | 'load_test' | 'calibration'; expiry: string; daysLeft: number; status: 'expired' | 'expiring' }

export interface Asset {
  id: string;
  assetNo: string;
  name: string;
  category: string;
  make: string | null;
  model: string | null;
  serialNo: string | null;
  registration: string | null;
  year: number | null;
  ownership: 'owned' | 'hired_in';
  status: AssetStatus;
  currentProjectId: string | null;
  projectCode?: string | null;
  rateUnit: 'hour' | 'day';
  chargeRate: string;
  meterUnit: 'hours' | 'km' | 'none';
  meterReading: string;
  licenceExpiry: string | null;
  roadworthyExpiry: string | null;
  loadTestExpiry: string | null;
  calibrationExpiry: string | null;
  notes: string;
  compliance: ComplianceIssue[];
  maintenance?: DueStatus;
  utilisation30d: string | null;
  openWorkOrders?: number;
}

export interface WorkOrder {
  id: string;
  number: string;
  assetId: string;
  assetNo?: string;
  assetName?: string;
  planId: string | null;
  kind: 'service' | 'repair' | 'breakdown' | 'inspection';
  description: string;
  status: 'open' | 'in_progress' | 'completed' | 'cancelled';
  reportedOn: string;
  completedOn: string | null;
  workDone: string | null;
  labourCost: string;
  partsCost: string;
  downtimeHours: string;
}

export interface AssetDetail extends Asset {
  project: { code: string; name: string } | null;
  totals: { recovered: string; maintenanceCost: string; downtimeHours: string };
  allocations: { id: string; projectId: string | null; projectCode: string | null; movedOn: string; note: string | null }[];
  readings: { id: string; readOn: string; reading: string }[];
  usage: { id: string; projectCode: string; usedOn: string; quantity: string; rateUnit: string; amount: string; operatorName: string | null }[];
  plans: { id: string; description: string; intervalMeter: string | null; intervalDays: number | null; lastDoneOn: string | null; lastDoneMeter: string | null; isActive: boolean; due: { status: DueStatus; nextDueOn: string | null; nextDueMeter: string | null; daysRemaining: number | null; meterRemaining: string | null } }[];
  workOrders: WorkOrder[];
}

export type AssetInput = Partial<Pick<Asset, 'assetNo' | 'name' | 'category' | 'make' | 'model' | 'serialNo' | 'registration' | 'year' | 'ownership' | 'rateUnit' | 'chargeRate' | 'meterUnit' | 'licenceExpiry' | 'roadworthyExpiry' | 'loadTestExpiry' | 'calibrationExpiry' | 'notes'>>;

export type IncidentType = 'injury' | 'near_miss' | 'property_damage' | 'environmental' | 'dangerous_occurrence' | 'vehicle';
export type IncidentSeverity = 'none' | 'first_aid' | 'medical_treatment' | 'restricted_work' | 'lost_time' | 'fatality';

export interface CorrectiveAction {
  id: string;
  sourceType: 'incident' | 'ncr' | 'inspection';
  sourceId: string;
  projectCode?: string | null;
  action: string;
  ownerName: string;
  dueOn: string;
  status: 'open' | 'done';
  completedOn: string | null;
  completionNote: string | null;
  overdue: boolean;
}

export interface Incident {
  id: string;
  number: string;
  projectId: string | null;
  projectCode?: string | null;
  occurredAt: string;
  type: IncidentType;
  severity: IncidentSeverity;
  title: string;
  description: string;
  location: string | null;
  injuredPerson: string | null;
  daysLost: number;
  status: 'reported' | 'investigating' | 'closed';
  immediateCause: string | null;
  rootCause: string | null;
  dolReportable: boolean;
  dolReportedOn: string | null;
  coidaReportable: boolean;
  coidaReportedOn: string | null;
  actions?: CorrectiveAction[];
}

export interface IncidentInput {
  projectId?: string | null;
  occurredAt?: string;
  type?: IncidentType;
  severity?: IncidentSeverity;
  title?: string;
  description?: string;
  location?: string | null;
  injuredPerson?: string | null;
  daysLost?: number;
  immediateCause?: string | null;
  rootCause?: string | null;
}

export interface InspectionRecord {
  id: string;
  number: string;
  projectId: string | null;
  projectCode?: string | null;
  kind: 'safety' | 'quality' | 'plant_pre_use' | 'environmental';
  title: string;
  inspectedOn: string;
  inspectorName?: string;
  items: { item: string; result: 'pass' | 'fail' | 'na'; note?: string }[];
  failedItems: number;
  passed: boolean;
  notes: string;
}

export interface Ncr {
  id: string;
  number: string;
  projectId: string;
  projectCode?: string;
  inspectionId: string | null;
  title: string;
  description: string;
  category: string;
  severity: 'minor' | 'major' | 'critical';
  responsibleParty: string | null;
  supplierName?: string | null;
  raisedOn: string;
  dueOn: string | null;
  status: 'open' | 'action_proposed' | 'closed';
  rootCause: string | null;
  correctiveAction: string | null;
  reworkCost: string;
  raisedBy: string;
  closedOn: string | null;
  overdue: boolean;
  actions?: CorrectiveAction[];
}

export interface HseKpis {
  from: string;
  to: string;
  hoursPerShift: string;
  manHours: number;
  incidents: number;
  nearMisses: number;
  firstAid: number;
  recordable: number;
  lostTimeInjuries: number;
  fatalities: number;
  daysLost: number;
  ltifr: string | null;
  trifr: string | null;
  daysSinceLastLti: number | null;
  monthly: { month: string; incidents: number; nearMisses: number; recordable: number }[];
  openInvestigations: number;
  unreported: number;
  openActions: number;
  overdueActions: number;
  openNcrs: number;
  overdueNcrs: number;
}

// ------------------------------------------------------------------ HR & payroll

export interface EmployeeView {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  occupation: string;
  employmentType: 'permanent' | 'fixed_term' | 'casual';
  payBasis: 'monthly' | 'hourly';
  /** Only for payroll roles. */
  rate?: string;
  medicalAidMembers?: number;
  startDate: string;
  endDate: string | null;
  status: 'active' | 'terminated';
  terminationReason: string | null;
  defaultProjectId: string | null;
  phone: string | null;
  expiredCertifications?: string[];
  expiringCertifications?: string[];
}

export interface EmployeeDetail extends EmployeeView {
  private: { idNumber: string | null; passportNo: string | null; taxNumber: string | null; dateOfBirth: string } | null;
  certifications: { id: string; kind: string; certificateNo: string | null; issuedOn: string; expiresOn: string | null; expired: boolean }[];
  leave: LeaveRequest[];
  leaveBalances: { kind: 'annual' | 'sick' | 'family_responsibility'; cycleStart: string; entitlement: string; taken: string; balance: string }[];
}

export interface EmployeeInput {
  employeeNo?: string;
  firstName?: string;
  lastName?: string;
  occupation?: string;
  employmentType?: EmployeeView['employmentType'];
  payBasis?: EmployeeView['payBasis'];
  rate?: string;
  medicalAidMembers?: number;
  startDate?: string;
  phone?: string | null;
  private?: { idNumber?: string | null; passportNo?: string | null; taxNumber?: string | null; dateOfBirth?: string };
}

export interface LeaveRequest {
  id: string;
  employeeId: string;
  employeeName?: string;
  kind: 'annual' | 'sick' | 'family_responsibility' | 'unpaid';
  startsOn: string;
  endsOn: string;
  days: string;
  status: 'requested' | 'approved' | 'rejected' | 'cancelled';
  note: string | null;
  createdBy: string;
}

export interface TimeEntry {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNo: string;
  projectId: string;
  projectCode: string;
  costCode: string | null;
  workDate: string;
  normalHours: string;
  overtimeHours: string;
  sundayHours: string;
  status: 'submitted' | 'approved' | 'rejected';
  note: string | null;
  capturedBy: string;
}

export interface Payslip {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNo: string;
  occupation: string;
  earnings: { code: string; label: string; quantity: string; rate: string; amount: string }[];
  gross: string;
  paye: string;
  uifEmployee: string;
  otherDeductions: string;
  net: string;
  uifEmployer: string;
  sdl: string;
  employerCost: string;
  hoursWorked: string;
}

export interface PayRun {
  id: string;
  period: string;
  payDate: string;
  taxYear: string;
  status: 'draft' | 'finalised';
  grossTotal: string;
  payeTotal: string;
  uifTotal: string;
  sdlTotal: string;
  netTotal: string;
  journalId: string | null;
  finalisedAt: string | null;
  pendingTimesheets?: number;
  payslips?: Payslip[];
}

export interface PayrollSettings {
  sdlLiable: boolean;
  monthlyHours: string;
  payeReference: string | null;
  uifReference: string | null;
  taxTables: { taxYear: string; startsOn: string; endsOn: string; source: string }[];
}

export interface FormulaResult {
  ok: boolean;
  variables?: string[];
  result?: string | boolean;
  error?: string;
  position?: number;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'constructos.token';

export const session = {
  get token(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string) {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* storage unavailable */
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
  },
};

/** Calls any of the three services; paths start with /api, /sync or /ai. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  const token = session.token;
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string | string[]; detail?: unknown };
    const detail = typeof body.detail === 'string' ? body.detail : Array.isArray(body.detail) ? 'Invalid request' : undefined;
    const message = Array.isArray(body.message) ? body.message.join(', ') : body.message ?? detail ?? res.statusText;
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
/** Query string from the defined, non-empty values only. */
const qs = (q: Record<string, string | undefined>) => {
  const p = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => Boolean(e[1])));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  login: (tenant: string, email: string, password: string) =>
    post<{ accessToken: string }>('/api/v1/auth/login', { tenant, email, password }),
  me: () => request<Me>('/api/v1/me'),

  users: () => request<OrgUser[]>('/api/v1/users'),
  inviteUser: (body: { email: string; fullName: string; role: Role }) =>
    post<InviteLink & { user: Pick<OrgUser, 'id' | 'email' | 'fullName' | 'role'> }>('/api/v1/users/invite', body),
  userLink: (id: string) => post<InviteLink>(`/api/v1/users/${id}/link`, {}),
  updateUser: (id: string, body: { role?: Role; isActive?: boolean }) =>
    request<Pick<OrgUser, 'id' | 'role' | 'isActive'>>(`/api/v1/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  inviteInfo: (token: string) => request<InviteInfo>(`/api/v1/auth/invite/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, password: string) =>
    post<{ accessToken: string; organisation: { id: string; name: string } }>('/api/v1/auth/invite/accept', { token, password }),

  projects: () => request<Project[]>('/api/v1/projects'),
  createProject: (body: { code: string; name: string; contractForm?: string; contractValue?: string }) =>
    post<Project>('/api/v1/projects', body),

  diary: (projectId: string) => request<DiaryEntry[]>(`/api/v1/projects/${projectId}/diary`),
  createDiary: (projectId: string, body: Partial<DiaryEntry> & { id: string; entryDate: string }) =>
    post<DiaryEntry>(`/api/v1/projects/${projectId}/diary`, body),

  files: (projectId?: string) => request<FileRecord[]>(`/api/v1/files${projectId ? `?projectId=${projectId}` : ''}`),
  async uploadFile(file: File, category: string, projectId?: string): Promise<FileRecord> {
    const contentType = file.type || 'application/octet-stream';
    const slot = await post<{ fileId: string; uploadUrl: string; headers: Record<string, string> }>(
      '/api/v1/files/uploads',
      { filename: file.name, contentType, sizeBytes: file.size, category, projectId },
    );
    // Straight to S3 with the presigned URL; the bytes never pass through the API.
    const put = await fetch(slot.uploadUrl, { method: 'PUT', headers: slot.headers, body: file });
    if (!put.ok) throw new ApiError(put.status, 'Upload to storage failed');
    return post<FileRecord>(`/api/v1/files/${slot.fileId}/complete`, {});
  },
  downloadUrl: (fileId: string) => request<{ url: string }>(`/api/v1/files/${fileId}/download`),

  auditEvents: (beforeSeq?: number) =>
    request<AuditEvent[]>(`/api/v1/audit/events?limit=50${beforeSeq ? `&beforeSeq=${beforeSeq}` : ''}`),
  verifyAudit: () => request<ChainVerification>('/api/v1/audit/verify'),

  evaluateFormula: (formula: string, variables: Record<string, string | boolean>) =>
    post<FormulaResult>('/api/v1/formulas/evaluate', { formula, variables }),

  estimates: () => request<EstimateHeader[]>('/api/v1/estimates'),
  estimate: (id: string) => request<Estimate>(`/api/v1/estimates/${id}`),
  createEstimate: (body: { ref: string; title: string; clientName: string; clientReference?: string }) =>
    post<Estimate>('/api/v1/estimates', body),
  addLine: (id: string, body: LineInput) => post<Estimate>(`/api/v1/estimates/${id}/lines`, body),
  updateLine: (id: string, lineId: string, body: Partial<LineInput>) =>
    request<Estimate>(`/api/v1/estimates/${id}/lines/${lineId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteLine: (id: string, lineId: string) => request<Estimate>(`/api/v1/estimates/${id}/lines/${lineId}`, { method: 'DELETE' }),
  importAiLines: (id: string, jobId: string) => post<Estimate>(`/api/v1/estimates/${id}/import-ai`, { jobId }),
  transitionEstimate: (
    id: string,
    body: { to: EstimateStage; note?: string; clientApprovalRef?: string; acknowledgeVariance?: boolean },
  ) => post<Estimate>(`/api/v1/estimates/${id}/transition`, body),
  entityHistory: (entityType: string, entityId: string) =>
    request<AuditEvent[]>(`/api/v1/audit/events?entityType=${entityType}&entityId=${entityId}&limit=50`),

  updateProject: (id: string, body: ProjectUpdate) =>
    request<Project>(`/api/v1/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  controls: (projectId: string) => request<ProjectControls>(`/api/v1/projects/${projectId}/controls`),
  portfolio: () => request<Portfolio>('/api/v1/controls/portfolio'),
  addCostCode: (projectId: string, body: { code: string; description: string; budget: string }) =>
    post<ProjectControls>(`/api/v1/projects/${projectId}/cost-codes`, body),
  updateCostCode: (projectId: string, id: string, body: { code?: string; description?: string; budget?: string }) =>
    request<ProjectControls>(`/api/v1/projects/${projectId}/cost-codes/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteCostCode: (projectId: string, id: string) =>
    request<ProjectControls>(`/api/v1/projects/${projectId}/cost-codes/${id}`, { method: 'DELETE' }),
  budgetFromBaseline: (projectId: string) => post<ProjectControls>(`/api/v1/projects/${projectId}/cost-codes/from-baseline`, {}),
  addCost: (
    projectId: string,
    body: { costCodeId: string; entryDate: string; category: CostCategory; description: string; amount: string; reference?: string },
  ) => post<ProjectControls>(`/api/v1/projects/${projectId}/costs`, body),
  reverseCost: (projectId: string, id: string, reason: string) =>
    post<ProjectControls>(`/api/v1/projects/${projectId}/costs/${id}/reverse`, { reason }),
  addVariation: (
    projectId: string,
    body: {
      ref: string;
      title: string;
      description?: string;
      instructionRef?: string;
      notifiedOn: string;
      timeBarDays?: number | null;
      valueClaimed?: string;
      costEstimate?: string;
      costCodeId?: string | null;
      timeImpactDays?: number;
    },
  ) => post<ProjectControls>(`/api/v1/projects/${projectId}/variations`, body),
  transitionVariation: (projectId: string, id: string, body: { to: VariationStatus; valueApproved?: string; note?: string }) =>
    post<ProjectControls>(`/api/v1/projects/${projectId}/variations/${id}/transition`, body),
  addValuation: (projectId: string, body: { periodEnd: string; workDoneToDate: string; materialsOnSite?: string; notes?: string }) =>
    post<ProjectControls>(`/api/v1/projects/${projectId}/valuations`, body),
  updateValuation: (projectId: string, id: string, body: { periodEnd?: string; workDoneToDate?: string; materialsOnSite?: string; notes?: string }) =>
    request<ProjectControls>(`/api/v1/projects/${projectId}/valuations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  transitionValuation: (
    projectId: string,
    id: string,
    body: { to: ValuationStatus; certifiedWorkDone?: string; certificateRef?: string; paidOn?: string },
  ) => post<ProjectControls>(`/api/v1/projects/${projectId}/valuations/${id}/transition`, body),

  finance: {
    settings: () => request<FinanceSettings>('/api/v1/finance/settings'),
    setup: () => post<FinanceSettings>('/api/v1/finance/setup', {}),
    updateSettings: (body: Partial<Omit<FinanceSettings, 'setUp'>>) => patch<FinanceSettings>('/api/v1/finance/settings', body),

    accounts: () => request<Account[]>('/api/v1/finance/accounts'),
    addAccount: (body: { code: string; name: string; type: AccountType; isBank?: boolean }) => post<Account>('/api/v1/finance/accounts', body),
    updateAccount: (id: string, body: { code?: string; name?: string; isActive?: boolean }) => patch<Account>(`/api/v1/finance/accounts/${id}`, body),
    accountLedger: (id: string, from?: string, to?: string) => request<AccountLedger>(`/api/v1/finance/accounts/${id}/ledger${qs({ from, to })}`),

    journals: (q: { from?: string; to?: string; source?: string } = {}) => request<JournalView[]>(`/api/v1/finance/journals${qs(q)}`),
    addJournal: (body: { entryDate: string; description: string; lines: { accountId: string; debit?: string; credit?: string; description?: string; projectId?: string | null }[] }) =>
      post<JournalView>('/api/v1/finance/journals', body),
    reverseJournal: (id: string, reason: string, entryDate?: string) => post<JournalView>(`/api/v1/finance/journals/${id}/reverse`, { reason, entryDate }),

    suppliers: () => request<Party[]>('/api/v1/finance/suppliers'),
    addSupplier: (body: PartyInput) => post<Party>('/api/v1/finance/suppliers', body),
    updateSupplier: (id: string, body: Partial<PartyInput>) => patch<Party>(`/api/v1/finance/suppliers/${id}`, body),
    customers: () => request<Party[]>('/api/v1/finance/customers'),
    addCustomer: (body: PartyInput) => post<Party>('/api/v1/finance/customers', body),
    updateCustomer: (id: string, body: Partial<PartyInput>) => patch<Party>(`/api/v1/finance/customers/${id}`, body),

    supplierInvoices: (status?: string) => request<SupplierInvoice[]>(`/api/v1/finance/supplier-invoices${qs({ status })}`),
    supplierInvoice: (id: string) => request<SupplierInvoice>(`/api/v1/finance/supplier-invoices/${id}`),
    addSupplierInvoice: (body: { supplierId: string; invoiceNo: string; invoiceDate: string; dueDate?: string; notes?: string; lines: SupplierInvoiceLine[] }) =>
      post<SupplierInvoice>('/api/v1/finance/supplier-invoices', body),
    updateSupplierInvoice: (id: string, body: Partial<{ supplierId: string; invoiceNo: string; invoiceDate: string; dueDate: string; notes: string; lines: SupplierInvoiceLine[] }>) =>
      patch<SupplierInvoice>(`/api/v1/finance/supplier-invoices/${id}`, body),
    deleteSupplierInvoice: (id: string) => request<{ deleted: true }>(`/api/v1/finance/supplier-invoices/${id}`, { method: 'DELETE' }),
    approveSupplierInvoice: (id: string, matchOverrideReason?: string) =>
      post<SupplierInvoice>(`/api/v1/finance/supplier-invoices/${id}/approve`, matchOverrideReason ? { matchOverrideReason } : {}),
    voidSupplierInvoice: (id: string, reason: string) => post<SupplierInvoice>(`/api/v1/finance/supplier-invoices/${id}/void`, { reason }),

    customerInvoices: (status?: string) => request<CustomerInvoice[]>(`/api/v1/finance/customer-invoices${qs({ status })}`),
    customerInvoice: (id: string) => request<CustomerInvoice>(`/api/v1/finance/customer-invoices/${id}`),
    addCustomerInvoice: (body: { customerId: string; invoiceDate: string; dueDate?: string; projectId?: string | null; customerRef?: string | null; notes?: string; lines: CustomerInvoiceLine[] }) =>
      post<CustomerInvoice>('/api/v1/finance/customer-invoices', body),
    invoiceValuation: (body: { valuationId: string; customerId: string; invoiceDate?: string }) =>
      post<CustomerInvoice>('/api/v1/finance/customer-invoices/from-valuation', body),
    updateCustomerInvoice: (id: string, body: Partial<{ customerId: string; invoiceDate: string; dueDate: string; customerRef: string | null; notes: string; lines: CustomerInvoiceLine[] }>) =>
      patch<CustomerInvoice>(`/api/v1/finance/customer-invoices/${id}`, body),
    deleteCustomerInvoice: (id: string) => request<{ deleted: true }>(`/api/v1/finance/customer-invoices/${id}`, { method: 'DELETE' }),
    issueCustomerInvoice: (id: string) => post<CustomerInvoice>(`/api/v1/finance/customer-invoices/${id}/issue`, {}),
    voidCustomerInvoice: (id: string, reason: string) => post<CustomerInvoice>(`/api/v1/finance/customer-invoices/${id}/void`, { reason }),

    payments: (direction?: 'in' | 'out') => request<PaymentView[]>(`/api/v1/finance/payments${qs({ direction })}`),
    addPayment: (body: { direction: 'in' | 'out'; partyId: string; bankAccountId: string; paymentDate: string; reference?: string; allocations: { invoiceId: string; amount: string }[] }) =>
      post<PaymentView>('/api/v1/finance/payments', body),

    bank: (accountId: string) => request<BankWorkspace>(`/api/v1/finance/bank/${accountId}`),
    importStatement: (accountId: string, lines: { txnDate: string; description: string; reference?: string; amount: string }[]) =>
      post<BankWorkspace>(`/api/v1/finance/bank/${accountId}/import`, { lines }),
    autoMatch: (accountId: string) => post<BankWorkspace>(`/api/v1/finance/bank/${accountId}/auto-match`, {}),
    match: (lineId: string, journalLineId: string) => post<BankWorkspace>(`/api/v1/finance/bank/lines/${lineId}/match`, { journalLineId }),
    unmatch: (lineId: string) => post<BankWorkspace>(`/api/v1/finance/bank/lines/${lineId}/unmatch`, {}),
    postStatementLine: (lineId: string, accountId: string, description?: string) => post<BankWorkspace>(`/api/v1/finance/bank/lines/${lineId}/post`, { accountId, description }),

    trialBalance: (asAt?: string) => request<TrialBalance>(`/api/v1/finance/reports/trial-balance${qs({ asAt })}`),
    incomeStatement: (from?: string, to?: string) => request<IncomeStatement>(`/api/v1/finance/reports/income-statement${qs({ from, to })}`),
    balanceSheet: (asAt?: string) => request<BalanceSheet>(`/api/v1/finance/reports/balance-sheet${qs({ asAt })}`),
    agedReceivables: (asAt?: string) => request<Ageing>(`/api/v1/finance/reports/aged-receivables${qs({ asAt })}`),
    agedPayables: (asAt?: string) => request<Ageing>(`/api/v1/finance/reports/aged-payables${qs({ asAt })}`),
    vat: (from?: string, to?: string) => request<VatReport>(`/api/v1/finance/reports/vat${qs({ from, to })}`),
  },

  procurement: {
    settings: () => request<{ pmApprovalLimit: string; priceTolerancePct: string }>('/api/v1/procurement/settings'),
    updateSettings: (body: { pmApprovalLimit?: string; priceTolerancePct?: string }) => patch<{ pmApprovalLimit: string; priceTolerancePct: string }>('/api/v1/procurement/settings', body),
    suppliers: () => request<Party[]>('/api/v1/procurement/suppliers'),
    addSupplier: (body: PartyInput) => post<Party>('/api/v1/procurement/suppliers', body),
    updateSupplier: (id: string, body: Partial<PartyInput>) => patch<Party>(`/api/v1/procurement/suppliers/${id}`, body),
    costCodes: (projectId: string) => request<{ id: string; code: string; description: string }[]>(`/api/v1/procurement/projects/${projectId}/cost-codes`),
    accounts: () => request<{ id: string; code: string; name: string; type: AccountType; systemKey: string | null }[]>('/api/v1/procurement/accounts'),

    orders: (q: { status?: string; projectId?: string } = {}) => request<PurchaseOrder[]>(`/api/v1/procurement/purchase-orders${qs(q)}`),
    order: (id: string) => request<PurchaseOrder>(`/api/v1/procurement/purchase-orders/${id}`),
    addOrder: (body: { supplierId: string; projectId?: string | null; orderDate: string; requiredBy?: string | null; deliveryAddress?: string | null; notes?: string; lines: OrderLineInput[] }) =>
      post<PurchaseOrder>('/api/v1/procurement/purchase-orders', body),
    updateOrder: (id: string, body: Partial<{ supplierId: string; projectId: string | null; orderDate: string; requiredBy: string | null; deliveryAddress: string | null; notes: string; lines: OrderLineInput[] }>) =>
      patch<PurchaseOrder>(`/api/v1/procurement/purchase-orders/${id}`, body),
    deleteOrder: (id: string) => request<{ deleted: true }>(`/api/v1/procurement/purchase-orders/${id}`, { method: 'DELETE' }),
    transitionOrder: (id: string, to: PoStatus, reason?: string) => post<PurchaseOrder>(`/api/v1/procurement/purchase-orders/${id}/transition`, { to, reason }),
    receive: (id: string, body: { receivedOn: string; deliveryNote?: string; notes?: string; lines: { poLineId: string; quantity: string }[] }) =>
      post<PurchaseOrder>(`/api/v1/procurement/purchase-orders/${id}/receive`, body),
    invoiceOrder: (id: string, body: { invoiceNo: string; invoiceDate: string; lines: { poLineId: string; quantity: string; unitPrice?: string }[] }) =>
      post<PurchaseOrder & { invoiceId: string }>(`/api/v1/procurement/purchase-orders/${id}/invoice`, body),

    rfqs: () => request<Rfq[]>('/api/v1/procurement/rfqs'),
    rfq: (id: string) => request<Rfq & { quotes: RfqQuote[] }>(`/api/v1/procurement/rfqs/${id}`),
    addRfq: (body: { title: string; projectId?: string | null; closingDate: string; items: { description: string; unit: string; quantity: string }[] }) =>
      post<Rfq & { quotes: RfqQuote[] }>('/api/v1/procurement/rfqs', body),
    addQuote: (id: string, body: { supplierId: string; quoteRef?: string; validUntil?: string; leadTimeDays?: number; notes?: string; prices: Record<string, string> }) =>
      post<Rfq & { quotes: RfqQuote[] }>(`/api/v1/procurement/rfqs/${id}/quotes`, body),
    removeQuote: (id: string, quoteId: string) => request<Rfq & { quotes: RfqQuote[] }>(`/api/v1/procurement/rfqs/${id}/quotes/${quoteId}`, { method: 'DELETE' }),
    award: (id: string, body: { quoteId: string; note?: string; costCodeId?: string | null; category?: CostCategory; accountId?: string | null }) =>
      post<Rfq & { quotes: RfqQuote[] }>(`/api/v1/procurement/rfqs/${id}/award`, body),
    cancelRfq: (id: string, reason: string) => post<Rfq & { quotes: RfqQuote[] }>(`/api/v1/procurement/rfqs/${id}/cancel`, { reason }),

    subcontracts: () => request<Subcontract[]>('/api/v1/procurement/subcontracts'),
    subcontract: (id: string) => request<Subcontract>(`/api/v1/procurement/subcontracts/${id}`),
    addSubcontract: (body: { projectId: string; supplierId: string; ref: string; scope: string; costCodeId: string; contractValue: string; retentionPct?: string; retentionLimitPct?: string; startDate?: string | null; endDate?: string | null }) =>
      post<Subcontract>('/api/v1/procurement/subcontracts', body),
    transitionSubcontract: (id: string, to: 'active' | 'completed' | 'terminated') => post<Subcontract>(`/api/v1/procurement/subcontracts/${id}/transition`, { to }),
    addCertificate: (id: string, body: { periodEnd: string; workDoneToDate: string; notes?: string }) => post<Subcontract>(`/api/v1/procurement/subcontracts/${id}/certificates`, body),
    updateCertificate: (id: string, certId: string, body: { periodEnd?: string; workDoneToDate?: string; notes?: string }) =>
      patch<Subcontract>(`/api/v1/procurement/subcontracts/${id}/certificates/${certId}`, body),
    deleteCertificate: (id: string, certId: string) => request<Subcontract>(`/api/v1/procurement/subcontracts/${id}/certificates/${certId}`, { method: 'DELETE' }),
    certify: (id: string, certId: string, body: { invoiceNo?: string; invoiceDate?: string }) => post<Subcontract>(`/api/v1/procurement/subcontracts/${id}/certificates/${certId}/certify`, body),

    bbbee: (from?: string, to?: string) => request<BbbeeReport>(`/api/v1/procurement/reports/bbbee${qs({ from, to })}`),
  },

  plant: {
    assets: () => request<Asset[]>('/api/v1/plant/assets'),
    asset: (id: string) => request<AssetDetail>(`/api/v1/plant/assets/${id}`),
    addAsset: (body: AssetInput) => post<AssetDetail>('/api/v1/plant/assets', body),
    updateAsset: (id: string, body: AssetInput) => patch<AssetDetail>(`/api/v1/plant/assets/${id}`, body),
    move: (id: string, body: { projectId: string | null; movedOn: string; note?: string }) => post<AssetDetail>(`/api/v1/plant/assets/${id}/move`, body),
    meter: (id: string, body: { readOn: string; reading: string }) => post<AssetDetail>(`/api/v1/plant/assets/${id}/meter`, body),
    usage: (id: string, body: { projectId: string; costCodeId: string; usedOn: string; quantity: string; operatorName?: string; note?: string }) =>
      post<AssetDetail>(`/api/v1/plant/assets/${id}/usage`, body),
    dispose: (id: string, body: { disposedOn: string; reason: string }) => post<AssetDetail>(`/api/v1/plant/assets/${id}/dispose`, body),
    costCodes: (projectId: string) => request<{ id: string; code: string; description: string }[]>(`/api/v1/plant/projects/${projectId}/cost-codes`),
    addPlan: (id: string, body: { description: string; intervalMeter?: string | null; intervalDays?: number | null; lastDoneOn?: string | null; lastDoneMeter?: string | null }) =>
      post<AssetDetail>(`/api/v1/plant/assets/${id}/plans`, body),
    updatePlan: (planId: string, body: { isActive?: boolean }) => patch<AssetDetail>(`/api/v1/plant/plans/${planId}`, body),
    workOrders: () => request<WorkOrder[]>('/api/v1/plant/work-orders'),
    addWorkOrder: (id: string, body: { kind: WorkOrder['kind']; description: string; reportedOn: string; planId?: string | null }) =>
      post<AssetDetail>(`/api/v1/plant/assets/${id}/work-orders`, body),
    startWorkOrder: (woId: string) => post<AssetDetail>(`/api/v1/plant/work-orders/${woId}/start`, {}),
    completeWorkOrder: (woId: string, body: { completedOn: string; workDone: string; meterAtCompletion?: string | null; labourCost?: string; partsCost?: string; downtimeHours?: string }) =>
      post<AssetDetail>(`/api/v1/plant/work-orders/${woId}/complete`, body),
    cancelWorkOrder: (woId: string) => post<AssetDetail>(`/api/v1/plant/work-orders/${woId}/cancel`, {}),
  },

  hse: {
    kpis: (q: { from?: string; to?: string; projectId?: string } = {}) => request<HseKpis>(`/api/v1/hse/kpis${qs(q)}`),
    incidents: () => request<Incident[]>('/api/v1/hse/incidents'),
    incident: (id: string) => request<Incident>(`/api/v1/hse/incidents/${id}`),
    report: (body: IncidentInput) => post<Incident>('/api/v1/hse/incidents', body),
    updateIncident: (id: string, body: IncidentInput) => patch<Incident>(`/api/v1/hse/incidents/${id}`, body),
    transitionIncident: (id: string, to: 'investigating' | 'closed') => post<Incident>(`/api/v1/hse/incidents/${id}/transition`, { to }),
    markReported: (id: string, authority: 'dol' | 'coida', reportedOn: string) => post<Incident>(`/api/v1/hse/incidents/${id}/reported`, { authority, reportedOn }),
    talks: () => request<{ id: string; projectCode: string; heldOn: string; topic: string; presenter: string; attendees: number; notes: string }[]>('/api/v1/hse/toolbox-talks'),
    addTalk: (body: { projectId: string; heldOn: string; topic: string; presenter: string; attendees: number; notes?: string }) => post<unknown>('/api/v1/hse/toolbox-talks', body),
    inspections: () => request<InspectionRecord[]>('/api/v1/hse/inspections'),
    addInspection: (body: { projectId?: string | null; assetId?: string | null; kind: InspectionRecord['kind']; title: string; inspectedOn: string; items: InspectionRecord['items']; notes?: string }) =>
      post<InspectionRecord>('/api/v1/hse/inspections', body),
    ncrs: () => request<Ncr[]>('/api/v1/hse/ncrs'),
    ncr: (id: string) => request<Ncr>(`/api/v1/hse/ncrs/${id}`),
    raiseNcr: (body: Partial<Ncr> & { projectId: string; title: string; description: string; category: string; severity: Ncr['severity']; raisedOn: string }) =>
      post<Ncr>('/api/v1/hse/ncrs', body),
    updateNcr: (id: string, body: Partial<Pick<Ncr, 'title' | 'description' | 'responsibleParty' | 'dueOn' | 'rootCause' | 'correctiveAction' | 'reworkCost'>>) => patch<Ncr>(`/api/v1/hse/ncrs/${id}`, body),
    transitionNcr: (id: string, to: 'action_proposed' | 'closed') => post<Ncr>(`/api/v1/hse/ncrs/${id}/transition`, { to }),
    actions: (status?: 'open' | 'done') => request<CorrectiveAction[]>(`/api/v1/hse/actions${qs({ status })}`),
    addAction: (body: { sourceType: CorrectiveAction['sourceType']; sourceId: string; action: string; ownerName: string; dueOn: string }) => post<CorrectiveAction>('/api/v1/hse/actions', body),
    completeAction: (id: string, completedOn: string, note?: string) => post<CorrectiveAction>(`/api/v1/hse/actions/${id}/complete`, { completedOn, note }),
  },

  payroll: {
    employees: () => request<EmployeeView[]>('/api/v1/payroll/employees'),
    employee: (id: string) => request<EmployeeDetail>(`/api/v1/payroll/employees/${id}`),
    addEmployee: (body: EmployeeInput) => post<EmployeeDetail>('/api/v1/payroll/employees', body),
    updateEmployee: (id: string, body: EmployeeInput) => patch<EmployeeDetail>(`/api/v1/payroll/employees/${id}`, body),
    terminate: (id: string, endDate: string, reason: string) => post<EmployeeDetail>(`/api/v1/payroll/employees/${id}/terminate`, { endDate, reason }),
    addCertification: (id: string, body: { kind: string; certificateNo?: string | null; issuedOn: string; expiresOn?: string | null }) =>
      post<EmployeeDetail>(`/api/v1/payroll/employees/${id}/certifications`, body),
    removeCertification: (certId: string) => request<EmployeeDetail>(`/api/v1/payroll/certifications/${certId}`, { method: 'DELETE' }),
    leave: () => request<LeaveRequest[]>('/api/v1/payroll/leave'),
    requestLeave: (body: { employeeId: string; kind: LeaveRequest['kind']; startsOn: string; endsOn: string; note?: string }) => post<LeaveRequest>('/api/v1/payroll/leave', body),
    decideLeave: (id: string, decision: 'approved' | 'rejected', note?: string) => post<LeaveRequest>(`/api/v1/payroll/leave/${id}/decide`, { decision, note }),
    cancelLeave: (id: string) => post<LeaveRequest>(`/api/v1/payroll/leave/${id}/cancel`, {}),
    costCodes: (projectId: string) => request<{ id: string; code: string; description: string }[]>(`/api/v1/payroll/projects/${projectId}/cost-codes`),
    timesheets: (q: { from?: string; to?: string; projectId?: string; status?: string } = {}) => request<TimeEntry[]>(`/api/v1/payroll/timesheets${qs(q)}`),
    captureTime: (entries: { employeeId: string; projectId: string; costCodeId: string; workDate: string; normalHours?: string; overtimeHours?: string; sundayHours?: string; note?: string }[]) =>
      post<{ captured: number }>('/api/v1/payroll/timesheets', { entries }),
    approveTime: (ids: string[]) => post<{ approved: number; skipped: number }>('/api/v1/payroll/timesheets/approve', { ids }),
    rejectTime: (ids: string[]) => post<{ rejected: number; skipped: number }>('/api/v1/payroll/timesheets/reject', { ids }),
    deleteTime: (id: string) => request<{ deleted: true }>(`/api/v1/payroll/timesheets/${id}`, { method: 'DELETE' }),
    settings: () => request<PayrollSettings>('/api/v1/payroll/settings'),
    updateSettings: (body: Partial<Omit<PayrollSettings, 'taxTables'>>) => patch<PayrollSettings>('/api/v1/payroll/settings', body),
    runs: () => request<PayRun[]>('/api/v1/payroll/pay-runs'),
    run: (id: string) => request<PayRun>(`/api/v1/payroll/pay-runs/${id}`),
    createRun: (period: string, payDate: string) => post<PayRun>('/api/v1/payroll/pay-runs', { period, payDate }),
    recalculate: (id: string) => post<PayRun>(`/api/v1/payroll/pay-runs/${id}/recalculate`, {}),
    finalise: (id: string) => post<PayRun>(`/api/v1/payroll/pay-runs/${id}/finalise`, {}),
    emp201: (id: string) => request<{ period: string; payeReference: string | null; paye: string; uif: string; sdl: string; eti: string; total: string; dueOn: string; note: string }>(`/api/v1/payroll/pay-runs/${id}/emp201`),
  },

  aiJobs: () => request<AiJob[]>('/ai/v1/jobs'),
  aiJob: (id: string) => request<AiJob>(`/ai/v1/jobs/${id}`),
  createAiJob: (body: { kind: AiJob['kind']; fileId?: string; projectId?: string }) => post<AiJob>('/ai/v1/jobs', body),
};

export const zar = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' });
/** Display only. Never use for arithmetic. */
export const formatZar = (v: string | null | undefined) => (v ? zar.format(Number(v)) : '—');
export const label = (s: string) => s.replace(/_/g, ' ');
