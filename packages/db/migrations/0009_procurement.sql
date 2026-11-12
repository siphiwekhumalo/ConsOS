-- =============================================================================
-- 0009 — Procurement & subcontractors (Procurement module): RFQs and quotes,
-- purchase orders with approval limits, goods received, three-way matching of
-- supplier invoices, subcontracts with payment certificates and retention.
--
-- Enforced IN THE DATABASE (not only the API):
--   * the purchase-order workflow; approved orders and their lines are frozen;
--   * goods can only be received against an approved order, never more than ordered;
--   * a supplier invoice that bills more than was received, or above the order
--     price, cannot be approved unless an override reason is recorded;
--   * subcontract certificates add up, run in sequence and freeze once certified.
-- =============================================================================

ALTER TABLE doc_counters DROP CONSTRAINT doc_counters_kind_check;
ALTER TABLE doc_counters ADD CONSTRAINT doc_counters_kind_check CHECK (kind IN (
  'journal', 'customer_invoice', 'payment_in', 'payment_out', 'purchase_order', 'rfq', 'goods_receipt'
));

-- ---------------------------------------------------------------------------
-- Supplier compliance
-- ---------------------------------------------------------------------------
ALTER TABLE suppliers
  ADD COLUMN bbbee_level          integer CHECK (bbbee_level BETWEEN 1 AND 8),   -- NULL = non-compliant / unknown
  ADD COLUMN bbbee_expiry         date,
  ADD COLUMN cidb_grading         text CHECK (cidb_grading ~ '^[1-9][A-Z]{1,3}$'),  -- e.g. 6CE, 7GB
  ADD COLUMN is_subcontractor     boolean NOT NULL DEFAULT false;

CREATE TABLE procurement_settings (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE RESTRICT,
  -- Purchase orders up to this value (excl. VAT) may be approved by a project manager.
  pm_approval_limit    numeric(18, 2) NOT NULL DEFAULT 50000 CHECK (pm_approval_limit >= 0),
  -- Invoice unit price may exceed the order price by this much before it is a mismatch.
  price_tolerance_pct  numeric(5, 2) NOT NULL DEFAULT 0 CHECK (price_tolerance_pct BETWEEN 0 AND 20),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER procurement_settings_touch BEFORE UPDATE ON procurement_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Requests for quotation
-- ---------------------------------------------------------------------------
CREATE TYPE rfq_status AS ENUM ('open', 'awarded', 'cancelled');

CREATE TABLE rfqs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  rfq_no        integer NOT NULL,
  project_id    uuid,
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  closing_date  date NOT NULL,
  status        rfq_status NOT NULL DEFAULT 'open',
  awarded_quote_id uuid,
  award_note    text CHECK (length(award_note) <= 2000),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, rfq_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE TRIGGER rfqs_touch BEFORE UPDATE ON rfqs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE rfq_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  rfq_id      uuid NOT NULL,
  line_no     integer NOT NULL CHECK (line_no >= 1),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  unit        text NOT NULL CHECK (length(unit) BETWEEN 1 AND 20),
  quantity    numeric(18, 3) NOT NULL CHECK (quantity > 0),
  UNIQUE (rfq_id, line_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, rfq_id) REFERENCES rfqs (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE rfq_quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  rfq_id        uuid NOT NULL,
  supplier_id   uuid NOT NULL,
  quote_ref     text CHECK (length(quote_ref) <= 60),
  valid_until   date,
  lead_time_days integer CHECK (lead_time_days BETWEEN 0 AND 730),
  notes         text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, supplier_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, rfq_id)      REFERENCES rfqs (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);
ALTER TABLE rfqs ADD FOREIGN KEY (tenant_id, awarded_quote_id) REFERENCES rfq_quotes (tenant_id, id);

CREATE TABLE rfq_quote_prices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  quote_id    uuid NOT NULL,
  item_id     uuid NOT NULL,
  unit_price  numeric(18, 2) NOT NULL CHECK (unit_price >= 0),
  UNIQUE (quote_id, item_id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES rfq_quotes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id)  REFERENCES rfq_items (tenant_id, id) ON DELETE CASCADE
);

-- Items, quotes and prices only change while the RFQ is open.
CREATE FUNCTION rfq_children_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_rfq    uuid;
  v_status rfq_status;
BEGIN
  IF TG_TABLE_NAME = 'rfq_quote_prices' THEN
    SELECT q.rfq_id INTO v_rfq FROM rfq_quotes q WHERE q.id = COALESCE(NEW.quote_id, OLD.quote_id);
  ELSE
    v_rfq := COALESCE(NEW.rfq_id, OLD.rfq_id);
  END IF;
  SELECT status INTO v_status FROM rfqs WHERE id = v_rfq;
  IF v_status IS NOT NULL AND v_status <> 'open' THEN
    RAISE EXCEPTION 'the RFQ is % and can no longer change', v_status USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
CREATE TRIGGER rfq_items_guard  BEFORE INSERT OR UPDATE OR DELETE ON rfq_items  FOR EACH ROW EXECUTE FUNCTION rfq_children_guard();
CREATE TRIGGER rfq_quotes_guard BEFORE INSERT OR UPDATE OR DELETE ON rfq_quotes FOR EACH ROW EXECUTE FUNCTION rfq_children_guard();
CREATE TRIGGER rfq_quote_prices_guard BEFORE INSERT OR UPDATE OR DELETE ON rfq_quote_prices FOR EACH ROW EXECUTE FUNCTION rfq_children_guard();

CREATE FUNCTION rfqs_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'the RFQ is % and can no longer change', OLD.status USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'awarded' AND NEW.awarded_quote_id IS NULL THEN
    RAISE EXCEPTION 'choose the winning quote' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rfqs_guard BEFORE UPDATE ON rfqs FOR EACH ROW EXECUTE FUNCTION rfqs_guard();

-- ---------------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------------
CREATE TYPE po_status AS ENUM ('draft', 'submitted', 'approved', 'closed', 'cancelled');

CREATE TABLE purchase_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  po_no          integer NOT NULL,
  supplier_id    uuid NOT NULL,
  project_id     uuid,
  rfq_id         uuid,
  status         po_status NOT NULL DEFAULT 'draft',
  order_date     date NOT NULL,
  required_by    date,
  delivery_address text CHECK (length(delivery_address) <= 500),
  notes          text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  subtotal       numeric(18, 2) NOT NULL DEFAULT 0,
  vat_total      numeric(18, 2) NOT NULL DEFAULT 0,
  total          numeric(18, 2) NOT NULL DEFAULT 0,
  submitted_at   timestamptz,
  approved_at    timestamptz,
  approved_by    uuid,
  closed_at      timestamptz,
  close_reason   text CHECK (length(close_reason) <= 500),
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, po_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id)  REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, rfq_id)      REFERENCES rfqs (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)  REFERENCES users (tenant_id, id),
  CHECK (total = subtotal + vat_total),
  CHECK (status NOT IN ('approved', 'closed') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND total > 0))
);
CREATE INDEX purchase_orders_status_idx ON purchase_orders (tenant_id, status, order_date DESC);
CREATE TRIGGER purchase_orders_touch BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE purchase_order_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  po_id        uuid NOT NULL,
  line_no      integer NOT NULL CHECK (line_no >= 1),
  description  text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  unit         text NOT NULL CHECK (length(unit) BETWEEN 1 AND 20),
  quantity     numeric(18, 3) NOT NULL CHECK (quantity > 0),
  unit_price   numeric(18, 2) NOT NULL CHECK (unit_price >= 0),
  vat_rate     numeric(5, 2) NOT NULL DEFAULT 15 CHECK (vat_rate IN (0, 15)),
  -- Project lines are commitments against a cost code; others charge an account.
  project_id   uuid,
  cost_code_id uuid,
  category     cost_category,
  account_id   uuid,
  UNIQUE (po_id, line_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, po_id)        REFERENCES purchase_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id)   REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_code_id) REFERENCES cost_codes (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id)   REFERENCES accounts (tenant_id, id),
  CHECK ((project_id IS NOT NULL AND cost_code_id IS NOT NULL AND category IS NOT NULL) OR
         (project_id IS NULL AND cost_code_id IS NULL AND account_id IS NOT NULL))
);

CREATE FUNCTION purchase_orders_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_mutable text[] := ARRAY['status', 'closed_at', 'close_reason', 'updated_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'new purchase orders start as draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'only a draft order can be deleted; cancel it instead' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'purchase order % is % and cannot change', OLD.po_no, OLD.status USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'approved' AND (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'purchase order % is approved and cannot be edited', OLD.po_no USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft'     AND NEW.status IN ('submitted', 'cancelled'))
    OR (OLD.status = 'submitted' AND NEW.status IN ('draft', 'approved', 'cancelled'))
    OR (OLD.status = 'approved'  AND NEW.status IN ('closed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'invalid purchase order transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  -- Cancelling an approved order is only possible before anything was received.
  IF OLD.status = 'approved' AND NEW.status = 'cancelled' AND EXISTS (
       SELECT 1 FROM goods_receipt_lines g JOIN purchase_order_lines l ON l.id = g.po_line_id WHERE l.po_id = OLD.id) THEN
    RAISE EXCEPTION 'goods have been received against this order; close it instead of cancelling' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION purchase_order_lines_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_status po_status;
BEGIN
  SELECT status INTO v_status FROM purchase_orders WHERE id = COALESCE(NEW.po_id, OLD.po_id);
  -- NULL: the draft order itself is being deleted.
  IF v_status IS NOT NULL AND v_status NOT IN ('draft', 'submitted') THEN
    RAISE EXCEPTION 'order lines are frozen once the order is %', v_status USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

-- ---------------------------------------------------------------------------
-- Goods received (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE goods_receipts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  grn_no       integer NOT NULL,
  po_id        uuid NOT NULL,
  received_on  date NOT NULL,
  delivery_note text CHECK (length(delivery_note) <= 60),
  notes        text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  received_by  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, grn_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, po_id)       REFERENCES purchase_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, received_by) REFERENCES users (tenant_id, id)
);

CREATE TABLE goods_receipt_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  receipt_id  uuid NOT NULL,
  po_line_id  uuid NOT NULL,
  quantity    numeric(18, 3) NOT NULL CHECK (quantity > 0),
  UNIQUE (receipt_id, po_line_id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES goods_receipts (tenant_id, id),
  FOREIGN KEY (tenant_id, po_line_id) REFERENCES purchase_order_lines (tenant_id, id)
);
CREATE INDEX goods_receipt_lines_po_line_idx ON goods_receipt_lines (po_line_id);

CREATE FUNCTION goods_receipt_lines_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_status   po_status;
  v_po       uuid;
  v_ordered  numeric;
  v_received numeric;
BEGIN
  SELECT o.status, o.id, l.quantity INTO v_status, v_po, v_ordered
    FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.po_id
   WHERE l.id = NEW.po_line_id;
  IF v_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'goods can only be received against an approved order' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM goods_receipts WHERE id = NEW.receipt_id AND po_id = v_po) THEN
    RAISE EXCEPTION 'the order line belongs to a different order' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(sum(quantity), 0) INTO v_received FROM goods_receipt_lines WHERE po_line_id = NEW.po_line_id;
  IF v_received + NEW.quantity > v_ordered THEN
    RAISE EXCEPTION 'receiving % would exceed the % ordered (% already received)', NEW.quantity, v_ordered, v_received
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER goods_receipt_lines_guard BEFORE INSERT ON goods_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_lines_guard();

-- Now that goods_receipt_lines exists, attach the order triggers.
CREATE TRIGGER purchase_orders_guard BEFORE INSERT OR UPDATE OR DELETE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_guard();
CREATE TRIGGER purchase_order_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION purchase_order_lines_guard();

-- ---------------------------------------------------------------------------
-- Three-way match on supplier invoices
-- ---------------------------------------------------------------------------
ALTER TABLE supplier_invoices
  ADD COLUMN po_id                 uuid,
  ADD COLUMN match_override_reason text CHECK (length(match_override_reason) BETWEEN 1 AND 500),
  ADD FOREIGN KEY (tenant_id, po_id) REFERENCES purchase_orders (tenant_id, id);

ALTER TABLE supplier_invoice_lines
  ADD COLUMN po_line_id uuid,
  ADD COLUMN quantity   numeric(18, 3) CHECK (quantity > 0),
  ADD COLUMN unit_price numeric(18, 2) CHECK (unit_price >= 0),
  ADD FOREIGN KEY (tenant_id, po_line_id) REFERENCES purchase_order_lines (tenant_id, id),
  ADD CONSTRAINT supplier_invoice_lines_po_qty CHECK (po_line_id IS NULL OR (quantity IS NOT NULL AND unit_price IS NOT NULL));
CREATE INDEX supplier_invoice_lines_po_line_idx ON supplier_invoice_lines (po_line_id) WHERE po_line_id IS NOT NULL;

/**
 * At approval, every order-linked line must be covered: total invoiced quantity
 * (all live invoices) within the quantity received, and the unit price within
 * the order price plus tolerance. Otherwise an override reason is required.
 */
CREATE FUNCTION supplier_invoice_match_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  r           record;
  v_tolerance numeric;
BEGIN
  IF NOT (OLD.status = 'draft' AND NEW.status = 'approved') OR NEW.match_override_reason IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT coalesce(max(price_tolerance_pct), 0) INTO v_tolerance FROM procurement_settings WHERE tenant_id = NEW.tenant_id;
  FOR r IN
    SELECT l.id AS po_line_id, l.line_no, l.unit_price AS po_price,
           (SELECT coalesce(sum(g.quantity), 0) FROM goods_receipt_lines g WHERE g.po_line_id = l.id) AS received,
           (SELECT coalesce(sum(sl.quantity), 0) FROM supplier_invoice_lines sl JOIN supplier_invoices si ON si.id = sl.invoice_id
             WHERE sl.po_line_id = l.id AND (si.id = NEW.id OR si.status IN ('approved', 'part_paid', 'paid'))) AS invoiced,
           (SELECT max(sl.unit_price) FROM supplier_invoice_lines sl WHERE sl.invoice_id = NEW.id AND sl.po_line_id = l.id) AS billed_price
      FROM purchase_order_lines l
     WHERE l.id IN (SELECT po_line_id FROM supplier_invoice_lines WHERE invoice_id = NEW.id AND po_line_id IS NOT NULL)
  LOOP
    IF r.invoiced > r.received THEN
      RAISE EXCEPTION 'order line %: invoiced % but only % received', r.line_no, r.invoiced, r.received USING ERRCODE = '23514';
    END IF;
    IF r.billed_price > r.po_price * (1 + v_tolerance / 100) THEN
      RAISE EXCEPTION 'order line %: invoiced at % against an order price of %', r.line_no, r.billed_price, r.po_price USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
CREATE TRIGGER supplier_invoices_match_guard BEFORE UPDATE ON supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION supplier_invoice_match_guard();

-- ---------------------------------------------------------------------------
-- Subcontracts and their payment certificates
-- ---------------------------------------------------------------------------
CREATE TYPE subcontract_status AS ENUM ('draft', 'active', 'completed', 'terminated');

CREATE TABLE subcontracts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  project_id          uuid NOT NULL,
  supplier_id         uuid NOT NULL,
  ref                 text NOT NULL CHECK (length(ref) BETWEEN 1 AND 30),
  scope               text NOT NULL CHECK (length(scope) BETWEEN 1 AND 2000),
  cost_code_id        uuid NOT NULL,
  contract_value      numeric(18, 2) NOT NULL CHECK (contract_value > 0),
  retention_pct       numeric(5, 2) NOT NULL DEFAULT 5 CHECK (retention_pct BETWEEN 0 AND 20),
  retention_limit_pct numeric(5, 2) NOT NULL DEFAULT 5 CHECK (retention_limit_pct BETWEEN 0 AND 20),
  status              subcontract_status NOT NULL DEFAULT 'draft',
  start_date          date,
  end_date            date,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, ref),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id)   REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id)  REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_code_id) REFERENCES cost_codes (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)   REFERENCES users (tenant_id, id)
);
CREATE TRIGGER subcontracts_touch BEFORE UPDATE ON subcontracts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE FUNCTION subcontracts_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'new subcontracts start as draft' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cost_codes WHERE id = NEW.cost_code_id AND project_id = NEW.project_id) THEN
      RAISE EXCEPTION 'cost code does not belong to this project' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('completed', 'terminated') THEN
    RAISE EXCEPTION 'subcontract % is % and cannot change', OLD.ref, OLD.status USING ERRCODE = '42501';
  END IF;
  -- Once active, the commercial terms are fixed (changes are variations, not edits).
  IF OLD.status = 'active' AND (
       NEW.contract_value IS DISTINCT FROM OLD.contract_value OR NEW.retention_pct IS DISTINCT FROM OLD.retention_pct
    OR NEW.retention_limit_pct IS DISTINCT FROM OLD.retention_limit_pct OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.cost_code_id IS DISTINCT FROM OLD.cost_code_id) THEN
    RAISE EXCEPTION 'subcontract % is active; its value, retention and parties are fixed', OLD.ref USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft'  AND NEW.status = 'active')
    OR (OLD.status = 'active' AND NEW.status IN ('completed', 'terminated'))
  ) THEN
    RAISE EXCEPTION 'invalid subcontract transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER subcontracts_guard BEFORE INSERT OR UPDATE ON subcontracts FOR EACH ROW EXECUTE FUNCTION subcontracts_guard();

CREATE TYPE subcontract_cert_status AS ENUM ('draft', 'certified');

CREATE TABLE subcontract_certificates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  subcontract_id       uuid NOT NULL,
  cert_no              integer NOT NULL CHECK (cert_no >= 1),
  period_end           date NOT NULL,
  status               subcontract_cert_status NOT NULL DEFAULT 'draft',
  work_done_to_date    numeric(18, 2) NOT NULL CHECK (work_done_to_date >= 0),
  retention_to_date    numeric(18, 2) NOT NULL CHECK (retention_to_date >= 0),
  net_to_date          numeric(18, 2) NOT NULL,
  previous_gross       numeric(18, 2) NOT NULL DEFAULT 0,
  previous_retention   numeric(18, 2) NOT NULL DEFAULT 0,
  previously_certified numeric(18, 2) NOT NULL DEFAULT 0,
  amount_due           numeric(18, 2) NOT NULL,
  supplier_invoice_id  uuid,
  certified_at         timestamptz,
  certified_by         uuid,
  notes                text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subcontract_id, cert_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, subcontract_id)      REFERENCES subcontracts (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_invoice_id) REFERENCES supplier_invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, certified_by)        REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)          REFERENCES users (tenant_id, id),
  CHECK (retention_to_date <= work_done_to_date),
  CHECK (net_to_date = work_done_to_date - retention_to_date),
  CHECK (previously_certified = previous_gross - previous_retention),
  CHECK (amount_due = net_to_date - previously_certified),
  CHECK (status <> 'certified' OR (certified_at IS NOT NULL AND certified_by IS NOT NULL))
);
CREATE TRIGGER subcontract_certificates_touch BEFORE UPDATE ON subcontract_certificates FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE FUNCTION subcontract_certificates_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_mutable text[] := ARRAY['supplier_invoice_id', 'updated_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'new certificates start as draft' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM subcontracts WHERE id = NEW.subcontract_id AND status = 'active') THEN
      RAISE EXCEPTION 'certificates can only be raised on an active subcontract' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM subcontract_certificates WHERE subcontract_id = NEW.subcontract_id AND status = 'draft') THEN
      RAISE EXCEPTION 'certify the open certificate before starting another' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'a certified certificate cannot be deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'certified' AND (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'certificate % is certified and cannot change', OLD.cert_no USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER subcontract_certificates_guard BEFORE INSERT OR UPDATE OR DELETE ON subcontract_certificates
  FOR EACH ROW EXECUTE FUNCTION subcontract_certificates_guard();

ALTER TABLE supplier_invoices
  ADD COLUMN subcontract_certificate_id uuid,
  ADD FOREIGN KEY (tenant_id, subcontract_certificate_id) REFERENCES subcontract_certificates (tenant_id, id);
CREATE UNIQUE INDEX supplier_invoices_certificate_once ON supplier_invoices (subcontract_certificate_id)
  WHERE subcontract_certificate_id IS NOT NULL AND status <> 'void';

-- ---------------------------------------------------------------------------
-- Row Level Security + least privilege
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'procurement_settings', 'rfqs', 'rfq_items', 'rfq_quotes', 'rfq_quote_prices', 'purchase_orders',
    'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines', 'subcontracts', 'subcontract_certificates'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO constructos_ai', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE         ON procurement_settings, rfqs, subcontracts                       TO constructos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON rfq_items, rfq_quotes, rfq_quote_prices,
                                        purchase_orders, purchase_order_lines, subcontract_certificates TO constructos_app;  -- delete: drafts / open RFQs only (triggers)
GRANT SELECT, INSERT                 ON goods_receipts, goods_receipt_lines                             TO constructos_app;  -- append-only
