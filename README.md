# ConstructOS

Multi-tenant operating system for South African construction and mining contractors:
field operations, finance/CVR, payroll, procurement, HSE and AI-assisted operations.

**Status: Phase 1, the foundation.** Multi-tenant isolation, authentication, module
entitlements, web shell and base AWS infrastructure. Stack decisions are in
[docs/adr/0001-foundation-decisions.md](docs/adr/0001-foundation-decisions.md).

## Repository layout

| Path | What it is |
|---|---|
| `packages/db` | Postgres schema, SQL migrations (incl. Row Level Security), tenant-scoped query helper, isolation tests |
| `apps/api` | NestJS API: login, JWT guard, role and module guards, `/me`, `/projects`, `/health` |
| `apps/web` | React 19 + Vite + Tailwind shell; the sidebar renders only the tenant's active modules |
| `infra/terraform` | AWS (af-south-1): VPC, Aurora PostgreSQL 16 Serverless v2, KMS, S3 (incl. Object Lock audit bucket), ECR, ECS cluster |
| `docker/` | Local Postgres role bootstrap |

## Local development

Prerequisites: Node 22.12+, pnpm 10, Docker.

```bash
pnpm install
pnpm db:up            # Postgres 16 (+pgvector) and Redis
```

Create a `.env` at the repo root (it is git-ignored):

```dotenv
DATABASE_URL_OWNER=postgres://constructos_owner:owner_local_dev@localhost:5432/constructos
DATABASE_URL_APP=postgres://constructos_app:app_local_dev@localhost:5432/constructos
JWT_SECRET=<48+ random bytes, base64url>   # node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
JWT_TTL_SECONDS=900
API_PORT=3000
WEB_ORIGIN=http://localhost:5173
SEED_PASSWORD=<12+ chars, local demo users only>
```

> If ports 5432/6379 are taken by other containers, start with
> `PG_PORT=5434 REDIS_PORT=6380 pnpm db:up` (PowerShell: set `$env:PG_PORT` first)
> and change the port in both database URLs.

```bash
pnpm db:migrate       # applies packages/db/migrations/*.sql as the owner role
pnpm db:seed          # two rival demo tenants: demo-civils, demo-mining
pnpm build            # db package must be built before the API runs
pnpm dev:api          # http://localhost:3000/api/v1
pnpm dev:web          # http://localhost:5173 (proxies /api to the API)
pnpm test             # tenant-isolation suite runs against the local database
```

Sign in with organisation `demo-civils` or `demo-mining`, email `owner@<slug>.test`, and your `SEED_PASSWORD`.
To reset local data: `docker compose down -v`.

## Tenant isolation: rules for every contributor

1. The API connects **only** as `constructos_app` (no superuser, no `BYPASSRLS`). It refuses to start with the owner role.
2. Touch tenant data **only** through `DatabaseService.forTenant(tenantId, tx => …)` (`withTenant` in `@constructos/db`).
   It sets the tenant with `SET LOCAL` semantics, so it cannot leak across pooled connections.
3. `tenant_id` always comes from the verified token, **never** from the request body or URL.
4. Every new tenant table needs `ENABLE` + `FORCE ROW LEVEL SECURITY`, a `tenant_isolation` policy with
   `USING` **and** `WITH CHECK`, least-privilege grants, and a test in `packages/db/test`.
5. Child tables reference parents by `(tenant_id, parent_id)` composite foreign keys.
6. Money is `numeric` in the database and a decimal string in the API. It is never a JS `number`.

## API (v1)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/v1/health` | public | DB connectivity, for ALB health checks |
| POST | `/api/v1/auth/login` | public | `{tenant, email, password}`, returns `{accessToken, expiresIn}`; 10 attempts/min |
| GET | `/api/v1/me` | bearer | user, tenant, active modules |
| GET | `/api/v1/projects` | bearer | tenant's projects |
| POST | `/api/v1/projects` | bearer, owner/admin/PM | `{code, name, contractForm?, contractValue?}` |

Module-gated endpoints use `@RequiresModule('mod_payroll')`. Entitlements are read from the database
(30 s cache), not from the token, so a suspension or downgrade takes effect quickly.
