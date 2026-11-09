-- LOCAL DEVELOPMENT ONLY. Runs once when the local Postgres volume is first created.
-- Each backend service connects as its own role; none can bypass Row Level Security.
-- In AWS these roles are created by migrations (NOLOGIN) and given passwords from
-- Secrets Manager (see infra/README.md). For an existing local volume, run
-- `pnpm db:dev-roles` instead.
CREATE ROLE constructos_app  LOGIN PASSWORD 'app_local_dev'  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE constructos_sync LOGIN PASSWORD 'sync_local_dev' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE constructos_ai   LOGIN PASSWORD 'ai_local_dev'   NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
