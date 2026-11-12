-- =============================================================================
-- 0011 — HR & payroll (Payroll module): employees, certifications, leave,
-- timesheets and monthly pay runs with PAYE, UIF and SDL.
--
-- Enforced IN THE DATABASE (not only the API):
--   * SARS tax tables are global reference data the app can only read;
--   * a day's hours per employee are bounded; approved time is frozen;
--   * nothing in a finalised pay period (time, leave, payslips) can change;
--   * payslip arithmetic must add up (net = gross − PAYE − UIF − deductions);
--   * approved leave cannot overlap for the same employee.
--
-- Personal information (POPIA): ID number, tax number and date of birth are
-- kept apart in employee_private, read only by payroll roles (API) and audited.
-- No bank account numbers are stored.
-- =============================================================================

-- Payroll journals are their own source, so they cannot be reversed as manual journals.
ALTER TYPE journal_source ADD VALUE 'payroll';

ALTER TABLE doc_counters DROP CONSTRAINT doc_counters_kind_check;
ALTER TABLE doc_counters ADD CONSTRAINT doc_counters_kind_check CHECK (kind IN (
  'journal', 'customer_invoice', 'payment_in', 'payment_out', 'purchase_order', 'rfq', 'goods_receipt',
  'work_order', 'incident', 'ncr', 'inspection', 'employee'
));

-- ---------------------------------------------------------------------------
-- SARS tax tables (global; one row per tax year, 1 March – end February)
-- ---------------------------------------------------------------------------
CREATE TABLE tax_tables (
  tax_year                  text PRIMARY KEY CHECK (tax_year ~ '^\d{4}/\d{2}$'),
  starts_on                 date NOT NULL UNIQUE,
  ends_on                   date NOT NULL,
  -- [{ "from": 0, "base": 0, "rate": 18 }, { "from": 237101, "base": 42678, "rate": 26 }, ...] (annual rand)
  brackets                  jsonb NOT NULL CHECK (jsonb_typeof(brackets) = 'array' AND jsonb_array_length(brackets) > 0),
  primary_rebate            numeric(12, 2) NOT NULL,
  secondary_rebate          numeric(12, 2) NOT NULL,   -- 65 and older
  tertiary_rebate           numeric(12, 2) NOT NULL,   -- 75 and older
  uif_ceiling_monthly       numeric(12, 2) NOT NULL,
  medical_credit_main       numeric(12, 2) NOT NULL,   -- per month
  medical_credit_first_dep  numeric(12, 2) NOT NULL,
  medical_credit_additional numeric(12, 2) NOT NULL,
  source                    text NOT NULL,
  CHECK (ends_on > starts_on)
);
GRANT SELECT ON tax_tables TO constructos_app, constructos_ai;

-- 2025/26 (1 Mar 2025 – 28 Feb 2026). The 2025 Budget left brackets, rebates
-- and medical credits unchanged from 2024/25. Later years are added by migration
-- once confirmed against SARS's published tables.
INSERT INTO tax_tables VALUES (
  '2025/26', '2025-03-01', '2026-02-28',
  '[{"from":0,"base":0,"rate":18},
    {"from":237101,"base":42678,"rate":26},
    {"from":370501,"base":77362,"rate":31},
    {"from":512801,"base":121475,"rate":36},
    {"from":673001,"base":179147,"rate":39},
    {"from":857901,"base":251258,"rate":41},
    {"from":1817001,"base":644489,"rate":45}]'::jsonb,
  17235, 9444, 3145, 17712, 364, 364, 246,
  'SARS rates of tax for individuals 2025/26 (unchanged from 2024/25); UIF ceiling R17 712/month'
);

-- ---------------------------------------------------------------------------
-- Payroll settings
-- ---------------------------------------------------------------------------
CREATE TABLE payroll_settings (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE RESTRICT,
  -- SDL applies when annual payroll exceeds R500 000.
  sdl_liable      boolean NOT NULL DEFAULT true,
  -- Hours in a month, to turn a monthly salary into an hourly rate for overtime (45 h × 52 / 12 = 195).
  monthly_hours   numeric(5, 1) NOT NULL DEFAULT 195 CHECK (monthly_hours BETWEEN 100 AND 260),
  paye_reference  text CHECK (paye_reference ~ '^7\d{9}$'),
  uif_reference   text CHECK (length(uif_reference) <= 20),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Employees
-- ---------------------------------------------------------------------------
CREATE TABLE employees (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  employee_no         text NOT NULL CHECK (length(employee_no) BETWEEN 1 AND 20),
  first_name          text NOT NULL CHECK (length(first_name) BETWEEN 1 AND 100),
  last_name           text NOT NULL CHECK (length(last_name) BETWEEN 1 AND 100),
  occupation          text NOT NULL CHECK (length(occupation) BETWEEN 1 AND 100),
  employment_type     text NOT NULL CHECK (employment_type IN ('permanent', 'fixed_term', 'casual')),
  pay_basis           text NOT NULL CHECK (pay_basis IN ('monthly', 'hourly')),
  -- Monthly salary, or hourly rate, in rand.
  rate                numeric(12, 2) NOT NULL CHECK (rate > 0),
  medical_aid_members integer NOT NULL DEFAULT 0 CHECK (medical_aid_members BETWEEN 0 AND 20),
  start_date          date NOT NULL,
  end_date            date,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'terminated')),
  termination_reason  text CHECK (length(termination_reason) <= 500),
  default_project_id  uuid,
  phone               text CHECK (length(phone) <= 30),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, default_project_id) REFERENCES projects (tenant_id, id),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK ((status = 'terminated') = (end_date IS NOT NULL AND termination_reason IS NOT NULL))
);
CREATE TRIGGER employees_touch BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE employee_private (
  employee_id   uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  id_number     text CHECK (id_number ~ '^\d{13}$'),
  passport_no   text CHECK (length(passport_no) <= 20),
  tax_number    text CHECK (tax_number ~ '^[0-9]{10}$'),
  date_of_birth date NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  CHECK (id_number IS NOT NULL OR passport_no IS NOT NULL)
);
CREATE TRIGGER employee_private_touch BEFORE UPDATE ON employee_private FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE certifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  employee_id    uuid NOT NULL,
  kind           text NOT NULL CHECK (length(kind) BETWEEN 1 AND 100),   -- e.g. Working at heights, Medical fitness
  certificate_no text CHECK (length(certificate_no) <= 60),
  issued_on      date NOT NULL,
  expires_on     date,
  file_id        uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  CHECK (expires_on IS NULL OR expires_on > issued_on)
);
CREATE INDEX certifications_employee_idx ON certifications (employee_id, expires_on);

-- ---------------------------------------------------------------------------
-- Pay runs (declared before time and leave, which check them)
-- ---------------------------------------------------------------------------
CREATE TABLE pay_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  period         text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),   -- YYYY-MM
  pay_date       date NOT NULL,
  tax_year       text NOT NULL REFERENCES tax_tables (tax_year),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalised')),
  gross_total    numeric(18, 2) NOT NULL DEFAULT 0,
  paye_total     numeric(18, 2) NOT NULL DEFAULT 0,
  uif_total      numeric(18, 2) NOT NULL DEFAULT 0,   -- employee + employer
  sdl_total      numeric(18, 2) NOT NULL DEFAULT 0,
  net_total      numeric(18, 2) NOT NULL DEFAULT 0,
  journal_id     uuid,
  finalised_at   timestamptz,
  finalised_by   uuid,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id)   REFERENCES journals (tenant_id, id),
  FOREIGN KEY (tenant_id, finalised_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)   REFERENCES users (tenant_id, id),
  CHECK (status <> 'finalised' OR (finalised_at IS NOT NULL AND finalised_by IS NOT NULL))
);
CREATE TRIGGER pay_runs_touch BEFORE UPDATE ON pay_runs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER pay_runs_freeze BEFORE UPDATE OR DELETE ON pay_runs FOR EACH ROW EXECUTE FUNCTION freeze_when_final('status', 'finalised');

/** True when the month containing `d` has a finalised pay run. */
CREATE FUNCTION period_finalised(p_tenant uuid, d date) RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM pay_runs WHERE tenant_id = p_tenant AND period = to_char(d, 'YYYY-MM') AND status = 'finalised')
$$;

-- ---------------------------------------------------------------------------
-- Timesheets
-- ---------------------------------------------------------------------------
CREATE TABLE time_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  employee_id    uuid NOT NULL,
  project_id     uuid NOT NULL,
  cost_code_id   uuid,
  work_date      date NOT NULL,
  normal_hours   numeric(4, 2) NOT NULL DEFAULT 0 CHECK (normal_hours BETWEEN 0 AND 12),
  overtime_hours numeric(4, 2) NOT NULL DEFAULT 0 CHECK (overtime_hours BETWEEN 0 AND 12),   -- × 1.5
  sunday_hours   numeric(4, 2) NOT NULL DEFAULT 0 CHECK (sunday_hours BETWEEN 0 AND 12),     -- Sunday / public holiday × 2
  status         text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected')),
  note           text CHECK (length(note) <= 300),
  captured_by    uuid NOT NULL,
  approved_by    uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id)  REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id)   REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_code_id) REFERENCES cost_codes (tenant_id, id),
  FOREIGN KEY (tenant_id, captured_by)  REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by)  REFERENCES users (tenant_id, id),
  CHECK (normal_hours + overtime_hours + sunday_hours > 0),
  CHECK (status <> 'approved' OR approved_by IS NOT NULL)
);
CREATE INDEX time_entries_employee_idx ON time_entries (employee_id, work_date);
CREATE INDEX time_entries_project_idx ON time_entries (tenant_id, project_id, work_date);
CREATE TRIGGER time_entries_touch BEFORE UPDATE ON time_entries FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE FUNCTION time_entries_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  r record := COALESCE(NEW, OLD);
  v_total numeric;
BEGIN
  IF period_finalised(r.tenant_id, r.work_date) OR (TG_OP = 'UPDATE' AND period_finalised(OLD.tenant_id, OLD.work_date)) THEN
    RAISE EXCEPTION 'payroll for % is finalised; its timesheets cannot change', to_char(r.work_date, 'YYYY-MM') USING ERRCODE = '42501';
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.status = 'approved' AND NOT (TG_OP = 'UPDATE' AND NEW.status = 'submitted' AND (to_jsonb(NEW) - ARRAY['status','approved_by','updated_at']) = (to_jsonb(OLD) - ARRAY['status','approved_by','updated_at'])) THEN
    RAISE EXCEPTION 'approved time cannot change; return it to submitted first' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = NEW.employee_id AND NEW.work_date >= e.start_date AND (e.end_date IS NULL OR NEW.work_date <= e.end_date)) THEN
    RAISE EXCEPTION 'the employee was not employed on %', NEW.work_date USING ERRCODE = '23514';
  END IF;
  IF NEW.cost_code_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cost_codes WHERE id = NEW.cost_code_id AND project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'cost code does not belong to this project' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(sum(normal_hours + overtime_hours + sunday_hours), 0) INTO v_total
    FROM time_entries WHERE employee_id = NEW.employee_id AND work_date = NEW.work_date AND id <> NEW.id AND status <> 'rejected';
  IF v_total + NEW.normal_hours + NEW.overtime_hours + NEW.sunday_hours > 16 THEN
    RAISE EXCEPTION 'more than 16 hours recorded for this employee on %', NEW.work_date USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER time_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON time_entries FOR EACH ROW EXECUTE FUNCTION time_entries_guard();

-- ---------------------------------------------------------------------------
-- Leave (BCEA: annual, sick, family responsibility; plus unpaid)
-- ---------------------------------------------------------------------------
CREATE TABLE leave_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  employee_id  uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('annual', 'sick', 'family_responsibility', 'unpaid')),
  starts_on    date NOT NULL,
  ends_on      date NOT NULL,
  days         numeric(5, 1) NOT NULL CHECK (days > 0 AND days <= 365),   -- working days
  status       text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  note         text CHECK (length(note) <= 500),
  decided_by   uuid,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by)  REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)  REFERENCES users (tenant_id, id),
  CHECK (ends_on >= starts_on),
  CHECK (status NOT IN ('approved', 'rejected') OR decided_by IS NOT NULL)
);
CREATE INDEX leave_requests_employee_idx ON leave_requests (employee_id, starts_on);
CREATE TRIGGER leave_requests_touch BEFORE UPDATE ON leave_requests FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE FUNCTION leave_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('rejected', 'cancelled') THEN
      RAISE EXCEPTION 'leave request is % and cannot change', OLD.status USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'approved' AND NOT (NEW.status = 'cancelled'
         AND (to_jsonb(NEW) - ARRAY['status','updated_at']) = (to_jsonb(OLD) - ARRAY['status','updated_at'])) THEN
      RAISE EXCEPTION 'approved leave can only be cancelled' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF period_finalised(NEW.tenant_id, NEW.starts_on) OR period_finalised(NEW.tenant_id, NEW.ends_on) THEN
    RAISE EXCEPTION 'payroll for this period is finalised; its leave cannot change' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'approved' AND EXISTS (
       SELECT 1 FROM leave_requests l
        WHERE l.employee_id = NEW.employee_id AND l.id <> NEW.id AND l.status = 'approved'
          AND l.starts_on <= NEW.ends_on AND l.ends_on >= NEW.starts_on) THEN
    RAISE EXCEPTION 'overlaps leave already approved for this employee' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER leave_requests_guard BEFORE INSERT OR UPDATE ON leave_requests FOR EACH ROW EXECUTE FUNCTION leave_requests_guard();

-- ---------------------------------------------------------------------------
-- Payslips
-- ---------------------------------------------------------------------------
CREATE TABLE payslips (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  pay_run_id        uuid NOT NULL,
  employee_id       uuid NOT NULL,
  -- [{ "code": "basic", "label": "Basic salary", "quantity": "1", "rate": "...", "amount": "..." }, ...]
  earnings          jsonb NOT NULL CHECK (jsonb_typeof(earnings) = 'array'),
  gross             numeric(12, 2) NOT NULL CHECK (gross >= 0),
  paye              numeric(12, 2) NOT NULL CHECK (paye >= 0),
  uif_employee      numeric(12, 2) NOT NULL CHECK (uif_employee >= 0),
  other_deductions  numeric(12, 2) NOT NULL DEFAULT 0 CHECK (other_deductions >= 0),
  net               numeric(12, 2) NOT NULL,
  uif_employer      numeric(12, 2) NOT NULL CHECK (uif_employer >= 0),
  sdl               numeric(12, 2) NOT NULL CHECK (sdl >= 0),
  employer_cost     numeric(12, 2) NOT NULL,
  hours_worked      numeric(8, 2) NOT NULL DEFAULT 0,
  UNIQUE (pay_run_id, employee_id),
  FOREIGN KEY (tenant_id, pay_run_id)  REFERENCES pay_runs (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  CHECK (net = gross - paye - uif_employee - other_deductions),
  CHECK (employer_cost = gross + uif_employer + sdl)
);

CREATE FUNCTION payslips_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM pay_runs WHERE id = COALESCE(NEW.pay_run_id, OLD.pay_run_id);
  IF v_status = 'finalised' THEN
    RAISE EXCEPTION 'the pay run is finalised; payslips cannot change' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
CREATE TRIGGER payslips_guard BEFORE INSERT OR UPDATE OR DELETE ON payslips FOR EACH ROW EXECUTE FUNCTION payslips_guard();

-- ---------------------------------------------------------------------------
-- Row Level Security + least privilege
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payroll_settings', 'employees', 'employee_private', 'certifications', 'pay_runs', 'time_entries', 'leave_requests', 'payslips'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE         ON payroll_settings, employees, employee_private, pay_runs, leave_requests TO constructos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON time_entries, payslips                                                   TO constructos_app;
GRANT SELECT, INSERT, DELETE         ON certifications                                                           TO constructos_app;
GRANT EXECUTE ON FUNCTION period_finalised(uuid, date) TO constructos_app;
-- The AI engine gets no access to employee or pay data.
