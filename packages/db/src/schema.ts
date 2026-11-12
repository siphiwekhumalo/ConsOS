/**
 * Drizzle table definitions — a typed mirror of migrations/*.sql.
 * The SQL migrations are the source of truth (they carry RLS policies, roles
 * and functions that Drizzle does not model); keep this file in sync with them.
 */
import {
  bigint,
  boolean,
  customType,
  date,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const tenantTier = pgEnum('tenant_tier', ['standard', 'mid_market', 'enterprise']);

export const userRole = pgEnum('user_role', [
  'owner',
  'admin',
  'project_manager',
  'site_foreman',
  'finance',
  'viewer',
]);

export const projectStatus = pgEnum('project_status', [
  'tender',
  'awarded',
  'active',
  'practical_completion',
  'final_account',
  'closed',
]);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  tier: tenantTier('tier').notNull().default('standard'),
  activeModules: text('active_modules').array().notNull().default([]),
  ...timestamps,
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  email: text('email').notNull(),
  fullName: text('full_name').notNull(),
  passwordHash: text('password_hash'), // NULL until the user accepts their invite
  role: userRole('role').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
});

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  status: projectStatus('status').notNull().default('tender'),
  contractForm: text('contract_form'),
  // numeric comes back as a string — never convert money to a JS float.
  contractValue: numeric('contract_value', { precision: 18, scale: 2 }),
  retentionPct: numeric('retention_pct', { precision: 5, scale: 2 }).notNull().default('5'),
  retentionLimitPct: numeric('retention_limit_pct', { precision: 5, scale: 2 }).notNull().default('5'),
  startDate: date('start_date'),
  plannedCompletion: date('planned_completion'),
  ...timestamps,
});

export const auditEvents = pgTable('audit_events', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  actorUserId: uuid('actor_user_id'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
});

export const fileStatus = pgEnum('file_status', ['pending', 'uploaded', 'rejected']);

export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  projectId: uuid('project_id'),
  objectKey: text('object_key').notNull(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  category: text('category').notNull().default('general'),
  status: fileStatus('status').notNull().default('pending'),
  uploadedBy: uuid('uploaded_by').notNull(),
  ...timestamps,
});

export const weatherCondition = pgEnum('weather_condition', [
  'clear',
  'cloudy',
  'rain',
  'storm',
  'wind',
  'extreme_heat',
]);

export const siteDiaryEntries = pgTable('site_diary_entries', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  projectId: uuid('project_id').notNull(),
  entryDate: date('entry_date').notNull(),
  weather: weatherCondition('weather'),
  workforceCount: integer('workforce_count'),
  workCompleted: text('work_completed').notNull().default(''),
  delays: text('delays').notNull().default(''),
  safetyNotes: text('safety_notes').notNull().default(''),
  createdBy: uuid('created_by').notNull(),
  deviceId: text('device_id'),
  clientRecordedAt: timestamp('client_recorded_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
  changeSeq: bigint('change_seq', { mode: 'number' }).notNull().default(0),
  ...timestamps,
});

export const aiJobStatus = pgEnum('ai_job_status', ['queued', 'running', 'succeeded', 'failed']);

export const aiJobs = pgTable('ai_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind').notNull(),
  status: aiJobStatus('status').notNull().default('queued'),
  projectId: uuid('project_id'),
  fileId: uuid('file_id'),
  requestedBy: uuid('requested_by').notNull(),
  model: text('model'),
  result: jsonb('result'),
  error: text('error'),
  ...timestamps,
});

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const userInvites = pgTable('user_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  purpose: text('purpose').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const estimateStage = pgEnum('estimate_stage', [
  'intake',
  'technical_review',
  'client_approval',
  'baseline_locked',
  'rejected',
]);

export const estimates = pgTable('estimates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  ref: text('ref').notNull(),
  title: text('title').notNull(),
  clientName: text('client_name').notNull(),
  clientReference: text('client_reference'),
  stage: estimateStage('stage').notNull().default('intake'),
  projectId: uuid('project_id'),
  sourceFileId: uuid('source_file_id'),
  clientApprovalRef: text('client_approval_ref'),
  rejectionReason: text('rejection_reason'),
  baselineClientTotal: numeric('baseline_client_total', { precision: 18, scale: 2 }),
  baselineInternalTotal: numeric('baseline_internal_total', { precision: 18, scale: 2 }),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedBy: uuid('locked_by'),
  createdBy: uuid('created_by').notNull(),
  ...timestamps,
});

export const estimateLines = pgTable('estimate_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  estimateId: uuid('estimate_id').notNull(),
  lineNo: text('line_no').notNull(),
  description: text('description').notNull(),
  unit: text('unit').notNull(),
  clientQty: numeric('client_qty', { precision: 18, scale: 3 }),
  clientRate: numeric('client_rate', { precision: 18, scale: 2 }),
  internalQty: numeric('internal_qty', { precision: 18, scale: 3 }),
  internalRate: numeric('internal_rate', { precision: 18, scale: 2 }),
  source: text('source').notNull().default('manual'),
  ...timestamps,
});

// ---------------------------------------------------------------- project controls (0007)

export const costCodes = pgTable('cost_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  projectId: uuid('project_id').notNull(),
  code: text('code').notNull(),
  description: text('description').notNull(),
  budget: numeric('budget', { precision: 18, scale: 2 }).notNull().default('0'),
  ...timestamps,
});

export const costCategory = pgEnum('cost_category', ['labour', 'material', 'plant', 'subcontract', 'overhead', 'other']);

export const costEntries = pgTable('cost_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  projectId: uuid('project_id').notNull(),
  costCodeId: uuid('cost_code_id').notNull(),
  entryDate: date('entry_date').notNull(),
  category: costCategory('category').notNull(),
  description: text('description').notNull(),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  reference: text('reference'),
  source: text('source').notNull().default('manual'),
  sourceId: uuid('source_id'),
  reversesId: uuid('reverses_id'),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const variationStatus = pgEnum('variation_status', ['draft', 'submitted', 'approved', 'rejected']);

export const variations = pgTable('variations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  projectId: uuid('project_id').notNull(),
  ref: text('ref').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  instructionRef: text('instruction_ref'),
  status: variationStatus('status').notNull().default('draft'),
  notifiedOn: date('notified_on').notNull(),
  timeBarDays: integer('time_bar_days'),
  valueClaimed: numeric('value_claimed', { precision: 18, scale: 2 }).notNull().default('0'),
  valueApproved: numeric('value_approved', { precision: 18, scale: 2 }),
  costEstimate: numeric('cost_estimate', { precision: 18, scale: 2 }).notNull().default('0'),
  costCodeId: uuid('cost_code_id'),
  timeImpactDays: integer('time_impact_days').notNull().default(0),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedBy: uuid('decided_by'),
  decisionNote: text('decision_note'),
  createdBy: uuid('created_by').notNull(),
  ...timestamps,
});

export const valuationStatus = pgEnum('valuation_status', ['draft', 'submitted', 'certified', 'paid']);

export const valuations = pgTable('valuations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  projectId: uuid('project_id').notNull(),
  valuationNo: integer('valuation_no').notNull(),
  periodEnd: date('period_end').notNull(),
  status: valuationStatus('status').notNull().default('draft'),
  workDoneToDate: numeric('work_done_to_date', { precision: 18, scale: 2 }).notNull(),
  materialsOnSite: numeric('materials_on_site', { precision: 18, scale: 2 }).notNull().default('0'),
  grossToDate: numeric('gross_to_date', { precision: 18, scale: 2 }).notNull(),
  retentionPct: numeric('retention_pct', { precision: 5, scale: 2 }).notNull(),
  retentionToDate: numeric('retention_to_date', { precision: 18, scale: 2 }).notNull(),
  netToDate: numeric('net_to_date', { precision: 18, scale: 2 }).notNull(),
  previouslyCertified: numeric('previously_certified', { precision: 18, scale: 2 }).notNull().default('0'),
  amountDue: numeric('amount_due', { precision: 18, scale: 2 }).notNull(),
  certificateRef: text('certificate_ref'),
  notes: text('notes').notNull().default(''),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  certifiedAt: timestamp('certified_at', { withTimezone: true }),
  certifiedBy: uuid('certified_by'),
  paidOn: date('paid_on'),
  createdBy: uuid('created_by').notNull(),
  ...timestamps,
});

// ---------------------------------------------------------------- general ledger (0008)

export const financeSettings = pgTable('finance_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  lockedThrough: date('locked_through'),
  vatRegistered: boolean('vat_registered').notNull().default(true),
  vatNumber: text('vat_number'),
  fiscalYearStartMonth: integer('fiscal_year_start_month').notNull().default(3),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accountType = pgEnum('account_type', ['asset', 'liability', 'equity', 'income', 'expense']);

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  type: accountType('type').notNull(),
  systemKey: text('system_key'),
  isBank: boolean('is_bank').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
});

export const journalSource = pgEnum('journal_source', ['manual', 'supplier_invoice', 'customer_invoice', 'payment', 'bank', 'reversal', 'void', 'payroll']);

export const journals = pgTable('journals', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  journalNo: integer('journal_no').notNull(),
  entryDate: date('entry_date').notNull(),
  description: text('description').notNull(),
  source: journalSource('source').notNull(),
  sourceId: uuid('source_id'),
  reversesId: uuid('reverses_id'),
  postedBy: uuid('posted_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const journalLines = pgTable('journal_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  journalId: uuid('journal_id').notNull(),
  accountId: uuid('account_id').notNull(),
  projectId: uuid('project_id'),
  description: text('description'),
  debit: numeric('debit', { precision: 18, scale: 2 }).notNull().default('0'),
  credit: numeric('credit', { precision: 18, scale: 2 }).notNull().default('0'),
});

const party = {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  vatNumber: text('vat_number'),
  registrationNo: text('registration_no'),
  email: text('email'),
  phone: text('phone'),
  paymentTermsDays: integer('payment_terms_days').notNull().default(30),
  isActive: boolean('is_active').notNull().default(true),
};

export const suppliers = pgTable('suppliers', {
  ...party,
  bbbeeLevel: integer('bbbee_level'),
  bbbeeExpiry: date('bbbee_expiry'),
  cidbGrading: text('cidb_grading'),
  isSubcontractor: boolean('is_subcontractor').notNull().default(false),
  ...timestamps,
});
export const customers = pgTable('customers', { ...party, billingAddress: text('billing_address'), ...timestamps });

export const supplierInvoiceStatus = pgEnum('supplier_invoice_status', ['draft', 'approved', 'part_paid', 'paid', 'void']);

export const supplierInvoices = pgTable('supplier_invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  supplierId: uuid('supplier_id').notNull(),
  invoiceNo: text('invoice_no').notNull(),
  invoiceDate: date('invoice_date').notNull(),
  dueDate: date('due_date').notNull(),
  status: supplierInvoiceStatus('status').notNull().default('draft'),
  subtotal: numeric('subtotal', { precision: 18, scale: 2 }).notNull().default('0'),
  vatTotal: numeric('vat_total', { precision: 18, scale: 2 }).notNull().default('0'),
  total: numeric('total', { precision: 18, scale: 2 }).notNull().default('0'),
  amountPaid: numeric('amount_paid', { precision: 18, scale: 2 }).notNull().default('0'),
  notes: text('notes').notNull().default(''),
  sourceFileId: uuid('source_file_id'),
  journalId: uuid('journal_id'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedBy: uuid('approved_by'),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidJournalId: uuid('void_journal_id'),
  poId: uuid('po_id'),
  matchOverrideReason: text('match_override_reason'),
  subcontractCertificateId: uuid('subcontract_certificate_id'),
  createdBy: uuid('created_by').notNull(),
  ...timestamps,
});

export const supplierInvoiceLines = pgTable('supplier_invoice_lines', {
  poLineId: uuid('po_line_id'),
  quantity: numeric('quantity', { precision: 18, scale: 3 }),
  unitPrice: numeric('unit_price', { precision: 18, scale: 2 }),
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  lineNo: integer('line_no').notNull(),
  description: text('description').notNull(),
  projectId: uuid('project_id'),
  costCodeId: uuid('cost_code_id'),
  category: costCategory('category'),
  accountId: uuid('account_id'),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  vatRate: numeric('vat_rate', { precision: 5, scale: 2 }).notNull().default('15'),
  vatAmount: numeric('vat_amount', { precision: 18, scale: 2 }).notNull().default('0'),
});

export const customerInvoiceStatus = pgEnum('customer_invoice_status', ['draft', 'issued', 'part_paid', 'paid', 'void']);

export const customerInvoices = pgTable('customer_invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  invoiceNo: integer('invoice_no'),
  invoiceDate: date('invoice_date').notNull(),
  dueDate: date('due_date').notNull(),
  status: customerInvoiceStatus('status').notNull().default('draft'),
  projectId: uuid('project_id'),
  valuationId: uuid('valuation_id'),
  customerRef: text('customer_ref'),
  subtotal: numeric('subtotal', { precision: 18, scale: 2 }).notNull().default('0'),
  vatTotal: numeric('vat_total', { precision: 18, scale: 2 }).notNull().default('0'),
  total: numeric('total', { precision: 18, scale: 2 }).notNull().default('0'),
  amountPaid: numeric('amount_paid', { precision: 18, scale: 2 }).notNull().default('0'),
  notes: text('notes').notNull().default(''),
  journalId: uuid('journal_id'),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  issuedBy: uuid('issued_by'),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidJournalId: uuid('void_journal_id'),
  createdBy: uuid('created_by').notNull(),
  ...timestamps,
});

export const customerInvoiceLines = pgTable('customer_invoice_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  lineNo: integer('line_no').notNull(),
  description: text('description').notNull(),
  accountId: uuid('account_id').notNull(),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  vatRate: numeric('vat_rate', { precision: 5, scale: 2 }).notNull().default('15'),
  vatAmount: numeric('vat_amount', { precision: 18, scale: 2 }).notNull().default('0'),
});

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  direction: text('direction').notNull(),
  paymentNo: integer('payment_no').notNull(),
  supplierId: uuid('supplier_id'),
  customerId: uuid('customer_id'),
  bankAccountId: uuid('bank_account_id').notNull(),
  paymentDate: date('payment_date').notNull(),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  reference: text('reference'),
  journalId: uuid('journal_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const paymentAllocations = pgTable('payment_allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  paymentId: uuid('payment_id').notNull(),
  supplierInvoiceId: uuid('supplier_invoice_id'),
  customerInvoiceId: uuid('customer_invoice_id'),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
});

export const bankStatementLines = pgTable('bank_statement_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  bankAccountId: uuid('bank_account_id').notNull(),
  txnDate: date('txn_date').notNull(),
  description: text('description').notNull(),
  reference: text('reference'),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  externalId: text('external_id').notNull(),
  matchedLineId: uuid('matched_line_id'),
  matchedAt: timestamp('matched_at', { withTimezone: true }),
  matchedBy: uuid('matched_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------- procurement (0009)

export const procurementSettings = pgTable('procurement_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  pmApprovalLimit: numeric('pm_approval_limit', { precision: 18, scale: 2 }).notNull().default('50000'),
  priceTolerancePct: numeric('price_tolerance_pct', { precision: 5, scale: 2 }).notNull().default('0'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rfqStatus = pgEnum('rfq_status', ['open', 'awarded', 'cancelled']);

export const rfqs = pgTable('rfqs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  rfqNo: integer('rfq_no').notNull(),
  projectId: uuid('project_id'),
  title: text('title').notNull(),
  closingDate: date('closing_date').notNull(),
  status: rfqStatus('status').notNull().default('open'),
  awardedQuoteId: uuid('awarded_quote_id'),
  awardNote: text('award_note'),
  createdBy: uuid('created_by').notNull(),
  ...timestamps,
});

export const rfqItems = pgTable('rfq_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  rfqId: uuid('rfq_id').notNull(),
  lineNo: integer('line_no').notNull(),
  description: text('description').notNull(),
  unit: text('unit').notNull(),
  quantity: numeric('quantity', { precision: 18, scale: 3 }).notNull(),
});

export const rfqQuotes = pgTable('rfq_quotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  rfqId: uuid('rfq_id').notNull(),
  supplierId: uuid('supplier_id').notNull(),
  quoteRef: text('quote_ref'),
  validUntil: date('valid_until'),
  leadTimeDays: integer('lead_time_days'),
  notes: text('notes').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rfqQuotePrices = pgTable('rfq_quote_prices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  quoteId: uuid('quote_id').notNull(),
  itemId: uuid('item_id').notNull(),
  unitPrice: numeric('unit_price', { precision: 18, scale: 2 }).notNull(),
});

export const poStatus = pgEnum('po_status', ['draft', 'submitted', 'approved', 'closed', 'cancelled']);

export const purchaseOrders = pgTable('purchase_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  poNo: integer('po_no').notNull(),
  supplierId: uuid('supplier_id').notNull(),
  projectId: uuid('project_id'),
  rfqId: uuid('rfq_id'),
  status: poStatus('status').notNull().default('draft'),
  orderDate: date('order_date').notNull(),
  requiredBy: date('required_by'),
  deliveryAddress: text('delivery_address'),
  notes: text('notes').notNull().default(''),
  subtotal: numeric('subtotal', { precision: 18, scale: 2 }).notNull().default('0'),
  vatTotal: numeric('vat_total', { precision: 18, scale: 2 }).notNull().default('0'),
  total: numeric('total', { precision: 18, scale: 2 }).notNull().default('0'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedBy: uuid('approved_by'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closeReason: text('close_reason'),
  createdBy: uuid('created_by').notNull(),
  ...timestamps,
});

export const purchaseOrderLines = pgTable('purchase_order_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  poId: uuid('po_id').notNull(),
  lineNo: integer('line_no').notNull(),
  description: text('description').notNull(),
  unit: text('unit').notNull(),
  quantity: numeric('quantity', { precision: 18, scale: 3 }).notNull(),
  unitPrice: numeric('unit_price', { precision: 18, scale: 2 }).notNull(),
  vatRate: numeric('vat_rate', { precision: 5, scale: 2 }).notNull().default('15'),
  projectId: uuid('project_id'),
  costCodeId: uuid('cost_code_id'),
  category: costCategory('category'),
  accountId: uuid('account_id'),
});

export const goodsReceipts = pgTable('goods_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  grnNo: integer('grn_no').notNull(),
  poId: uuid('po_id').notNull(),
  receivedOn: date('received_on').notNull(),
  deliveryNote: text('delivery_note'),
  notes: text('notes').notNull().default(''),
  receivedBy: uuid('received_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const goodsReceiptLines = pgTable('goods_receipt_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  receiptId: uuid('receipt_id').notNull(),
  poLineId: uuid('po_line_id').notNull(),
  quantity: numeric('quantity', { precision: 18, scale: 3 }).notNull(),
});

export const subcontractStatus = pgEnum('subcontract_status', ['draft', 'active', 'completed', 'terminated']);

export const subcontracts = pgTable('subcontracts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  projectId: uuid('project_id').notNull(),
  supplierId: uuid('supplier_id').notNull(),
  ref: text('ref').notNull(),
  scope: text('scope').notNull(),
  costCodeId: uuid('cost_code_id').notNull(),
  contractValue: numeric('contract_value', { precision: 18, scale: 2 }).notNull(),
  retentionPct: numeric('retention_pct', { precision: 5, scale: 2 }).notNull().default('5'),
  retentionLimitPct: numeric('retention_limit_pct', { precision: 5, scale: 2 }).notNull().default('5'),
  status: subcontractStatus('status').notNull().default('draft'),
  startDate: date('start_date'),
  endDate: date('end_date'),
  createdBy: uuid('created_by').notNull(),
  ...timestamps,
});

export const subcontractCertStatus = pgEnum('subcontract_cert_status', ['draft', 'certified']);

export const subcontractCertificates = pgTable('subcontract_certificates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  subcontractId: uuid('subcontract_id').notNull(),
  certNo: integer('cert_no').notNull(),
  periodEnd: date('period_end').notNull(),
  status: subcontractCertStatus('status').notNull().default('draft'),
  workDoneToDate: numeric('work_done_to_date', { precision: 18, scale: 2 }).notNull(),
  retentionToDate: numeric('retention_to_date', { precision: 18, scale: 2 }).notNull(),
  netToDate: numeric('net_to_date', { precision: 18, scale: 2 }).notNull(),
  previousGross: numeric('previous_gross', { precision: 18, scale: 2 }).notNull().default('0'),
  previousRetention: numeric('previous_retention', { precision: 18, scale: 2 }).notNull().default('0'),
  previouslyCertified: numeric('previously_certified', { precision: 18, scale: 2 }).notNull().default('0'),
  amountDue: numeric('amount_due', { precision: 18, scale: 2 }).notNull(),
  supplierInvoiceId: uuid('supplier_invoice_id'),
  certifiedAt: timestamp('certified_at', { withTimezone: true }),
  certifiedBy: uuid('certified_by'),
  notes: text('notes').notNull().default(''),
  createdBy: uuid('created_by').notNull(),
  ...timestamps,
});

// ---------------------------------------------------------------- plant, HSE, quality (0010)

export const assetCategory = pgEnum('asset_category', ['earthmoving', 'lifting', 'vehicle', 'generator', 'compressor', 'scaffolding', 'tools', 'other']);
export const assetStatus = pgEnum('asset_status', ['available', 'on_site', 'under_maintenance', 'broken_down', 'disposed']);

export const assets = pgTable('assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  assetNo: text('asset_no').notNull(),
  name: text('name').notNull(),
  category: assetCategory('category').notNull(),
  make: text('make'),
  model: text('model'),
  serialNo: text('serial_no'),
  registration: text('registration'),
  year: integer('year'),
  ownership: text('ownership').notNull().default('owned'),
  hiredFromId: uuid('hired_from_id'),
  status: assetStatus('status').notNull().default('available'),
  currentProjectId: uuid('current_project_id'),
  rateUnit: text('rate_unit').notNull().default('day'),
  chargeRate: numeric('charge_rate', { precision: 18, scale: 2 }).notNull().default('0'),
  meterUnit: text('meter_unit').notNull().default('none'),
  meterReading: numeric('meter_reading', { precision: 12, scale: 1 }).notNull().default('0'),
  purchaseDate: date('purchase_date'),
  purchaseValue: numeric('purchase_value', { precision: 18, scale: 2 }),
  licenceExpiry: date('licence_expiry'),
  roadworthyExpiry: date('roadworthy_expiry'),
  loadTestExpiry: date('load_test_expiry'),
  calibrationExpiry: date('calibration_expiry'),
  notes: text('notes').notNull().default(''),
  disposedOn: date('disposed_on'),
  ...timestamps,
});

export const assetAllocations = pgTable('asset_allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  assetId: uuid('asset_id').notNull(),
  projectId: uuid('project_id'),
  movedOn: date('moved_on').notNull(),
  note: text('note'),
  movedBy: uuid('moved_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const assetMeterReadings = pgTable('asset_meter_readings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  assetId: uuid('asset_id').notNull(),
  readOn: date('read_on').notNull(),
  reading: numeric('reading', { precision: 12, scale: 1 }).notNull(),
  recordedBy: uuid('recorded_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const plantUsage = pgTable('plant_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  assetId: uuid('asset_id').notNull(),
  projectId: uuid('project_id').notNull(),
  costCodeId: uuid('cost_code_id').notNull(),
  usedOn: date('used_on').notNull(),
  quantity: numeric('quantity', { precision: 8, scale: 2 }).notNull(),
  rateUnit: text('rate_unit').notNull(),
  rate: numeric('rate', { precision: 18, scale: 2 }).notNull(),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  operatorName: text('operator_name'),
  note: text('note'),
  costEntryId: uuid('cost_entry_id'),
  recordedBy: uuid('recorded_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const maintenancePlans = pgTable('maintenance_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  assetId: uuid('asset_id').notNull(),
  description: text('description').notNull(),
  intervalMeter: numeric('interval_meter', { precision: 12, scale: 1 }),
  intervalDays: integer('interval_days'),
  lastDoneOn: date('last_done_on'),
  lastDoneMeter: numeric('last_done_meter', { precision: 12, scale: 1 }),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
});

export const workOrderStatus = pgEnum('work_order_status', ['open', 'in_progress', 'completed', 'cancelled']);

export const workOrders = pgTable('work_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  woNo: integer('wo_no').notNull(),
  assetId: uuid('asset_id').notNull(),
  planId: uuid('plan_id'),
  kind: text('kind').notNull(),
  description: text('description').notNull(),
  status: workOrderStatus('status').notNull().default('open'),
  reportedOn: date('reported_on').notNull(),
  completedOn: date('completed_on'),
  meterAtCompletion: numeric('meter_at_completion', { precision: 12, scale: 1 }),
  workDone: text('work_done'),
  labourCost: numeric('labour_cost', { precision: 18, scale: 2 }).notNull().default('0'),
  partsCost: numeric('parts_cost', { precision: 18, scale: 2 }).notNull().default('0'),
  downtimeHours: numeric('downtime_hours', { precision: 8, scale: 1 }).notNull().default('0'),
  createdBy: uuid('created_by').notNull(),
  ...timestamps,
});

export const incidentType = pgEnum('incident_type', ['injury', 'near_miss', 'property_damage', 'environmental', 'dangerous_occurrence', 'vehicle']);
export const incidentSeverity = pgEnum('incident_severity', ['none', 'first_aid', 'medical_treatment', 'restricted_work', 'lost_time', 'fatality']);
export const incidentStatus = pgEnum('incident_status', ['reported', 'investigating', 'closed']);

export const incidents = pgTable('incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  incidentNo: integer('incident_no').notNull(),
  projectId: uuid('project_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  type: incidentType('type').notNull(),
  severity: incidentSeverity('severity').notNull().default('none'),
  title: text('title').notNull(),
  description: text('description').notNull(),
  location: text('location'),
  injuredPerson: text('injured_person'),
  daysLost: integer('days_lost').notNull().default(0),
  assetId: uuid('asset_id'),
  status: incidentStatus('status').notNull().default('reported'),
  immediateCause: text('immediate_cause'),
  rootCause: text('root_cause'),
  dolReportable: boolean('dol_reportable').notNull().default(false),
  dolReportedOn: date('dol_reported_on'),
  coidaReportable: boolean('coida_reportable').notNull().default(false),
  coidaReportedOn: date('coida_reported_on'),
  reportedBy: uuid('reported_by').notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: uuid('closed_by'),
  ...timestamps,
});

export const toolboxTalks = pgTable('toolbox_talks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  projectId: uuid('project_id').notNull(),
  heldOn: date('held_on').notNull(),
  topic: text('topic').notNull(),
  presenter: text('presenter').notNull(),
  attendees: integer('attendees').notNull(),
  notes: text('notes').notNull().default(''),
  recordedBy: uuid('recorded_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const inspectionKind = pgEnum('inspection_kind', ['safety', 'quality', 'plant_pre_use', 'environmental']);

export type InspectionItem = { item: string; result: 'pass' | 'fail' | 'na'; note?: string };

export const inspections = pgTable('inspections', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  inspectionNo: integer('inspection_no').notNull(),
  projectId: uuid('project_id'),
  assetId: uuid('asset_id'),
  kind: inspectionKind('kind').notNull(),
  title: text('title').notNull(),
  inspectedOn: date('inspected_on').notNull(),
  inspector: uuid('inspector').notNull(),
  items: jsonb('items').$type<InspectionItem[]>().notNull(),
  failedItems: integer('failed_items').notNull(),
  passed: boolean('passed').notNull(),
  notes: text('notes').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ncrStatus = pgEnum('ncr_status', ['open', 'action_proposed', 'closed']);

export const ncrs = pgTable('ncrs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  ncrNo: integer('ncr_no').notNull(),
  projectId: uuid('project_id').notNull(),
  inspectionId: uuid('inspection_id'),
  title: text('title').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  severity: text('severity').notNull(),
  responsibleParty: text('responsible_party'),
  supplierId: uuid('supplier_id'),
  raisedOn: date('raised_on').notNull(),
  dueOn: date('due_on'),
  status: ncrStatus('status').notNull().default('open'),
  rootCause: text('root_cause'),
  correctiveAction: text('corrective_action'),
  reworkCost: numeric('rework_cost', { precision: 18, scale: 2 }).notNull().default('0'),
  verifiedBy: uuid('verified_by'),
  closedOn: date('closed_on'),
  raisedBy: uuid('raised_by').notNull(),
  ...timestamps,
});

export const correctiveActions = pgTable('corrective_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id').notNull(),
  projectId: uuid('project_id'),
  action: text('action').notNull(),
  ownerName: text('owner_name').notNull(),
  dueOn: date('due_on').notNull(),
  status: text('status').notNull().default('open'),
  completedOn: date('completed_on'),
  completionNote: text('completion_note'),
  createdBy: uuid('created_by').notNull(),
  ...timestamps,
});

export const hseSettings = pgTable('hse_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  hoursPerShift: numeric('hours_per_shift', { precision: 4, scale: 1 }).notNull().default('9'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------- HR & payroll (0011)

export type TaxBracket = { from: number; base: number; rate: number };

export const taxTables = pgTable('tax_tables', {
  taxYear: text('tax_year').primaryKey(),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on').notNull(),
  brackets: jsonb('brackets').$type<TaxBracket[]>().notNull(),
  primaryRebate: numeric('primary_rebate', { precision: 12, scale: 2 }).notNull(),
  secondaryRebate: numeric('secondary_rebate', { precision: 12, scale: 2 }).notNull(),
  tertiaryRebate: numeric('tertiary_rebate', { precision: 12, scale: 2 }).notNull(),
  uifCeilingMonthly: numeric('uif_ceiling_monthly', { precision: 12, scale: 2 }).notNull(),
  medicalCreditMain: numeric('medical_credit_main', { precision: 12, scale: 2 }).notNull(),
  medicalCreditFirstDep: numeric('medical_credit_first_dep', { precision: 12, scale: 2 }).notNull(),
  medicalCreditAdditional: numeric('medical_credit_additional', { precision: 12, scale: 2 }).notNull(),
  source: text('source').notNull(),
});

export const payrollSettings = pgTable('payroll_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  sdlLiable: boolean('sdl_liable').notNull().default(true),
  monthlyHours: numeric('monthly_hours', { precision: 5, scale: 1 }).notNull().default('195'),
  payeReference: text('paye_reference'),
  uifReference: text('uif_reference'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const employees = pgTable('employees', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  employeeNo: text('employee_no').notNull(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  occupation: text('occupation').notNull(),
  employmentType: text('employment_type').notNull(),
  payBasis: text('pay_basis').notNull(),
  rate: numeric('rate', { precision: 12, scale: 2 }).notNull(),
  medicalAidMembers: integer('medical_aid_members').notNull().default(0),
  startDate: date('start_date').notNull(),
  endDate: date('end_date'),
  status: text('status').notNull().default('active'),
  terminationReason: text('termination_reason'),
  defaultProjectId: uuid('default_project_id'),
  phone: text('phone'),
  ...timestamps,
});

export const employeePrivate = pgTable('employee_private', {
  employeeId: uuid('employee_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  idNumber: text('id_number'),
  passportNo: text('passport_no'),
  taxNumber: text('tax_number'),
  dateOfBirth: date('date_of_birth').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const certifications = pgTable('certifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  kind: text('kind').notNull(),
  certificateNo: text('certificate_no'),
  issuedOn: date('issued_on').notNull(),
  expiresOn: date('expires_on'),
  fileId: uuid('file_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const payRuns = pgTable('pay_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  period: text('period').notNull(),
  payDate: date('pay_date').notNull(),
  taxYear: text('tax_year').notNull(),
  status: text('status').notNull().default('draft'),
  grossTotal: numeric('gross_total', { precision: 18, scale: 2 }).notNull().default('0'),
  payeTotal: numeric('paye_total', { precision: 18, scale: 2 }).notNull().default('0'),
  uifTotal: numeric('uif_total', { precision: 18, scale: 2 }).notNull().default('0'),
  sdlTotal: numeric('sdl_total', { precision: 18, scale: 2 }).notNull().default('0'),
  netTotal: numeric('net_total', { precision: 18, scale: 2 }).notNull().default('0'),
  journalId: uuid('journal_id'),
  finalisedAt: timestamp('finalised_at', { withTimezone: true }),
  finalisedBy: uuid('finalised_by'),
  createdBy: uuid('created_by').notNull(),
  ...timestamps,
});

export const timeEntries = pgTable('time_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  projectId: uuid('project_id').notNull(),
  costCodeId: uuid('cost_code_id'),
  workDate: date('work_date').notNull(),
  normalHours: numeric('normal_hours', { precision: 4, scale: 2 }).notNull().default('0'),
  overtimeHours: numeric('overtime_hours', { precision: 4, scale: 2 }).notNull().default('0'),
  sundayHours: numeric('sunday_hours', { precision: 4, scale: 2 }).notNull().default('0'),
  status: text('status').notNull().default('submitted'),
  note: text('note'),
  capturedBy: uuid('captured_by').notNull(),
  approvedBy: uuid('approved_by'),
  ...timestamps,
});

export const leaveRequests = pgTable('leave_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  kind: text('kind').notNull(),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on').notNull(),
  days: numeric('days', { precision: 5, scale: 1 }).notNull(),
  status: text('status').notNull().default('requested'),
  note: text('note'),
  decidedBy: uuid('decided_by'),
  createdBy: uuid('created_by').notNull(),
  ...timestamps,
});

export type PayslipEarning = { code: string; label: string; quantity: string; rate: string; amount: string };

export const payslips = pgTable('payslips', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  payRunId: uuid('pay_run_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  earnings: jsonb('earnings').$type<PayslipEarning[]>().notNull(),
  gross: numeric('gross', { precision: 12, scale: 2 }).notNull(),
  paye: numeric('paye', { precision: 12, scale: 2 }).notNull(),
  uifEmployee: numeric('uif_employee', { precision: 12, scale: 2 }).notNull(),
  otherDeductions: numeric('other_deductions', { precision: 12, scale: 2 }).notNull().default('0'),
  net: numeric('net', { precision: 12, scale: 2 }).notNull(),
  uifEmployer: numeric('uif_employer', { precision: 12, scale: 2 }).notNull(),
  sdl: numeric('sdl', { precision: 12, scale: 2 }).notNull(),
  employerCost: numeric('employer_cost', { precision: 12, scale: 2 }).notNull(),
  hoursWorked: numeric('hours_worked', { precision: 8, scale: 2 }).notNull().default('0'),
});

export type TaxTable = typeof taxTables.$inferSelect;
export type Employee = typeof employees.$inferSelect;

export type Asset = typeof assets.$inferSelect;
export type Incident = typeof incidents.$inferSelect;

export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type PurchaseOrderLine = typeof purchaseOrderLines.$inferSelect;
export type Subcontract = typeof subcontracts.$inferSelect;
export type SubcontractCertificate = typeof subcontractCertificates.$inferSelect;

export type Account = typeof accounts.$inferSelect;
export type AccountType = (typeof accountType.enumValues)[number];
export type Journal = typeof journals.$inferSelect;
export type JournalLine = typeof journalLines.$inferSelect;
export type SupplierInvoice = typeof supplierInvoices.$inferSelect;
export type SupplierInvoiceLine = typeof supplierInvoiceLines.$inferSelect;
export type CustomerInvoice = typeof customerInvoices.$inferSelect;
export type CustomerInvoiceLine = typeof customerInvoiceLines.$inferSelect;

export type CostCode = typeof costCodes.$inferSelect;
export type CostEntry = typeof costEntries.$inferSelect;
export type Variation = typeof variations.$inferSelect;
export type VariationStatus = (typeof variationStatus.enumValues)[number];
export type Valuation = typeof valuations.$inferSelect;
export type ValuationStatus = (typeof valuationStatus.enumValues)[number];

export type Estimate = typeof estimates.$inferSelect;
export type EstimateLine = typeof estimateLines.$inferSelect;
export type EstimateStage = (typeof estimateStage.enumValues)[number];

export type Tenant = typeof tenants.$inferSelect;
export type SiteDiaryEntry = typeof siteDiaryEntries.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type FileRecord = typeof files.$inferSelect;
export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type UserRole = (typeof userRole.enumValues)[number];
