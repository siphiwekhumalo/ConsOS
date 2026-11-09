-- Runs once when the local Postgres volume is first created.
-- The API connects as constructos_app, which can never bypass Row Level Security.
-- In AWS this role is created by the deployment bootstrap with a Secrets Manager password.
CREATE ROLE constructos_app LOGIN PASSWORD 'app_local_dev'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
