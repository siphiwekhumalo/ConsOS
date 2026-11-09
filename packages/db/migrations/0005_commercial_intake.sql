-- =============================================================================
-- 0005 — Administration & Commercial: estimate intake and baseline lock
--
-- Governs the Scoping phase of the pipeline Scoping → Planning → Execution →
-- Invoicing. A client Job Card Estimate (JCE) arrives, is technically scoped,
-- compared line by line against internal takeoffs, approved by the client and
-- then frozen as the project baseline. Nothing downstream may start from an
-- estimate that is not locked.
--
-- Enforced IN THE DATABASE (not only the API):
--   * the stage machine (only the allowed transitions);
--   * the baseline freeze (a locked estimate and its lines can never change).
-- =============================================================================

-- New commercial module entitlement.
ALTER TABLE tenants DROP CONSTRAINT tenants_active_modules_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_active_modules_check
  CHECK (active_modules <@ ARRAY[
    'mod_commercial',
    'mod_payroll', 'mod_crm', 'mod_finance', 'mod_estimating', 'mod_procurement',
    'mod_field', 'mod_fleet', 'mod_hse', 'mod_portal', 'mod_ai'
  ]::text[]);

CREATE TYPE estimate_stage AS ENUM (
  'intake', 'technical_review', 'client_approval', 'baseline_locked', 'rejected'
);

CREATE TABLE estimates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  ref                 text NOT NULL CHECK (length(ref) BETWEEN 1 AND 40),       -- client JCE number
  title               text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  client_name         text NOT NULL CHECK (length(client_name) BETWEEN 1 AND 200),
  client_reference    text CHECK (length(client_reference) <= 100),            -- work order / enquiry no.
  stage               estimate_stage NOT NULL DEFAULT 'intake',
  project_id          uuid,                                                    -- set when the baseline is locked
  source_file_id      uuid,                                                    -- client JCE document
  client_approval_ref text CHECK (length(client_approval_ref) <= 100),          -- PO / approval reference
  rejection_reason    text CHECK (length(rejection_reason) <= 2000),
  -- Frozen baseline (copied at lock time; numeric, never float)
  baseline_client_total   numeric(18, 2),
  baseline_internal_total numeric(18, 2),
  locked_at           timestamptz,
  locked_by           uuid,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ref),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, locked_by)  REFERENCES users (tenant_id, id),
  CHECK (stage <> 'baseline_locked' OR (locked_at IS NOT NULL AND project_id IS NOT NULL AND client_approval_ref IS NOT NULL))
);

CREATE TABLE estimate_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  estimate_id    uuid NOT NULL,
  line_no        text NOT NULL CHECK (length(line_no) BETWEEN 1 AND 20),
  description    text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  unit           text NOT NULL CHECK (length(unit) BETWEEN 1 AND 20),
  -- Client's figures (from their JCE / BOQ). NULL = line not in the client's scope.
  client_qty     numeric(18, 3) CHECK (client_qty >= 0),
  client_rate    numeric(18, 2) CHECK (client_rate >= 0),
  -- Internal takeoff. NULL = not yet measured / priced internally.
  internal_qty   numeric(18, 3) CHECK (internal_qty >= 0),
  internal_rate  numeric(18, 2) CHECK (internal_rate >= 0),
  source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai_extraction')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (estimate_id, line_no),
  FOREIGN KEY (tenant_id, estimate_id) REFERENCES estimates (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX estimates_stage_idx ON estimates (tenant_id, stage, updated_at DESC);
CREATE INDEX estimate_lines_estimate_idx ON estimate_lines (estimate_id, line_no);

CREATE TRIGGER estimates_touch BEFORE UPDATE ON estimates FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER estimate_lines_touch BEFORE UPDATE ON estimate_lines FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Stage machine + baseline freeze on estimates
-- ---------------------------------------------------------------------------
CREATE FUNCTION estimates_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.stage <> 'intake' THEN
      RAISE EXCEPTION 'new estimates start at intake' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.stage = 'baseline_locked' THEN
    RAISE EXCEPTION 'estimate % is baseline-locked and cannot change', OLD.ref USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW.stage IS DISTINCT FROM OLD.stage AND NOT (
       (OLD.stage = 'intake'           AND NEW.stage IN ('technical_review', 'rejected'))
    OR (OLD.stage = 'technical_review' AND NEW.stage IN ('client_approval', 'intake', 'rejected'))
    OR (OLD.stage = 'client_approval'  AND NEW.stage IN ('baseline_locked', 'technical_review', 'rejected'))
    OR (OLD.stage = 'rejected'         AND NEW.stage = 'intake')
  ) THEN
    RAISE EXCEPTION 'invalid estimate transition % -> %', OLD.stage, NEW.stage USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER estimates_guard BEFORE INSERT OR UPDATE OR DELETE ON estimates
  FOR EACH ROW EXECUTE FUNCTION estimates_guard();

-- Lines may only change while their estimate is in intake or technical review.
CREATE FUNCTION estimate_lines_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_stage estimate_stage;
BEGIN
  SELECT stage INTO v_stage FROM estimates
   WHERE id = COALESCE(NEW.estimate_id, OLD.estimate_id);
  IF v_stage NOT IN ('intake', 'technical_review') THEN
    RAISE EXCEPTION 'estimate lines are frozen at stage %', v_stage USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

CREATE TRIGGER estimate_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON estimate_lines
  FOR EACH ROW EXECUTE FUNCTION estimate_lines_guard();

-- ---------------------------------------------------------------------------
-- Row Level Security + least privilege
-- ---------------------------------------------------------------------------
ALTER TABLE estimates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE estimates      FORCE  ROW LEVEL SECURITY;
ALTER TABLE estimate_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE estimate_lines FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON estimates
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON estimate_lines
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE                 ON estimates      TO constructos_app;
GRANT SELECT, INSERT, UPDATE, DELETE         ON estimate_lines TO constructos_app;
GRANT SELECT                                 ON estimates, estimate_lines TO constructos_ai;
