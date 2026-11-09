-- =============================================================================
-- 0001 — Tenancy foundation: tenants, users, projects + Row Level Security
--
-- Isolation model (see docs/adr/0001-foundation-decisions.md):
--   * The API connects ONLY as constructos_app (NOSUPERUSER, NOBYPASSRLS).
--   * Every request runs in a transaction that calls
--       set_config('app.current_tenant', <uuid>, true)   -- = SET LOCAL
--     so the setting dies with the transaction and cannot leak across pooled
--     connections.
--   * Every tenant table has ENABLE + FORCE ROW LEVEL SECURITY and a policy with
--     both USING and WITH CHECK, so reads, updates and inserts are all scoped.
--   * With no tenant set, current_tenant_id() is NULL and every policy fails
--     closed (zero rows, inserts rejected).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Roles (created if missing; passwords/LOGIN are managed outside migrations)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'constructos_app') THEN
    CREATE ROLE constructos_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  -- constructos_auth owns the pre-authentication lookup function. It can read
  -- tenants/users across tenants, but it cannot log in and the app cannot
  -- assume it; it is reachable only through auth_find_login().
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'constructos_auth') THEN
    CREATE ROLE constructos_auth NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- Needed on PG16+/Aurora so the migrating role may hand function ownership to constructos_auth.
GRANT constructos_auth TO CURRENT_USER;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO constructos_app, constructos_auth;

-- ---------------------------------------------------------------------------
-- Tenant context helper
-- ---------------------------------------------------------------------------
CREATE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  -- missing_ok = true; '' (reset after SET LOCAL) is treated as "no tenant".
  SELECT nullif(current_setting('app.current_tenant', true), '')::uuid
$$;

GRANT EXECUTE ON FUNCTION current_tenant_id() TO constructos_app, constructos_auth;

CREATE FUNCTION touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
CREATE TYPE tenant_tier AS ENUM ('standard', 'mid_market', 'enterprise');

CREATE TYPE user_role AS ENUM (
  'owner', 'admin', 'project_manager', 'site_foreman', 'finance', 'viewer'
);

CREATE TYPE project_status AS ENUM (
  'tender', 'awarded', 'active', 'practical_completion', 'final_account', 'closed'
);

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL UNIQUE
                   CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  tier           tenant_tier NOT NULL DEFAULT 'standard',
  -- Module entitlements. Adding a module is an explicit migration.
  active_modules text[] NOT NULL DEFAULT '{}'
                   CHECK (active_modules <@ ARRAY[
                     'mod_field', 'mod_finance', 'mod_payroll',
                     'mod_procurement', 'mod_hse', 'mod_ai'
                   ]::text[]),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER tenants_touch BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  email         text NOT NULL CHECK (email = lower(email) AND email LIKE '%_@_%'),
  full_name     text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 200),
  password_hash text NOT NULL,
  role          user_role NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, id)
);

CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  code           text NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status         project_status NOT NULL DEFAULT 'tender',
  contract_form  text CHECK (contract_form IN (
                   'FIDIC_RED', 'FIDIC_YELLOW', 'FIDIC_SILVER',
                   'NEC4_ECC', 'JBCC_PBA', 'GCC_2015'
                 )),
  -- Money is always numeric, never float.
  contract_value numeric(18, 2) CHECK (contract_value >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  -- Child tables reference (tenant_id, project_id) so a row can never point at
  -- another tenant's project, even through a bug in application code.
  UNIQUE (tenant_id, id)
);

CREATE TRIGGER projects_touch BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE tenants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants  FORCE  ROW LEVEL SECURITY;
ALTER TABLE users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE users    FORCE  ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants
  USING (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

CREATE POLICY tenant_isolation ON users
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY tenant_isolation ON projects
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Read-only cross-tenant visibility for the auth lookup role only.
CREATE POLICY auth_lookup ON tenants FOR SELECT TO constructos_auth USING (true);
CREATE POLICY auth_lookup ON users   FOR SELECT TO constructos_auth USING (true);

-- ---------------------------------------------------------------------------
-- Privileges (least privilege; no DELETE on users — deactivate instead)
-- ---------------------------------------------------------------------------
GRANT SELECT                 ON tenants  TO constructos_app;
GRANT SELECT, INSERT, UPDATE ON users    TO constructos_app;
GRANT SELECT, INSERT, UPDATE ON projects TO constructos_app;

GRANT SELECT ON tenants, users TO constructos_auth;

-- ---------------------------------------------------------------------------
-- Pre-authentication lookup
-- Login happens before a tenant context exists, so the app calls this
-- SECURITY DEFINER function instead of reading users directly. It returns at
-- most one row, for an exact (tenant slug, email) match on an active user.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth_find_login(p_tenant_slug text, p_email text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, role user_role)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.tenant_id, u.password_hash, u.role
  FROM users u
  JOIN tenants t ON t.id = u.tenant_id
  WHERE t.slug = lower(p_tenant_slug)
    AND u.email = lower(p_email)
    AND u.is_active
  LIMIT 1
$$;

-- Non-superusers (e.g. the Aurora master user) may only transfer ownership to a
-- role holding CREATE on the schema; grant it just for the transfer.
GRANT CREATE ON SCHEMA public TO constructos_auth;
ALTER FUNCTION auth_find_login(text, text) OWNER TO constructos_auth;
REVOKE CREATE ON SCHEMA public FROM constructos_auth;
REVOKE ALL ON FUNCTION auth_find_login(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_login(text, text) TO constructos_app;
