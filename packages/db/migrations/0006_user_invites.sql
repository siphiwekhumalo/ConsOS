-- =============================================================================
-- 0006 — User onboarding by invitation (no shared or emailed passwords)
--
-- An owner/admin invites a user: the user row is created without a password
-- (password_hash NULL, is_active false) plus a one-time invite. Only the
-- SHA-256 hash of the invite token is stored. The invitee opens the link and
-- sets their own password; that activates the account and spends every open
-- invite for the user. Admin "password reset" issues the same kind of link.
-- =============================================================================

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE user_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  user_id     uuid NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('invite', 'reset')),
  token_hash  bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_by  uuid,                 -- NULL when created by platform provisioning
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id)    REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);

CREATE INDEX user_invites_user_idx ON user_invites (tenant_id, user_id) WHERE used_at IS NULL;

ALTER TABLE user_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_invites FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_invites
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY auth_lookup ON user_invites FOR SELECT TO constructos_auth USING (true);

GRANT SELECT, INSERT, UPDATE ON user_invites TO constructos_app;
GRANT SELECT ON user_invites TO constructos_auth;

-- Pre-authentication lookup of a valid (unused, unexpired) invite by token
-- hash. Returns the tenant so the API can then work inside that tenant's RLS
-- context. Owned by constructos_auth (read-only, cross-tenant), like auth_find_login.
CREATE FUNCTION auth_find_invite(p_token_hash bytea)
  RETURNS TABLE (
    invite_id uuid, purpose text, tenant_id uuid, user_id uuid,
    email text, full_name text, tenant_name text, tenant_slug text, expires_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT i.id, i.purpose, i.tenant_id, i.user_id, u.email, u.full_name, t.name, t.slug, i.expires_at
  FROM user_invites i
  JOIN users u   ON u.id = i.user_id
  JOIN tenants t ON t.id = i.tenant_id
  WHERE i.token_hash = p_token_hash
    AND i.used_at IS NULL
    AND i.expires_at > now()
  LIMIT 1
$$;

GRANT CREATE ON SCHEMA public TO constructos_auth;
ALTER FUNCTION auth_find_invite(bytea) OWNER TO constructos_auth;
REVOKE CREATE ON SCHEMA public FROM constructos_auth;
REVOKE ALL ON FUNCTION auth_find_invite(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_invite(bytea) TO constructos_app;
