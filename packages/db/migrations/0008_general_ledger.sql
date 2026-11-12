-- =============================================================================
-- 0008 — Core finance (Finance & CVR module): general ledger, accounts payable,
-- accounts receivable, payments and bank reconciliation.
--
-- Double-entry rules enforced IN THE DATABASE (not only the API):
--   * journals and journal lines are append-only (corrections are reversals);
--   * every journal balances (debits = credits) and has at least two lines,
--     checked at COMMIT by deferred constraint triggers;
--   * nothing can be posted on or before the tenant's locked-through date;
--   * invoices freeze once approved/issued: only payment status may change;
--   * a bank statement line can only be matched to a ledger line on the same
--     bank account for the same amount, and each ledger line only once.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Per-tenant document numbering (journals, invoices, payments)
-- ---------------------------------------------------------------------------
CREATE TABLE doc_counters (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  kind      text NOT NULL CHECK (kind IN ('journal', 'customer_invoice', 'payment_in', 'payment_out')),
  next_no   integer NOT NULL,
  PRIMARY KEY (tenant_id, kind)
);

CREATE FUNCTION next_doc_no(p_kind text) RETURNS integer
  LANGUAGE sql
AS $$
  INSERT INTO doc_counters (tenant_id, kind, next_no) VALUES (current_tenant_id(), p_kind, 1)
  ON CONFLICT (tenant_id, kind) DO UPDATE SET next_no = doc_counters.next_no + 1
  RETURNING next_no
$$;

-- ---------------------------------------------------------------------------
-- Finance settings
-- ---------------------------------------------------------------------------
CREATE TABLE finance_settings (
  tenant_id              uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE RESTRICT,
  -- Nothing may be posted on or before this date (closed periods).
  locked_through         date,
  vat_registered         boolean NOT NULL DEFAULT true,
  vat_number             text CHECK (vat_number ~ '^4\d{9}$'),
  -- South African companies commonly run March–February.
  fiscal_year_start_month integer NOT NULL DEFAULT 3 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER finance_settings_touch BEFORE UPDATE ON finance_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------
CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');

CREATE TABLE accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  code        text NOT NULL CHECK (code ~ '^[0-9A-Za-z.\-]{1,20}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  type        account_type NOT NULL,
  -- Accounts the system posts to automatically (AR/AP control, VAT, bank, ...).
  system_key  text CHECK (system_key ~ '^[a-z_]{2,40}$'),
  is_bank     boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  CHECK (NOT is_bank OR type = 'asset')
);
CREATE UNIQUE INDEX accounts_system_key ON accounts (tenant_id, system_key) WHERE system_key IS NOT NULL;
CREATE TRIGGER accounts_touch BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Journals (append-only)
-- ---------------------------------------------------------------------------
CREATE TYPE journal_source AS ENUM (
  'manual', 'supplier_invoice', 'customer_invoice', 'payment', 'bank', 'reversal', 'void'
);

CREATE TABLE journals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  journal_no  integer NOT NULL,
  entry_date  date NOT NULL,
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  source      journal_source NOT NULL,
  source_id   uuid,
  reverses_id uuid,
  posted_by   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, journal_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by)   REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, reverses_id) REFERENCES journals (tenant_id, id)
);
CREATE UNIQUE INDEX journals_reversal_once ON journals (reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX journals_date_idx ON journals (tenant_id, entry_date);

CREATE TABLE journal_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  journal_id  uuid NOT NULL,
  account_id  uuid NOT NULL,
  project_id  uuid,
  description text CHECK (length(description) <= 300),
  debit       numeric(18, 2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit      numeric(18, 2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES journals (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  -- Exactly one side per line.
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);
CREATE INDEX journal_lines_account_idx ON journal_lines (tenant_id, account_id);
CREATE INDEX journal_lines_journal_idx ON journal_lines (journal_id);

-- Period lock: no journal on or before the locked-through date.
CREATE FUNCTION journals_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_lock date;
BEGIN
  SELECT locked_through INTO v_lock FROM finance_settings WHERE tenant_id = NEW.tenant_id;
  IF v_lock IS NOT NULL AND NEW.entry_date <= v_lock THEN
    RAISE EXCEPTION 'the period up to % is locked', v_lock USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER journals_guard BEFORE INSERT ON journals FOR EACH ROW EXECUTE FUNCTION journals_guard();

-- Lines may only be added in the transaction that created the journal, to an
-- active account.
CREATE FUNCTION journal_lines_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journals WHERE id = NEW.journal_id AND created_at = now()) THEN
    RAISE EXCEPTION 'lines cannot be added to a posted journal' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND is_active) THEN
    RAISE EXCEPTION 'account is inactive or does not exist' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER journal_lines_guard BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION journal_lines_guard();

-- Balanced, checked at COMMIT once every line is in.
CREATE FUNCTION journal_balanced_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_journal uuid;
  v_lines   integer;
  v_dr      numeric;
  v_cr      numeric;
BEGIN
  -- Separate branches: each NEW only has its own table's columns.
  IF TG_TABLE_NAME = 'journals' THEN
    v_journal := NEW.id;
  ELSE
    v_journal := NEW.journal_id;
  END IF;
  SELECT count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    INTO v_lines, v_dr, v_cr
    FROM journal_lines WHERE journal_id = v_journal;
  IF v_lines < 2 THEN
    RAISE EXCEPTION 'a journal needs at least two lines' USING ERRCODE = '23514';
  END IF;
  IF v_dr <> v_cr THEN
    RAISE EXCEPTION 'journal does not balance: debits % <> credits %', v_dr, v_cr USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER journals_balanced AFTER INSERT ON journals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_balanced_check();
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_balanced_check();

-- An account's type cannot change once it has postings.
CREATE FUNCTION accounts_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.type IS DISTINCT FROM OLD.type AND EXISTS (SELECT 1 FROM journal_lines WHERE account_id = OLD.id) THEN
    RAISE EXCEPTION 'account % has postings; its type cannot change', OLD.code USING ERRCODE = '42501';
  END IF;
  IF NEW.is_bank IS DISTINCT FROM OLD.is_bank AND EXISTS (SELECT 1 FROM journal_lines WHERE account_id = OLD.id) THEN
    RAISE EXCEPTION 'account % has postings; it cannot become or stop being a bank account', OLD.code USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER accounts_guard BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION accounts_guard();

-- ---------------------------------------------------------------------------
-- Parties
-- ---------------------------------------------------------------------------
CREATE TABLE suppliers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  vat_number         text CHECK (vat_number ~ '^4\d{9}$'),
  registration_no    text CHECK (length(registration_no) <= 40),
  email              text CHECK (length(email) <= 200),
  phone              text CHECK (length(phone) <= 40),
  payment_terms_days integer NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);
CREATE TRIGGER suppliers_touch BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE customers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  vat_number         text CHECK (vat_number ~ '^4\d{9}$'),
  registration_no    text CHECK (length(registration_no) <= 40),
  email              text CHECK (length(email) <= 200),
  phone              text CHECK (length(phone) <= 40),
  billing_address    text CHECK (length(billing_address) <= 500),
  payment_terms_days integer NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);
CREATE TRIGGER customers_touch BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Invoices (shared freeze rule)
-- Once out of draft, only payment progress and voiding may change.
-- ---------------------------------------------------------------------------
CREATE FUNCTION invoice_freeze_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_mutable text[] := ARRAY['status', 'amount_paid', 'voided_at', 'void_journal_id', 'updated_at'];
  -- Compare as text: the two invoice tables use different status enums.
  v_old text := CASE WHEN TG_OP <> 'INSERT' THEN OLD.status::text END;
  v_new text := CASE WHEN TG_OP <> 'DELETE' THEN NEW.status::text END;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_new <> 'draft' THEN
      RAISE EXCEPTION 'new invoices start as draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF v_old <> 'draft' THEN
      RAISE EXCEPTION 'only a draft invoice can be deleted; void it instead' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF v_old IN ('paid', 'void') THEN
    RAISE EXCEPTION 'invoice is % and cannot change', v_old USING ERRCODE = '42501';
  END IF;
  IF v_old <> 'draft'
     AND (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'invoice is % and cannot be edited', v_old USING ERRCODE = '42501';
  END IF;
  IF v_new IS DISTINCT FROM v_old AND NOT (
       (v_old = 'draft'                 AND v_new IN ('approved', 'issued'))
    OR (v_old IN ('approved', 'issued') AND v_new IN ('part_paid', 'paid', 'void'))
    OR (v_old = 'part_paid'             AND v_new = 'paid')
  ) THEN
    RAISE EXCEPTION 'invalid invoice transition % -> %', v_old, v_new USING ERRCODE = '23514';
  END IF;
  IF v_new = 'void' AND OLD.amount_paid <> 0 THEN
    RAISE EXCEPTION 'an invoice with payments allocated cannot be voided' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- Lines only change while their invoice is a draft.
CREATE FUNCTION invoice_lines_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
BEGIN
  EXECUTE format('SELECT status::text FROM %I WHERE id = $1', TG_ARGV[0])
     INTO v_status USING COALESCE(NEW.invoice_id, OLD.invoice_id);
  -- NULL: the draft invoice itself is being deleted and the lines cascade with it.
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'invoice lines are frozen once the invoice is %', v_status USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

-- ---------------------------------------------------------------------------
-- Accounts payable
-- ---------------------------------------------------------------------------
CREATE TYPE supplier_invoice_status AS ENUM ('draft', 'approved', 'part_paid', 'paid', 'void');

CREATE TABLE supplier_invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  supplier_id     uuid NOT NULL,
  invoice_no      text NOT NULL CHECK (length(invoice_no) BETWEEN 1 AND 60),   -- the supplier's number
  invoice_date    date NOT NULL,
  due_date        date NOT NULL,
  status          supplier_invoice_status NOT NULL DEFAULT 'draft',
  subtotal        numeric(18, 2) NOT NULL DEFAULT 0,
  vat_total       numeric(18, 2) NOT NULL DEFAULT 0,
  total           numeric(18, 2) NOT NULL DEFAULT 0,
  amount_paid     numeric(18, 2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  notes           text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  source_file_id  uuid,
  journal_id      uuid,
  approved_at     timestamptz,
  approved_by     uuid,
  voided_at       timestamptz,
  void_journal_id uuid,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, invoice_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id)     REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id)      REFERENCES journals (tenant_id, id),
  FOREIGN KEY (tenant_id, void_journal_id) REFERENCES journals (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by)     REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)      REFERENCES users (tenant_id, id),
  CHECK (due_date >= invoice_date),
  CHECK (total = subtotal + vat_total),
  CHECK (amount_paid <= total),
  CHECK (status = 'draft' OR (journal_id IS NOT NULL AND approved_at IS NOT NULL AND total > 0)),
  CHECK (status <> 'paid' OR amount_paid = total),
  CHECK (status <> 'part_paid' OR (amount_paid > 0 AND amount_paid < total)),
  CHECK (status <> 'void' OR (void_journal_id IS NOT NULL AND voided_at IS NOT NULL))
);
CREATE INDEX supplier_invoices_status_idx ON supplier_invoices (tenant_id, status, due_date);
CREATE TRIGGER supplier_invoices_touch BEFORE UPDATE ON supplier_invoices FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER supplier_invoices_guard BEFORE INSERT OR UPDATE OR DELETE ON supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION invoice_freeze_guard();

CREATE TABLE supplier_invoice_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  invoice_id   uuid NOT NULL,
  line_no      integer NOT NULL CHECK (line_no >= 1),
  description  text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  -- Either a project cost (project + cost code + category) or a general expense account.
  project_id   uuid,
  cost_code_id uuid,
  category     cost_category,
  account_id   uuid,
  amount       numeric(18, 2) NOT NULL CHECK (amount <> 0),      -- excl. VAT
  vat_rate     numeric(5, 2) NOT NULL DEFAULT 15 CHECK (vat_rate IN (0, 15)),
  vat_amount   numeric(18, 2) NOT NULL DEFAULT 0,
  UNIQUE (invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id)   REFERENCES supplier_invoices (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id)   REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_code_id) REFERENCES cost_codes (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id)   REFERENCES accounts (tenant_id, id),
  CHECK ((project_id IS NOT NULL AND cost_code_id IS NOT NULL AND category IS NOT NULL) OR
         (project_id IS NULL AND cost_code_id IS NULL AND account_id IS NOT NULL))
);
CREATE TRIGGER supplier_invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON supplier_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_guard('supplier_invoices');

-- Project costs created by a document (e.g. an approved supplier invoice) point
-- back to it, so voiding the document reverses exactly those costs.
ALTER TABLE cost_entries ADD COLUMN source_id uuid;
CREATE INDEX cost_entries_source_idx ON cost_entries (source_id) WHERE source_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Accounts receivable
-- ---------------------------------------------------------------------------
CREATE TYPE customer_invoice_status AS ENUM ('draft', 'issued', 'part_paid', 'paid', 'void');

CREATE TABLE customer_invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  customer_id     uuid NOT NULL,
  invoice_no      integer,                                        -- assigned on issue, gap-free per tenant
  invoice_date    date NOT NULL,
  due_date        date NOT NULL,
  status          customer_invoice_status NOT NULL DEFAULT 'draft',
  project_id      uuid,
  valuation_id    uuid,                                           -- tax invoice for a payment certificate
  customer_ref    text CHECK (length(customer_ref) <= 100),       -- client's PO / order number
  subtotal        numeric(18, 2) NOT NULL DEFAULT 0,
  vat_total       numeric(18, 2) NOT NULL DEFAULT 0,
  total           numeric(18, 2) NOT NULL DEFAULT 0,
  amount_paid     numeric(18, 2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  notes           text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  journal_id      uuid,
  issued_at       timestamptz,
  issued_by       uuid,
  voided_at       timestamptz,
  void_journal_id uuid,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, invoice_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id)     REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id)      REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, valuation_id)    REFERENCES valuations (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id)      REFERENCES journals (tenant_id, id),
  FOREIGN KEY (tenant_id, void_journal_id) REFERENCES journals (tenant_id, id),
  FOREIGN KEY (tenant_id, issued_by)       REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)      REFERENCES users (tenant_id, id),
  CHECK (due_date >= invoice_date),
  CHECK (total = subtotal + vat_total),
  CHECK (amount_paid <= total),
  CHECK (status = 'draft' OR (invoice_no IS NOT NULL AND journal_id IS NOT NULL AND issued_at IS NOT NULL AND total > 0)),
  CHECK (status <> 'paid' OR amount_paid = total),
  CHECK (status <> 'part_paid' OR (amount_paid > 0 AND amount_paid < total)),
  CHECK (status <> 'void' OR (void_journal_id IS NOT NULL AND voided_at IS NOT NULL))
);
-- One live tax invoice per valuation.
CREATE UNIQUE INDEX customer_invoices_valuation_once ON customer_invoices (valuation_id)
  WHERE valuation_id IS NOT NULL AND status <> 'void';
CREATE INDEX customer_invoices_status_idx ON customer_invoices (tenant_id, status, due_date);
CREATE TRIGGER customer_invoices_touch BEFORE UPDATE ON customer_invoices FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER customer_invoices_guard BEFORE INSERT OR UPDATE OR DELETE ON customer_invoices
  FOR EACH ROW EXECUTE FUNCTION invoice_freeze_guard();

CREATE TABLE customer_invoice_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  invoice_id  uuid NOT NULL,
  line_no     integer NOT NULL CHECK (line_no >= 1),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  account_id  uuid NOT NULL,                                       -- income (or retention receivable, negative)
  amount      numeric(18, 2) NOT NULL CHECK (amount <> 0),         -- excl. VAT; negative = deduction
  vat_rate    numeric(5, 2) NOT NULL DEFAULT 15 CHECK (vat_rate IN (0, 15)),
  vat_amount  numeric(18, 2) NOT NULL DEFAULT 0,
  UNIQUE (invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES customer_invoices (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id)
);
CREATE TRIGGER customer_invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON customer_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_guard('customer_invoices');

-- ---------------------------------------------------------------------------
-- Payments (append-only) and their allocations to invoices
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  direction       text NOT NULL CHECK (direction IN ('in', 'out')),
  payment_no      integer NOT NULL,
  supplier_id     uuid,
  customer_id     uuid,
  bank_account_id uuid NOT NULL,
  payment_date    date NOT NULL,
  amount          numeric(18, 2) NOT NULL CHECK (amount > 0),
  reference       text CHECK (length(reference) <= 100),
  journal_id      uuid NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, direction, payment_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id)     REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id)     REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id)      REFERENCES journals (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)      REFERENCES users (tenant_id, id),
  CHECK ((direction = 'out' AND supplier_id IS NOT NULL AND customer_id IS NULL) OR
         (direction = 'in'  AND customer_id IS NOT NULL AND supplier_id IS NULL))
);

CREATE TABLE payment_allocations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  payment_id          uuid NOT NULL,
  supplier_invoice_id uuid,
  customer_invoice_id uuid,
  amount              numeric(18, 2) NOT NULL CHECK (amount > 0),
  FOREIGN KEY (tenant_id, payment_id)          REFERENCES payments (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_invoice_id) REFERENCES supplier_invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_invoice_id) REFERENCES customer_invoices (tenant_id, id),
  CHECK ((supplier_invoice_id IS NULL) <> (customer_invoice_id IS NULL))
);
CREATE INDEX payment_allocations_payment_idx ON payment_allocations (payment_id);

-- ---------------------------------------------------------------------------
-- Bank statements and reconciliation
-- ---------------------------------------------------------------------------
CREATE TABLE bank_statement_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  bank_account_id   uuid NOT NULL,
  txn_date          date NOT NULL,
  description       text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  reference         text CHECK (length(reference) <= 100),
  amount            numeric(18, 2) NOT NULL CHECK (amount <> 0),   -- + money in, − money out
  external_id       text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 100),  -- de-duplicates re-imports
  matched_line_id   uuid,
  matched_at        timestamptz,
  matched_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_account_id, external_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, matched_line_id) REFERENCES journal_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, matched_by)      REFERENCES users (tenant_id, id),
  CHECK ((matched_line_id IS NULL) = (matched_at IS NULL))
);
CREATE UNIQUE INDEX bank_statement_lines_match_once ON bank_statement_lines (matched_line_id) WHERE matched_line_id IS NOT NULL;
CREATE INDEX bank_statement_lines_account_idx ON bank_statement_lines (tenant_id, bank_account_id, txn_date);

CREATE FUNCTION bank_statement_lines_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_mutable text[] := ARRAY['matched_line_id', 'matched_at', 'matched_by'];
  v_account uuid;
  v_amount  numeric;
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'imported statement lines cannot be edited' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.bank_account_id AND is_bank) THEN
    RAISE EXCEPTION 'statement lines belong to a bank account' USING ERRCODE = '23514';
  END IF;
  IF NEW.matched_line_id IS NOT NULL THEN
    SELECT account_id, debit - credit INTO v_account, v_amount FROM journal_lines WHERE id = NEW.matched_line_id;
    IF v_account IS DISTINCT FROM NEW.bank_account_id OR v_amount IS DISTINCT FROM NEW.amount THEN
      RAISE EXCEPTION 'a statement line can only match a ledger line on the same bank account for the same amount'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bank_statement_lines_guard BEFORE INSERT OR UPDATE ON bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION bank_statement_lines_guard();

-- ---------------------------------------------------------------------------
-- Row Level Security + least privilege
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'doc_counters', 'finance_settings', 'accounts', 'journals', 'journal_lines', 'suppliers', 'customers',
    'supplier_invoices', 'supplier_invoice_lines', 'customer_invoices', 'customer_invoice_lines',
    'payments', 'payment_allocations', 'bank_statement_lines'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO constructos_ai', t);
  END LOOP;
END
$$;
-- The AI engine has no business reading the numbering counters.
REVOKE SELECT ON doc_counters FROM constructos_ai;

GRANT SELECT, INSERT, UPDATE         ON doc_counters, finance_settings, accounts, suppliers, customers TO constructos_app;
GRANT SELECT, INSERT                 ON journals, journal_lines, payments, payment_allocations          TO constructos_app;  -- append-only
GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_invoices, supplier_invoice_lines,
                                        customer_invoices, customer_invoice_lines                       TO constructos_app;  -- delete: drafts only (trigger)
GRANT SELECT, INSERT, UPDATE         ON bank_statement_lines                                            TO constructos_app;  -- update: matching only (trigger)
GRANT EXECUTE ON FUNCTION next_doc_no(text) TO constructos_app;
