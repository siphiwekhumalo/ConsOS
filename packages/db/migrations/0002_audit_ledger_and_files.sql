-- =============================================================================
-- 0002 — Tamper-evident audit ledger + tenant file registry
--
-- audit_events: append-only, SHA-256 hash-chained per tenant. Every row's hash
-- covers the previous row's hash, so altering or deleting any historic event
-- breaks verification from that point on. The chain head is computed inside
-- the database (trigger) so application code cannot forge it.
-- Phase 3 adds KMS-signed anchors of each chain head to S3 Object Lock, which
-- also defeats an attacker who rewrites the whole chain with DB-admin rights.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Canonical hash of one audit event (shared by the insert trigger and verify)
-- ---------------------------------------------------------------------------
CREATE FUNCTION audit_event_hash(
  p_prev        bytea,
  p_tenant_id   uuid,
  p_seq         bigint,
  p_occurred_at timestamptz,
  p_actor       uuid,
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid,
  p_payload     jsonb
) RETURNS bytea
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT sha256(
    p_prev || convert_to(
      concat_ws(E'\x1f',
        p_tenant_id::text,
        p_seq::text,
        to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        coalesce(p_actor::text, ''),
        p_action,
        p_entity_type,
        coalesce(p_entity_id::text, ''),
        p_payload::text          -- jsonb text output is deterministic
      ),
      'UTF8'
    )
  )
$$;

-- ---------------------------------------------------------------------------
-- Chain heads (one row per tenant). Only the trigger touches this table.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_chain_heads (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE RESTRICT,
  seq       bigint NOT NULL,
  hash      bytea  NOT NULL
);

ALTER TABLE audit_chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_chain_heads FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_chain_heads
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT ON audit_chain_heads TO constructos_app;

-- ---------------------------------------------------------------------------
-- audit_events
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid   NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  seq           bigint NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  action        text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),  -- e.g. project.created
  entity_type   text NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 60),
  entity_id     uuid,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash     bytea NOT NULL,
  hash          bytea NOT NULL,
  UNIQUE (tenant_id, seq),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id)
);

CREATE INDEX audit_events_entity_idx ON audit_events (tenant_id, entity_type, entity_id);

-- Assigns seq/prev_hash/hash. SECURITY DEFINER so it can advance the chain head,
-- which the app role cannot write directly. Any client-supplied values are overwritten.
CREATE FUNCTION audit_events_chain() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_head audit_chain_heads%ROWTYPE;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM current_tenant_id() THEN
    RAISE EXCEPTION 'audit event tenant does not match current tenant context'
      USING ERRCODE = '42501';
  END IF;

  -- Row lock serialises appends per tenant; tenants never contend with each other.
  SELECT * INTO v_head FROM audit_chain_heads WHERE tenant_id = NEW.tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO audit_chain_heads (tenant_id, seq, hash)
      VALUES (NEW.tenant_id, 0, '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea)
      ON CONFLICT (tenant_id) DO NOTHING;
    SELECT * INTO v_head FROM audit_chain_heads WHERE tenant_id = NEW.tenant_id FOR UPDATE;
  END IF;

  NEW.occurred_at := now();
  NEW.seq         := v_head.seq + 1;
  NEW.prev_hash   := v_head.hash;
  NEW.hash        := audit_event_hash(NEW.prev_hash, NEW.tenant_id, NEW.seq, NEW.occurred_at,
                       NEW.actor_user_id, NEW.action, NEW.entity_type, NEW.entity_id, NEW.payload);

  UPDATE audit_chain_heads SET seq = NEW.seq, hash = NEW.hash WHERE tenant_id = NEW.tenant_id;
  RETURN NEW;
END
$$;

CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_chain();

CREATE FUNCTION audit_events_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_events
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON audit_events TO constructos_app;

-- ---------------------------------------------------------------------------
-- Verify the current tenant's chain. Returns the number of events checked and
-- the first broken seq (NULL when the chain is intact).
-- ---------------------------------------------------------------------------
CREATE FUNCTION audit_verify_chain()
  RETURNS TABLE (events_checked bigint, first_broken_seq bigint, head_hash text)
  LANGUAGE plpgsql STABLE
  SET search_path = public, pg_temp
AS $$
DECLARE
  r      audit_events%ROWTYPE;
  v_prev bytea := '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea;
  v_n    bigint := 0;
BEGIN
  FOR r IN SELECT * FROM audit_events WHERE tenant_id = current_tenant_id() ORDER BY seq LOOP
    v_n := v_n + 1;
    IF r.seq <> v_n
       OR r.prev_hash <> v_prev
       OR r.hash <> audit_event_hash(r.prev_hash, r.tenant_id, r.seq, r.occurred_at,
                      r.actor_user_id, r.action, r.entity_type, r.entity_id, r.payload)
    THEN
      events_checked := v_n; first_broken_seq := r.seq; head_hash := encode(v_prev, 'hex');
      RETURN NEXT;
      RETURN;
    END IF;
    v_prev := r.hash;
  END LOOP;
  events_checked := v_n; first_broken_seq := NULL; head_hash := encode(v_prev, 'hex');
  RETURN NEXT;
END
$$;

GRANT EXECUTE ON FUNCTION audit_verify_chain() TO constructos_app;
GRANT EXECUTE ON FUNCTION audit_event_hash(bytea, uuid, bigint, timestamptz, uuid, text, text, uuid, jsonb)
  TO constructos_app;

-- ---------------------------------------------------------------------------
-- files: registry of objects in S3. The object key is derived from ids the
-- server controls ({tenant_id}/{file_id}); clients never choose keys.
-- ---------------------------------------------------------------------------
CREATE TYPE file_status AS ENUM ('pending', 'uploaded', 'rejected');

CREATE TABLE files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  project_id   uuid,
  object_key   text NOT NULL UNIQUE,
  filename     text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  content_type text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 524288000), -- 500 MB
  category     text NOT NULL DEFAULT 'general'
                 CHECK (category IN ('general', 'drawing', 'photo', 'contract', 'tax', 'hse')),
  status       file_status NOT NULL DEFAULT 'pending',
  uploaded_by  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (object_key LIKE tenant_id::text || '/%'),
  FOREIGN KEY (tenant_id, project_id)  REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES users (tenant_id, id)
);

CREATE INDEX files_project_idx ON files (tenant_id, project_id);

CREATE TRIGGER files_touch BEFORE UPDATE ON files
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON files
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON files TO constructos_app;
