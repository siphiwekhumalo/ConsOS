-- =============================================================================
-- 0007 — Project controls (Finance & CVR module): budgets by cost code, actual
-- costs, variations and interim valuations with retention.
--
-- Together these give the cost-value reconciliation (CVR) for every project:
--   value  = gross work certified by the client (latest certified valuation)
--   cost   = sum of posted cost entries
--   budget = cost-code budgets + internal cost of approved variations
--
-- Enforced IN THE DATABASE (not only the API):
--   * cost entries are append-only (corrections are reversing entries);
--   * the variation and valuation workflows (only the allowed transitions);
--   * a decided variation and a certified valuation can no longer change,
--     except that a certified valuation may be marked paid.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Project contract terms used by valuations
-- ---------------------------------------------------------------------------
ALTER TABLE projects
  ADD COLUMN retention_pct       numeric(5, 2) NOT NULL DEFAULT 5  CHECK (retention_pct BETWEEN 0 AND 20),
  -- Retention stops accruing once it reaches this share of the contract value.
  ADD COLUMN retention_limit_pct numeric(5, 2) NOT NULL DEFAULT 5  CHECK (retention_limit_pct BETWEEN 0 AND 20),
  ADD COLUMN start_date          date,
  ADD COLUMN planned_completion  date,
  ADD CONSTRAINT projects_dates_check CHECK (planned_completion IS NULL OR start_date IS NULL OR planned_completion >= start_date);

-- ---------------------------------------------------------------------------
-- Cost codes: the project's budget breakdown (WBS)
-- ---------------------------------------------------------------------------
CREATE TABLE cost_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  project_id   uuid NOT NULL,
  code         text NOT NULL CHECK (length(code) BETWEEN 1 AND 30),
  description  text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  budget       numeric(18, 2) NOT NULL DEFAULT 0 CHECK (budget >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id)
);

CREATE TRIGGER cost_codes_touch BEFORE UPDATE ON cost_codes FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Cost entries: actual cost, append-only
-- ---------------------------------------------------------------------------
CREATE TYPE cost_category AS ENUM ('labour', 'material', 'plant', 'subcontract', 'overhead', 'other');

CREATE TABLE cost_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  project_id    uuid NOT NULL,
  cost_code_id  uuid NOT NULL,
  entry_date    date NOT NULL,
  category      cost_category NOT NULL,
  description   text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  -- Negative amounts are credits / reversals. Never zero.
  amount        numeric(18, 2) NOT NULL CHECK (amount <> 0),
  reference     text CHECK (length(reference) <= 100),             -- invoice, timesheet, GRN no.
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'ap_invoice', 'payroll', 'plant')),
  reverses_id   uuid,                                               -- set on a reversing entry
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id)   REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_code_id) REFERENCES cost_codes (tenant_id, id),
  FOREIGN KEY (tenant_id, reverses_id)  REFERENCES cost_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)   REFERENCES users (tenant_id, id)
);

-- An entry can be reversed once.
CREATE UNIQUE INDEX cost_entries_reversal_once ON cost_entries (reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX cost_entries_project_idx ON cost_entries (tenant_id, project_id, entry_date);

-- The cost code must belong to the same project.
CREATE FUNCTION cost_entries_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cost_codes WHERE id = NEW.cost_code_id AND project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'cost code does not belong to this project' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER cost_entries_guard BEFORE INSERT ON cost_entries
  FOR EACH ROW EXECUTE FUNCTION cost_entries_guard();

-- ---------------------------------------------------------------------------
-- Variations (variation orders / compensation events)
-- ---------------------------------------------------------------------------
CREATE TYPE variation_status AS ENUM ('draft', 'submitted', 'approved', 'rejected');

CREATE TABLE variations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  project_id       uuid NOT NULL,
  ref              text NOT NULL CHECK (length(ref) BETWEEN 1 AND 30),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description      text NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  instruction_ref  text CHECK (length(instruction_ref) <= 100),       -- site instruction / engineer's instruction
  status           variation_status NOT NULL DEFAULT 'draft',
  notified_on      date NOT NULL,                                     -- when the event became known
  time_bar_days    integer CHECK (time_bar_days BETWEEN 1 AND 365),   -- contractual notice period (e.g. NEC4: 56)
  value_claimed    numeric(18, 2) NOT NULL DEFAULT 0,                 -- negative for omissions
  value_approved   numeric(18, 2),
  cost_estimate    numeric(18, 2) NOT NULL DEFAULT 0,                 -- internal cost of doing the work
  cost_code_id     uuid,
  time_impact_days integer NOT NULL DEFAULT 0 CHECK (time_impact_days BETWEEN -3650 AND 3650),
  submitted_at     timestamptz,
  decided_at       timestamptz,
  decided_by       uuid,
  decision_note    text CHECK (length(decision_note) <= 2000),
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, ref),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id)   REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_code_id) REFERENCES cost_codes (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by)   REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)   REFERENCES users (tenant_id, id),
  CHECK (status <> 'approved' OR (value_approved IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'rejected' OR decided_at IS NOT NULL)
);

CREATE INDEX variations_project_idx ON variations (tenant_id, project_id, status);
CREATE TRIGGER variations_touch BEFORE UPDATE ON variations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE FUNCTION variations_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'new variations start as draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'variation % is % and cannot change', OLD.ref, OLD.status USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft'     AND NEW.status = 'submitted')
    OR (OLD.status = 'submitted' AND NEW.status IN ('draft', 'approved', 'rejected'))
  ) THEN
    RAISE EXCEPTION 'invalid variation transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER variations_guard BEFORE INSERT OR UPDATE ON variations
  FOR EACH ROW EXECUTE FUNCTION variations_guard();

-- ---------------------------------------------------------------------------
-- Valuations (interim payment applications / certificates)
--
-- All figures are cumulative to the period end, as on a JBCC/FIDIC/NEC payment
-- certificate:
--   gross_to_date      = work_done_to_date + materials_on_site
--   retention_to_date  = min(gross × retention %, contract value × limit %)
--   net_to_date        = gross_to_date − retention_to_date
--   amount_due         = net_to_date − previously_certified
-- The API computes them; the CHECKs below keep them consistent.
-- ---------------------------------------------------------------------------
CREATE TYPE valuation_status AS ENUM ('draft', 'submitted', 'certified', 'paid');

CREATE TABLE valuations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  project_id           uuid NOT NULL,
  valuation_no         integer NOT NULL CHECK (valuation_no >= 1),
  period_end           date NOT NULL,
  status               valuation_status NOT NULL DEFAULT 'draft',
  work_done_to_date    numeric(18, 2) NOT NULL CHECK (work_done_to_date >= 0),
  materials_on_site    numeric(18, 2) NOT NULL DEFAULT 0 CHECK (materials_on_site >= 0),
  gross_to_date        numeric(18, 2) NOT NULL,
  retention_pct        numeric(5, 2) NOT NULL,
  retention_to_date    numeric(18, 2) NOT NULL CHECK (retention_to_date >= 0),
  net_to_date          numeric(18, 2) NOT NULL,
  previously_certified numeric(18, 2) NOT NULL DEFAULT 0,
  amount_due           numeric(18, 2) NOT NULL,
  certificate_ref      text CHECK (length(certificate_ref) <= 100),
  notes                text NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
  submitted_at         timestamptz,
  certified_at         timestamptz,
  certified_by         uuid,
  paid_on              date,
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, valuation_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id)   REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, certified_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)   REFERENCES users (tenant_id, id),
  CHECK (gross_to_date = work_done_to_date + materials_on_site),
  CHECK (retention_to_date <= gross_to_date),
  CHECK (net_to_date = gross_to_date - retention_to_date),
  CHECK (amount_due = net_to_date - previously_certified),
  CHECK (status NOT IN ('certified', 'paid') OR (certified_at IS NOT NULL AND certificate_ref IS NOT NULL)),
  CHECK (status <> 'paid' OR paid_on IS NOT NULL)
);

CREATE INDEX valuations_project_idx ON valuations (tenant_id, project_id, valuation_no DESC);
CREATE TRIGGER valuations_touch BEFORE UPDATE ON valuations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE FUNCTION valuations_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'new valuations start as draft' USING ERRCODE = '23514';
    END IF;
    -- Valuations are sequential: the previous one must be certified first.
    IF EXISTS (SELECT 1 FROM valuations
                WHERE project_id = NEW.project_id AND status IN ('draft', 'submitted')) THEN
      RAISE EXCEPTION 'certify the open valuation before starting another' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'paid' THEN
    RAISE EXCEPTION 'valuation % is paid and cannot change', OLD.valuation_no USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'certified' THEN
    -- The only change allowed on a certified valuation is recording payment.
    IF NEW.status <> 'paid'
       OR (to_jsonb(NEW) - ARRAY['status', 'paid_on', 'updated_at'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'paid_on', 'updated_at']) THEN
      RAISE EXCEPTION 'valuation % is certified and cannot change', OLD.valuation_no USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft'     AND NEW.status = 'submitted')
    OR (OLD.status = 'submitted' AND NEW.status IN ('draft', 'certified'))
  ) THEN
    RAISE EXCEPTION 'invalid valuation transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER valuations_guard BEFORE INSERT OR UPDATE ON valuations
  FOR EACH ROW EXECUTE FUNCTION valuations_guard();

-- ---------------------------------------------------------------------------
-- Row Level Security + least privilege
-- ---------------------------------------------------------------------------
ALTER TABLE cost_codes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_codes   FORCE  ROW LEVEL SECURITY;
ALTER TABLE cost_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_entries FORCE  ROW LEVEL SECURITY;
ALTER TABLE variations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE variations   FORCE  ROW LEVEL SECURITY;
ALTER TABLE valuations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE valuations   FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON cost_codes
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON cost_entries
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON variations
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON valuations
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON cost_codes   TO constructos_app;
GRANT SELECT, INSERT                 ON cost_entries TO constructos_app;   -- append-only
GRANT SELECT, INSERT, UPDATE         ON variations   TO constructos_app;
GRANT SELECT, INSERT, UPDATE         ON valuations   TO constructos_app;
GRANT SELECT ON cost_codes, cost_entries, variations, valuations TO constructos_ai;
