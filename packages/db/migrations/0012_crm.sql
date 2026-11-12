-- =============================================================================
-- 0012 — CRM & tenders (CRM module): clients, contacts, the opportunity and
-- tender pipeline, and activities with follow-ups.
--
-- Clients are the existing `customers` (shared with receivables), extended
-- with CRM fields, so a won tender invoices the same client record.
--
-- Enforced IN THE DATABASE (not only the API):
--   * the pipeline stage machine; won needs the awarded value, lost and
--     no-bid need a reason;
--   * a closed opportunity cannot change, except to link the project it became.
-- =============================================================================

ALTER TABLE doc_counters DROP CONSTRAINT doc_counters_kind_check;
ALTER TABLE doc_counters ADD CONSTRAINT doc_counters_kind_check CHECK (kind IN (
  'journal', 'customer_invoice', 'payment_in', 'payment_out', 'purchase_order', 'rfq', 'goods_receipt',
  'work_order', 'incident', 'ncr', 'inspection', 'employee', 'opportunity'
));

ALTER TABLE customers
  ADD COLUMN sector             text CHECK (sector IN ('mining', 'petrochemical', 'power', 'manufacturing', 'infrastructure', 'government', 'commercial', 'other')),
  ADD COLUMN province           text CHECK (province IN ('EC', 'FS', 'GP', 'KZN', 'LP', 'MP', 'NC', 'NW', 'WC')),
  ADD COLUMN website            text CHECK (length(website) <= 200),
  ADD COLUMN account_manager_id uuid,
  ADD COLUMN notes              text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  ADD FOREIGN KEY (tenant_id, account_manager_id) REFERENCES users (tenant_id, id);

-- ---------------------------------------------------------------------------
-- Contacts (business contact details; marketing opt-out kept for POPIA)
-- ---------------------------------------------------------------------------
CREATE TABLE contacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  customer_id        uuid NOT NULL,
  full_name          text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 200),
  job_title          text CHECK (length(job_title) <= 100),
  email              text CHECK (length(email) <= 200),
  phone              text CHECK (length(phone) <= 40),
  is_primary         boolean NOT NULL DEFAULT false,
  marketing_opt_out  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
CREATE UNIQUE INDEX contacts_one_primary ON contacts (customer_id) WHERE is_primary;
CREATE TRIGGER contacts_touch BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Opportunities and tenders
-- ---------------------------------------------------------------------------
CREATE TYPE opportunity_stage AS ENUM ('lead', 'qualifying', 'tendering', 'submitted', 'won', 'lost', 'no_bid');

CREATE TABLE opportunities (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  opp_no                integer NOT NULL,
  customer_id           uuid NOT NULL,
  contact_id            uuid,
  title                 text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description           text NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  stage                 opportunity_stage NOT NULL DEFAULT 'lead',
  source                text NOT NULL DEFAULT 'client_rfq' CHECK (source IN ('client_rfq', 'tender_bulletin', 'etender_portal', 'referral', 'repeat_client', 'other')),
  estimated_value       numeric(18, 2) CHECK (estimated_value >= 0),
  probability           integer NOT NULL DEFAULT 10 CHECK (probability BETWEEN 0 AND 100),
  tender_ref            text CHECK (length(tender_ref) <= 60),            -- the client's tender / enquiry number
  briefing_on           timestamptz,                                       -- compulsory site briefing
  closing_at            timestamptz,                                       -- tender closing date and time
  expected_award_on     date,
  cidb_grade_required   text CHECK (cidb_grade_required ~ '^[1-9][A-Z]{1,3}$'),
  bbbee_level_required  integer CHECK (bbbee_level_required BETWEEN 1 AND 8),
  owner_id              uuid NOT NULL,
  estimate_id           uuid,
  project_id            uuid,
  awarded_value         numeric(18, 2) CHECK (awarded_value >= 0),
  close_reason          text CHECK (length(close_reason) <= 1000),          -- why lost / why no bid
  competitor            text CHECK (length(competitor) <= 200),            -- who won, if lost
  closed_at             timestamptz,
  created_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, opp_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id)  REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id)    REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, estimate_id) REFERENCES estimates (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id)  REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)  REFERENCES users (tenant_id, id),
  CHECK (stage <> 'won' OR (awarded_value IS NOT NULL AND closed_at IS NOT NULL)),
  CHECK (stage NOT IN ('lost', 'no_bid') OR (close_reason IS NOT NULL AND closed_at IS NOT NULL)),
  CHECK (briefing_on IS NULL OR closing_at IS NULL OR briefing_on <= closing_at)
);
CREATE UNIQUE INDEX opportunities_estimate_once ON opportunities (estimate_id) WHERE estimate_id IS NOT NULL;
CREATE INDEX opportunities_stage_idx ON opportunities (tenant_id, stage, closing_at);
CREATE TRIGGER opportunities_touch BEFORE UPDATE ON opportunities FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE FUNCTION opportunities_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_mutable text[] := ARRAY['project_id', 'updated_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.stage NOT IN ('lead', 'qualifying') THEN
      RAISE EXCEPTION 'new opportunities start as a lead or in qualifying' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.stage IN ('won', 'lost', 'no_bid') THEN
    -- The only change after closing: link the project a won tender became.
    IF OLD.stage <> 'won' OR (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
      RAISE EXCEPTION 'opportunity % is % and cannot change', OLD.opp_no, OLD.stage USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.stage IS DISTINCT FROM OLD.stage AND NOT (
       (OLD.stage = 'lead'       AND NEW.stage IN ('qualifying', 'no_bid'))
    OR (OLD.stage = 'qualifying' AND NEW.stage IN ('lead', 'tendering', 'no_bid'))
    OR (OLD.stage = 'tendering'  AND NEW.stage IN ('qualifying', 'submitted', 'no_bid'))
    OR (OLD.stage = 'submitted'  AND NEW.stage IN ('won', 'lost'))
  ) THEN
    RAISE EXCEPTION 'invalid opportunity transition % -> %', OLD.stage, NEW.stage USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER opportunities_guard BEFORE INSERT OR UPDATE ON opportunities FOR EACH ROW EXECUTE FUNCTION opportunities_guard();

-- ---------------------------------------------------------------------------
-- Activities and follow-ups
-- ---------------------------------------------------------------------------
CREATE TABLE crm_activities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  customer_id     uuid NOT NULL,
  opportunity_id  uuid,
  contact_id      uuid,
  kind            text NOT NULL CHECK (kind IN ('call', 'meeting', 'email', 'site_visit', 'note')),
  occurred_on     date NOT NULL,
  summary         text NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  next_step       text CHECK (length(next_step) <= 500),
  follow_up_on    date,
  follow_up_done  boolean NOT NULL DEFAULT false,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id)    REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id)     REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)     REFERENCES users (tenant_id, id),
  CHECK (follow_up_on IS NOT NULL OR NOT follow_up_done)
);
CREATE INDEX crm_activities_customer_idx ON crm_activities (customer_id, occurred_on DESC);
CREATE INDEX crm_activities_follow_up_idx ON crm_activities (tenant_id, follow_up_on) WHERE follow_up_on IS NOT NULL AND NOT follow_up_done;

-- ---------------------------------------------------------------------------
-- Row Level Security + least privilege
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contacts', 'opportunities', 'crm_activities'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON contacts       TO constructos_app;
GRANT SELECT, INSERT, UPDATE         ON opportunities  TO constructos_app;
GRANT SELECT, INSERT, UPDATE         ON crm_activities TO constructos_app;  -- update: follow-up done only (API)
GRANT SELECT ON opportunities TO constructos_ai;                           -- pipeline analysis; no contact details
