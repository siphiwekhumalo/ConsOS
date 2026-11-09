# ConstructOS

Multi-tenant operating system for South African construction and mining contractors: projects,
site diary with offline sync, documents, commercial rules, AI tender/diary analysis, and a
tamper-evident audit trail.

Design and roadmap: [docs/backend-architecture.md](docs/backend-architecture.md) ·
Stack decisions: [docs/adr/0001-foundation-decisions.md](docs/adr/0001-foundation-decisions.md)

## Repository layout

```
apps/
  api-core/       NestJS (TypeScript)  /api/*   auth, projects, diary, files, audit, formulas
  sync-service/   Go                   /sync/*  offline device push/pull for the site diary
  ai-engine/      Python (FastAPI)     /ai/*    BOQ extraction from tender PDFs, diary risk review
  web/            React 19 + Vite + Tailwind    single-page app (nginx in the container)
packages/
  db/             Postgres schema + SQL migrations (Row Level Security), shared by all services
  dsl-parser/     Safe decimal formula engine for overtime, retention and allowance rules
infra/terraform/  AWS af-south-1: VPC, Aurora, KMS, S3, ECR, ECS
docker-compose.yml  Local stand-in for AWS (Postgres, Redis, S3 mock + the four app services)
```

Each service connects to Postgres as its **own role** (`constructos_app`, `constructos_sync`,
`constructos_ai`). None can bypass Row Level Security, and the AI engine is read-only on business data.

## Prerequisites

- **Docker Desktop**: required for both ways of running.
- **Node 22.12+ and pnpm 10** (`corepack enable`): needed for local development and tests.
- **uv** (Python): only to run the AI engine outside Docker.
- **Go 1.24**: optional. Without it, run the sync service in Docker.

## 1. Create `.env` (repo root, git-ignored)

```dotenv
# Shared login-token secret for all three services (generate one, never commit it):
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
JWT_SECRET=
# Password for the two demo users created by the seed (local only)
SEED_PASSWORD=

# --- only needed when running services outside Docker (option B) ---
DATABASE_URL_OWNER=postgres://constructos_owner:owner_local_dev@localhost:5434/constructos
DATABASE_URL_APP=postgres://constructos_app:app_local_dev@localhost:5434/constructos
AI_DATABASE_URL=postgresql://constructos_ai:ai_local_dev@localhost:5434/constructos
REDIS_URL=redis://localhost:6380
S3_BUCKET=constructos-tenant-files
S3_ENDPOINT=http://localhost:9094
S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=local
AWS_SECRET_ACCESS_KEY=local

# --- AI: "fake" makes no API calls. For real Claude: AI_PROVIDER=anthropic + ANTHROPIC_API_KEY ---
AI_PROVIDER=fake
# ANTHROPIC_API_KEY=

# --- host ports (these are the defaults; override only if one is taken) ---
# PG_PORT=5434  REDIS_PORT=6380  S3_PORT=9094  API_PORT=3000  SYNC_PORT=18081  AI_PORT=8010  WEB_PORT=8070
```

The defaults deliberately avoid 5432, 6379, 8000 and 8080 so this stack runs next to other projects.
If you change a port, also change it in the `localhost` URLs above.

## 2a. Run everything in Docker (simplest)

```bash
docker compose --profile app up -d --build        # builds 4 services, runs migrations, starts all
docker compose --profile app run --rm migrate node node_modules/@constructos/db/dist/seed.js   # uses SEED_PASSWORD from .env
```

Open **http://localhost:8070** (or your `WEB_PORT`). Sign in with organisation `demo-mining`, email
`owner@demo-mining.test` and your `SEED_PASSWORD`. That tenant has every module, including AI.
`demo-civils` / `owner@demo-civils.test` is a rival tenant with fewer modules; use it to see isolation.

```bash
docker compose --profile app ps                   # status
docker compose --profile app logs -f api-core     # logs (api-core | sync-service | ai-engine | web)
docker compose --profile app down                 # stop (data kept)
docker compose --profile app down -v              # stop and DELETE all local data
```

## 2b. Local development (hot reload)

```bash
pnpm install
docker compose up -d                              # Postgres, Redis, S3 mock only
pnpm build                                        # builds shared packages
pnpm db:migrate
pnpm db:dev-roles                                 # dev logins for the 3 service roles (local DB only)
pnpm db:seed                                      # demo tenants; or create a real one:
# TENANT_SLUG=acme TENANT_NAME="Acme (Pty) Ltd" OWNER_NAME="..." OWNER_EMAIL=... PUBLIC_URL=http://localhost:5173 pnpm db:create-tenant
```

Then one terminal per service:

```bash
pnpm dev:api                                      # core API     http://localhost:3000/api/v1
pnpm dev:web                                      # web app      http://localhost:5173
cd apps/ai-engine && uv sync && uv run python -m uvicorn app.main:app --reload --port 8010
docker compose --profile app up -d sync-service   # sync service (or, with Go: cd apps/sync-service && go run ./cmd/server)
```

The Vite dev server proxies `/api`, `/sync` and `/ai` to those ports, the same paths the AWS load balancer routes.
If you moved a service's port, set `API_CORE_URL`, `SYNC_URL` or `AI_URL` before `pnpm dev:web`.

## Tests

```bash
pnpm test                                         # db integration (needs .env + DB running) + formula engine
cd apps/ai-engine && uv run python -m pytest
docker run --rm -v "$PWD/apps/sync-service:/src" -w /src golang:1.24-alpine go test ./...
```

## Rules for every contributor

1. Each service connects only as its own role, never the owner. All three refuse to start with the owner role.
2. Touch tenant data only through the tenant-transaction helper (`withTenant` / `WithTenant` / `tenant_tx`).
3. `tenant_id` comes from the verified token, never from a request body or URL.
4. A new tenant table needs `ENABLE` + `FORCE ROW LEVEL SECURITY`, a policy with `USING` and `WITH CHECK`,
   least-privilege grants per role, and a test in `packages/db/test`.
5. Money and quantities are `numeric` in the database and decimal strings in JSON, never floats.
6. Legally or financially significant changes call `appendAudit` in the same transaction.
7. AI output is a suggestion stored in `ai_jobs`; the AI engine never writes business tables.

## API overview

| Service | Method & path | Purpose |
|---|---|---|
| core | `POST /api/v1/auth/login` | `{tenant, email, password}` returns an access token (10 attempts/min) |
| core | `GET /api/v1/me` | user, tenant, active modules |
| core | `GET/POST /api/v1/projects` | list / create (owner, admin, PM), audited |
| core | `GET/POST /api/v1/projects/:id/diary` | site diary (needs `mod_field`), idempotent on client `id` |
| core | `POST /api/v1/files/uploads` then `PUT` to the returned URL then `POST /api/v1/files/:id/complete` | direct-to-S3 upload |
| core | `GET /api/v1/files?projectId=`, `GET /api/v1/files/:id/download` | list / short-lived download link |
| core | `GET /api/v1/audit/events`, `GET /api/v1/audit/verify` | audit trail; hash-chain verification |
| core | `POST /api/v1/formulas/evaluate` | test a commercial-rule formula |
| core | `GET/POST /api/v1/estimates`, `GET /api/v1/estimates/:id` | client JCE intake pipeline, with live client-vs-internal summary (needs `mod_commercial`) |
| core | `POST/PATCH/DELETE /api/v1/estimates/:id/lines[/:lineId]` | line items, client and internal sides (Intake and Technical Review only) |
| core | `POST /api/v1/estimates/:id/import-ai` | `{jobId}`: copy an AI BOQ extraction in as the client's lines |
| core | `GET /api/v1/users`, `POST /api/v1/users/invite`, `POST /api/v1/users/:id/link`, `PATCH /api/v1/users/:id` | Users & access (owner/admin): invite with one-time links, password-reset links, role changes, deactivation |
| core | `GET /api/v1/auth/invite/:token`, `POST /api/v1/auth/invite/accept` | public: open an invite/reset link and set your own password |
| core | `POST /api/v1/estimates/:id/transition` | `{to, note?, clientApprovalRef?, acknowledgeVariance?}`: role-tiered approvals; `baseline_locked` freezes and creates the project |
| sync | `POST /sync/v1/push` | up to 500 offline changes: `applied` / `duplicate` / `conflict` / `rejected` per change |
| sync | `GET /sync/v1/pull?since=<cursor>` | projects + diary changes since the cursor |
| ai | `POST /ai/v1/jobs` | `{kind: "boq_extraction", fileId}` or `{kind: "diary_risk_review", projectId}`, returns 202 |
| ai | `GET /ai/v1/jobs`, `GET /ai/v1/jobs/:id` | poll job status and results (needs `mod_ai`) |
