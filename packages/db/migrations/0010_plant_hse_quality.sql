-- =============================================================================
-- 0010 — Plant & equipment (Fleet module), HSE and quality (HSE module).
--
-- Enforced IN THE DATABASE (not only the API):
--   * meter readings only go up; plant usage is append-only;
--   * a disposed asset cannot be used, moved or changed;
--   * completed work orders, closed incidents, closed NCRs, signed
--     inspections and completed corrective actions are frozen;
--   * an incident cannot close without a root cause; an NCR cannot close
--     without a corrective action and someone verifying it.
-- =============================================================================

ALTER TABLE doc_counters DROP CONSTRAINT doc_counters_kind_check;
ALTER TABLE doc_counters ADD CONSTRAINT doc_counters_kind_check CHECK (kind IN (
  'journal', 'customer_invoice', 'payment_in', 'payment_out', 'purchase_order', 'rfq', 'goods_receipt',
  'work_order', 'incident', 'ncr', 'inspection'
));

-- Generic "this record is final" guard: once `col` reaches one of the final
-- values (TG_ARGV[1..]), the row can no longer change or be deleted.
CREATE FUNCTION freeze_when_final() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_old text := to_jsonb(OLD) ->> TG_ARGV[0];
BEGIN
  IF v_old = ANY (TG_ARGV[1:]) THEN
    RAISE EXCEPTION '% is % and cannot change', TG_TABLE_NAME, v_old USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

-- =============================================================================
-- Plant & equipment
-- =============================================================================
CREATE TYPE asset_category AS ENUM ('earthmoving', 'lifting', 'vehicle', 'generator', 'compressor', 'scaffolding', 'tools', 'other');
CREATE TYPE asset_status AS ENUM ('available', 'on_site', 'under_maintenance', 'broken_down', 'disposed');

CREATE TABLE assets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  asset_no            text NOT NULL CHECK (length(asset_no) BETWEEN 1 AND 30),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  category            asset_category NOT NULL,
  make                text CHECK (length(make) <= 100),
  model               text CHECK (length(model) <= 100),
  serial_no           text CHECK (length(serial_no) <= 100),
  registration        text CHECK (length(registration) <= 30),
  year                integer CHECK (year BETWEEN 1950 AND 2100),
  ownership           text NOT NULL DEFAULT 'owned' CHECK (ownership IN ('owned', 'hired_in')),
  hired_from_id       uuid,                                          -- supplier, for hired-in plant
  status              asset_status NOT NULL DEFAULT 'available',
  current_project_id  uuid,
  -- Internal charge-out rate to projects.
  rate_unit           text NOT NULL DEFAULT 'day' CHECK (rate_unit IN ('hour', 'day')),
  charge_rate         numeric(18, 2) NOT NULL DEFAULT 0 CHECK (charge_rate >= 0),
  meter_unit          text NOT NULL DEFAULT 'none' CHECK (meter_unit IN ('hours', 'km', 'none')),
  meter_reading       numeric(12, 1) NOT NULL DEFAULT 0 CHECK (meter_reading >= 0),
  purchase_date       date,
  purchase_value      numeric(18, 2) CHECK (purchase_value >= 0),
  -- Compliance: licence disc, roadworthy (COF), load test (lifting equipment), calibration.
  licence_expiry      date,
  roadworthy_expiry   date,
  load_test_expiry    date,
  calibration_expiry  date,
  notes               text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  disposed_on         date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, asset_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, hired_from_id)      REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, current_project_id) REFERENCES projects (tenant_id, id),
  CHECK ((status = 'on_site') = (current_project_id IS NOT NULL)),
  CHECK ((status = 'disposed') = (disposed_on IS NOT NULL)),
  CHECK (ownership = 'owned' OR hired_from_id IS NOT NULL)
);
CREATE TRIGGER assets_touch BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER assets_freeze BEFORE UPDATE OR DELETE ON assets FOR EACH ROW EXECUTE FUNCTION freeze_when_final('status', 'disposed');

-- Where each asset has been (history of moves between site and yard).
CREATE TABLE asset_allocations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  asset_id    uuid NOT NULL,
  project_id  uuid,                         -- NULL = returned to the yard
  moved_on    date NOT NULL,
  note        text CHECK (length(note) <= 500),
  moved_by    uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, asset_id)   REFERENCES assets (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, moved_by)   REFERENCES users (tenant_id, id)
);
CREATE INDEX asset_allocations_asset_idx ON asset_allocations (asset_id, moved_on DESC);

-- Meter readings: append-only and never going backwards.
CREATE TABLE asset_meter_readings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  asset_id    uuid NOT NULL,
  read_on     date NOT NULL,
  reading     numeric(12, 1) NOT NULL CHECK (reading >= 0),
  recorded_by uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, asset_id)    REFERENCES assets (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX asset_meter_readings_asset_idx ON asset_meter_readings (asset_id, read_on DESC);

CREATE FUNCTION asset_meter_readings_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_unit    text;
  v_status  asset_status;
  v_current numeric;
BEGIN
  SELECT meter_unit, status, meter_reading INTO v_unit, v_status, v_current FROM assets WHERE id = NEW.asset_id;
  IF v_unit = 'none' THEN
    RAISE EXCEPTION 'this asset has no meter' USING ERRCODE = '23514';
  END IF;
  IF v_status = 'disposed' THEN
    RAISE EXCEPTION 'the asset has been disposed of' USING ERRCODE = '23514';
  END IF;
  IF NEW.reading < v_current THEN
    RAISE EXCEPTION 'meter reading % is lower than the last reading %', NEW.reading, v_current USING ERRCODE = '23514';
  END IF;
  UPDATE assets SET meter_reading = NEW.reading WHERE id = NEW.asset_id;
  RETURN NEW;
END
$$;
CREATE TRIGGER asset_meter_readings_guard BEFORE INSERT ON asset_meter_readings FOR EACH ROW EXECUTE FUNCTION asset_meter_readings_guard();

-- Plant usage charged to projects (append-only; each row also becomes a
-- project cost entry with source 'plant').
CREATE TABLE plant_usage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  asset_id      uuid NOT NULL,
  project_id    uuid NOT NULL,
  cost_code_id  uuid NOT NULL,
  used_on       date NOT NULL,
  quantity      numeric(8, 2) NOT NULL CHECK (quantity > 0 AND quantity <= 24),   -- hours or days
  rate_unit     text NOT NULL CHECK (rate_unit IN ('hour', 'day')),
  rate          numeric(18, 2) NOT NULL CHECK (rate >= 0),
  amount        numeric(18, 2) NOT NULL CHECK (amount >= 0),
  operator_name text CHECK (length(operator_name) <= 100),
  note          text CHECK (length(note) <= 500),
  cost_entry_id uuid,
  recorded_by   uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id)      REFERENCES assets (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id)    REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_code_id)  REFERENCES cost_codes (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_entry_id) REFERENCES cost_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by)   REFERENCES users (tenant_id, id),
  CHECK (amount = round(quantity * rate, 2)),
  CHECK (rate_unit = 'hour' OR quantity <= 1)
);
CREATE INDEX plant_usage_asset_idx ON plant_usage (asset_id, used_on DESC);
CREATE INDEX plant_usage_project_idx ON plant_usage (tenant_id, project_id, used_on);

CREATE FUNCTION plant_usage_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM assets WHERE id = NEW.asset_id AND status = 'disposed') THEN
    RAISE EXCEPTION 'the asset has been disposed of' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cost_codes WHERE id = NEW.cost_code_id AND project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'cost code does not belong to this project' USING ERRCODE = '23514';
  END IF;
  -- A day-rated asset is charged at most one day per date, across all projects.
  IF NEW.rate_unit = 'day' AND (SELECT coalesce(sum(quantity), 0) FROM plant_usage
       WHERE asset_id = NEW.asset_id AND used_on = NEW.used_on AND rate_unit = 'day') + NEW.quantity > 1 THEN
    RAISE EXCEPTION 'the asset is already charged for a full day on %', NEW.used_on USING ERRCODE = '23514';
  END IF;
  IF NEW.rate_unit = 'hour' AND (SELECT coalesce(sum(quantity), 0) FROM plant_usage
       WHERE asset_id = NEW.asset_id AND used_on = NEW.used_on AND rate_unit = 'hour') + NEW.quantity > 24 THEN
    RAISE EXCEPTION 'more than 24 hours charged for this asset on %', NEW.used_on USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER plant_usage_guard BEFORE INSERT ON plant_usage FOR EACH ROW EXECUTE FUNCTION plant_usage_guard();

-- Maintenance plans: a service every N hours / km and/or every N days.
CREATE TABLE maintenance_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  asset_id         uuid NOT NULL,
  description      text NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  interval_meter   numeric(12, 1) CHECK (interval_meter > 0),
  interval_days    integer CHECK (interval_days BETWEEN 1 AND 3650),
  last_done_on     date,
  last_done_meter  numeric(12, 1),
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets (tenant_id, id),
  CHECK (interval_meter IS NOT NULL OR interval_days IS NOT NULL)
);
CREATE TRIGGER maintenance_plans_touch BEFORE UPDATE ON maintenance_plans FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TYPE work_order_status AS ENUM ('open', 'in_progress', 'completed', 'cancelled');

CREATE TABLE work_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  wo_no           integer NOT NULL,
  asset_id        uuid NOT NULL,
  plan_id         uuid,
  kind            text NOT NULL CHECK (kind IN ('service', 'repair', 'breakdown', 'inspection')),
  description     text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  status          work_order_status NOT NULL DEFAULT 'open',
  reported_on     date NOT NULL,
  completed_on    date,
  meter_at_completion numeric(12, 1),
  work_done       text CHECK (length(work_done) <= 2000),
  labour_cost     numeric(18, 2) NOT NULL DEFAULT 0 CHECK (labour_cost >= 0),
  parts_cost      numeric(18, 2) NOT NULL DEFAULT 0 CHECK (parts_cost >= 0),
  downtime_hours  numeric(8, 1) NOT NULL DEFAULT 0 CHECK (downtime_hours >= 0),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, wo_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id)   REFERENCES assets (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id)    REFERENCES maintenance_plans (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  CHECK (status <> 'completed' OR (completed_on IS NOT NULL AND work_done IS NOT NULL)),
  CHECK (completed_on IS NULL OR completed_on >= reported_on)
);
CREATE INDEX work_orders_asset_idx ON work_orders (asset_id, reported_on DESC);
CREATE TRIGGER work_orders_touch BEFORE UPDATE ON work_orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER work_orders_freeze BEFORE UPDATE OR DELETE ON work_orders FOR EACH ROW EXECUTE FUNCTION freeze_when_final('status', 'completed', 'cancelled');

-- =============================================================================
-- HSE
-- =============================================================================
CREATE TYPE incident_type AS ENUM ('injury', 'near_miss', 'property_damage', 'environmental', 'dangerous_occurrence', 'vehicle');
CREATE TYPE incident_severity AS ENUM ('none', 'first_aid', 'medical_treatment', 'restricted_work', 'lost_time', 'fatality');
CREATE TYPE incident_status AS ENUM ('reported', 'investigating', 'closed');

CREATE TABLE incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  incident_no      integer NOT NULL,
  project_id       uuid,
  occurred_at      timestamptz NOT NULL,
  type             incident_type NOT NULL,
  severity         incident_severity NOT NULL DEFAULT 'none',
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description      text NOT NULL CHECK (length(description) BETWEEN 1 AND 5000),
  location         text CHECK (length(location) <= 200),
  -- Personal information (POPIA): name only, for COIDA reporting. No ID numbers or medical detail here.
  injured_person   text CHECK (length(injured_person) <= 200),
  days_lost        integer NOT NULL DEFAULT 0 CHECK (days_lost >= 0),
  asset_id         uuid,
  status           incident_status NOT NULL DEFAULT 'reported',
  immediate_cause  text CHECK (length(immediate_cause) <= 2000),
  root_cause       text CHECK (length(root_cause) <= 2000),
  -- OHSA s24 (DEL / DoEL report) and COIDA (W.Cl.2) are flagged by the API from type and severity.
  dol_reportable   boolean NOT NULL DEFAULT false,
  dol_reported_on  date,
  coida_reportable boolean NOT NULL DEFAULT false,
  coida_reported_on date,
  reported_by      uuid NOT NULL,
  closed_at        timestamptz,
  closed_by        uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, incident_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id)  REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id)    REFERENCES assets (tenant_id, id),
  FOREIGN KEY (tenant_id, reported_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, closed_by)   REFERENCES users (tenant_id, id),
  CHECK (status <> 'closed' OR (root_cause IS NOT NULL AND closed_at IS NOT NULL AND closed_by IS NOT NULL)),
  CHECK (severity <> 'lost_time' OR days_lost > 0),
  -- A near miss, by definition, harmed nobody.
  CHECK (type <> 'near_miss' OR (severity = 'none' AND days_lost = 0))
);
CREATE INDEX incidents_occurred_idx ON incidents (tenant_id, occurred_at DESC);
CREATE TRIGGER incidents_touch BEFORE UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER incidents_freeze BEFORE UPDATE OR DELETE ON incidents FOR EACH ROW EXECUTE FUNCTION freeze_when_final('status', 'closed');

CREATE TABLE toolbox_talks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  project_id   uuid NOT NULL,
  held_on      date NOT NULL,
  topic        text NOT NULL CHECK (length(topic) BETWEEN 1 AND 200),
  presenter    text NOT NULL CHECK (length(presenter) BETWEEN 1 AND 100),
  attendees    integer NOT NULL CHECK (attendees BETWEEN 1 AND 5000),
  notes        text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  recorded_by  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id)  REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX toolbox_talks_idx ON toolbox_talks (tenant_id, held_on DESC);

-- =============================================================================
-- Quality: inspections and non-conformance reports
-- =============================================================================
CREATE TYPE inspection_kind AS ENUM ('safety', 'quality', 'plant_pre_use', 'environmental');

-- Signed inspection records: insert-only (no UPDATE/DELETE grant).
CREATE TABLE inspections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  inspection_no  integer NOT NULL,
  project_id     uuid,
  asset_id       uuid,
  kind           inspection_kind NOT NULL,
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  inspected_on   date NOT NULL,
  inspector      uuid NOT NULL,
  -- [{ "item": "...", "result": "pass" | "fail" | "na", "note": "..." }]
  items          jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 200),
  failed_items   integer NOT NULL CHECK (failed_items >= 0),
  passed         boolean NOT NULL,
  notes          text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, inspection_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id)   REFERENCES assets (tenant_id, id),
  FOREIGN KEY (tenant_id, inspector)  REFERENCES users (tenant_id, id),
  CHECK (project_id IS NOT NULL OR asset_id IS NOT NULL),
  CHECK (passed = (failed_items = 0))
);
CREATE INDEX inspections_idx ON inspections (tenant_id, inspected_on DESC);

-- The stored outcome must agree with the checklist.
CREATE FUNCTION inspections_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_failed integer;
BEGIN
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.items) e
              WHERE NOT (e ? 'item') OR coalesce(e ->> 'result', '') NOT IN ('pass', 'fail', 'na')) THEN
    RAISE EXCEPTION 'every checklist item needs a name and a result of pass, fail or na' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO v_failed FROM jsonb_array_elements(NEW.items) e WHERE e ->> 'result' = 'fail';
  IF v_failed <> NEW.failed_items THEN
    RAISE EXCEPTION 'failed item count does not match the checklist' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inspections_guard BEFORE INSERT ON inspections FOR EACH ROW EXECUTE FUNCTION inspections_guard();

CREATE TYPE ncr_status AS ENUM ('open', 'action_proposed', 'closed');

CREATE TABLE ncrs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  ncr_no            integer NOT NULL,
  project_id        uuid NOT NULL,
  inspection_id     uuid,
  title             text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description       text NOT NULL CHECK (length(description) BETWEEN 1 AND 5000),
  category          text NOT NULL CHECK (category IN ('workmanship', 'material', 'design', 'procedure', 'documentation', 'other')),
  severity          text NOT NULL CHECK (severity IN ('minor', 'major', 'critical')),
  responsible_party text CHECK (length(responsible_party) <= 200),
  supplier_id       uuid,                               -- when a supplier or subcontractor is responsible
  raised_on         date NOT NULL,
  due_on            date,
  status            ncr_status NOT NULL DEFAULT 'open',
  root_cause        text CHECK (length(root_cause) <= 2000),
  corrective_action text CHECK (length(corrective_action) <= 2000),
  rework_cost       numeric(18, 2) NOT NULL DEFAULT 0 CHECK (rework_cost >= 0),
  verified_by       uuid,
  closed_on         date,
  raised_by         uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ncr_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id)    REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, inspection_id) REFERENCES inspections (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id)   REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, verified_by)   REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, raised_by)     REFERENCES users (tenant_id, id),
  CHECK (status = 'open' OR corrective_action IS NOT NULL),
  CHECK (status <> 'closed' OR (verified_by IS NOT NULL AND closed_on IS NOT NULL AND root_cause IS NOT NULL))
);
CREATE INDEX ncrs_idx ON ncrs (tenant_id, status, raised_on DESC);
CREATE TRIGGER ncrs_touch BEFORE UPDATE ON ncrs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER ncrs_freeze BEFORE UPDATE OR DELETE ON ncrs FOR EACH ROW EXECUTE FUNCTION freeze_when_final('status', 'closed');

-- Corrective actions from incidents, NCRs and inspections, tracked in one place.
CREATE TABLE corrective_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  source_type   text NOT NULL CHECK (source_type IN ('incident', 'ncr', 'inspection')),
  source_id     uuid NOT NULL,
  project_id    uuid,
  action        text NOT NULL CHECK (length(action) BETWEEN 1 AND 1000),
  owner_name    text NOT NULL CHECK (length(owner_name) BETWEEN 1 AND 100),
  due_on        date NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  completed_on  date,
  completion_note text CHECK (length(completion_note) <= 1000),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  CHECK ((status = 'done') = (completed_on IS NOT NULL))
);
CREATE INDEX corrective_actions_idx ON corrective_actions (tenant_id, status, due_on);
CREATE INDEX corrective_actions_source_idx ON corrective_actions (source_type, source_id);
CREATE TRIGGER corrective_actions_touch BEFORE UPDATE ON corrective_actions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER corrective_actions_freeze BEFORE UPDATE OR DELETE ON corrective_actions FOR EACH ROW EXECUTE FUNCTION freeze_when_final('status', 'done');

CREATE TABLE hse_settings (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE RESTRICT,
  -- Converts site-diary headcount into man-hours for LTIFR / TRIFR.
  hours_per_shift numeric(4, 1) NOT NULL DEFAULT 9 CHECK (hours_per_shift BETWEEN 1 AND 24),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Row Level Security + least privilege
-- =============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'assets', 'asset_allocations', 'asset_meter_readings', 'plant_usage', 'maintenance_plans', 'work_orders',
    'incidents', 'toolbox_talks', 'inspections', 'ncrs', 'corrective_actions', 'hse_settings'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO constructos_ai', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON assets, maintenance_plans, work_orders, incidents, ncrs, corrective_actions, hse_settings TO constructos_app;
GRANT SELECT, INSERT         ON asset_allocations, asset_meter_readings, plant_usage, toolbox_talks, inspections TO constructos_app;  -- append-only
