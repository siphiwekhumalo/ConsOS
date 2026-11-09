-- =============================================================================
-- 0003 — Per-service database roles, site diary (Module 1), AI jobs
--
-- Each backend service connects as its own role (least privilege):
--   constructos_app  — core API (system of record)
--   constructos_sync — edge-sync service: site diary read/write + read projects
--   constructos_ai   — AI engine: read-only business data, writes only ai_jobs
-- None has BYPASSRLS, so every service is bound by the same tenant policies.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'constructos_sync') THEN
    CREATE ROLE constructos_sync NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'constructos_ai') THEN
    CREATE ROLE constructos_ai NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO constructos_sync, constructos_ai;
GRANT EXECUTE ON FUNCTION current_tenant_id() TO constructos_sync, constructos_ai;

-- Both services may append audit events (e.g. "diary.synced", "ai_job.completed").
GRANT SELECT, INSERT ON audit_events TO constructos_sync, constructos_ai;
GRANT SELECT ON audit_chain_heads TO constructos_sync, constructos_ai;

-- Global change counter for sync pull cursors. Monotonic across all tenants;
-- gaps are fine, clients only need "greater than my cursor".
CREATE SEQUENCE sync_change_seq;
GRANT USAGE ON SEQUENCE sync_change_seq TO constructos_app, constructos_sync;

CREATE FUNCTION bump_change_seq() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.change_seq := nextval('sync_change_seq');
  IF TG_OP = 'UPDATE' THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- Site diary (daily site log). Rows are created on devices — offline — with a
-- client-generated UUID, which makes pushes naturally idempotent.
-- ---------------------------------------------------------------------------
CREATE TYPE weather_condition AS ENUM ('clear', 'cloudy', 'rain', 'storm', 'wind', 'extreme_heat');

CREATE TABLE site_diary_entries (
  id               uuid PRIMARY KEY,                    -- client-generated
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  project_id       uuid NOT NULL,
  entry_date       date NOT NULL,
  weather          weather_condition,
  workforce_count  integer CHECK (workforce_count BETWEEN 0 AND 100000),
  work_completed   text NOT NULL DEFAULT '' CHECK (length(work_completed) <= 20000),
  delays           text NOT NULL DEFAULT '' CHECK (length(delays) <= 20000),
  safety_notes     text NOT NULL DEFAULT '' CHECK (length(safety_notes) <= 20000),
  created_by       uuid NOT NULL,
  device_id        text CHECK (length(device_id) <= 100),
  client_recorded_at timestamptz,                       -- device clock, informational only
  version          integer NOT NULL DEFAULT 1,
  change_seq       bigint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);

CREATE INDEX site_diary_project_idx ON site_diary_entries (tenant_id, project_id, entry_date DESC);
CREATE INDEX site_diary_change_idx  ON site_diary_entries (tenant_id, change_seq);

CREATE TRIGGER site_diary_change BEFORE INSERT OR UPDATE ON site_diary_entries
  FOR EACH ROW EXECUTE FUNCTION bump_change_seq();
CREATE TRIGGER site_diary_touch BEFORE UPDATE ON site_diary_entries
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE site_diary_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_diary_entries FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON site_diary_entries
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON site_diary_entries TO constructos_app, constructos_sync;
GRANT SELECT ON site_diary_entries TO constructos_ai;

-- Projects: sync needs them as reference data on devices; AI reads them.
GRANT SELECT ON projects TO constructos_sync, constructos_ai;
GRANT SELECT ON tenants  TO constructos_sync, constructos_ai;
-- users: sync validates created_by via FK only (no direct read needed).

-- ---------------------------------------------------------------------------
-- AI jobs: requested by users, executed asynchronously by the AI engine.
-- Results are SUGGESTIONS stored here; they never write business tables.
-- ---------------------------------------------------------------------------
CREATE TYPE ai_job_status AS ENUM ('queued', 'running', 'succeeded', 'failed');

CREATE TABLE ai_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  kind         text NOT NULL CHECK (kind IN ('boq_extraction', 'diary_risk_review')),
  status       ai_job_status NOT NULL DEFAULT 'queued',
  project_id   uuid,
  file_id      uuid,
  requested_by uuid NOT NULL,
  model        text,
  result       jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id)   REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES users (tenant_id, id)
);

CREATE INDEX ai_jobs_tenant_idx ON ai_jobs (tenant_id, created_at DESC);

CREATE TRIGGER ai_jobs_touch BEFORE UPDATE ON ai_jobs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE ai_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_jobs FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_jobs
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON ai_jobs TO constructos_ai;
GRANT SELECT ON ai_jobs TO constructos_app;
GRANT SELECT ON files TO constructos_ai;
