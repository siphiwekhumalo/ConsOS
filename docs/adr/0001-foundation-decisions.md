# ADR 0001: Foundation stack decisions

- **Status:** Accepted (Phase 1)
- **Date:** 2026-11-09

## Context

The architecture blueprint left several either/or choices open and contained patterns that are
unsafe as written. These decisions settle them so Phase 1 can be built and tested.

## Decisions

| Area | Blueprint options | Decision | Reason |
|---|---|---|---|
| Monorepo | not specified | pnpm workspaces | One install, shared types between API, web and db |
| API | NestJS **or** Go | **NestJS only** for now | One language for a small team. Add a Go service only when profiling proves sync or hashing needs it |
| ORM / migrations | Prisma **or** Drizzle | **Drizzle** + hand-written SQL migrations | RLS policies, roles and SECURITY DEFINER functions are first-class in SQL; Drizzle gives typed queries without hiding SQL |
| IaC | Terraform **or** CDK | **Terraform** | Wider ops talent pool; provider-agnostic state tooling |
| Region | not specified | **af-south-1** (Cape Town) | POPIA data residency for payroll, HR and HSE data |
| Database | Aurora PostgreSQL Serverless v2 | Aurora PostgreSQL **16** Serverless v2 | pgvector available for Phase 4; can scale to 0 ACU for non-prod |
| Field app | Vite PWA **or** React Native | **React Native** (Phase 3) | iOS may evict PWA storage; multi-day offline site data must not be lost |
| Offline sync | PowerSync **or** ElectricSQL | Deferred to Phase 3 spike | Evaluate both against the actual sync data model |
| Rule engine | "sandboxed TypeScript evaluation" | **Purpose-built expression DSL** (parser + interpreter, decimal arithmetic) | Evaluating TS/JS is a sandbox-escape risk; the same interpreter runs offline on devices |
| Conflict resolution | last-write-wins | **Append-only events** for financial/approval records; LWW only for non-financial fields | LWW silently drops data, which contradicts the audit requirements |
| Audit ledger | SHA-256 hash chain | Hash chain **+ KMS-signed periodic anchors in S3 Object Lock (COMPLIANCE)** | A bare chain can be recomputed by anyone with DB admin rights. QLDB is discontinued |
| AI model | Claude 3.5 Sonnet | **Current Claude model** (e.g. `claude-sonnet-5-5`), behind a provider interface | 3.5 Sonnet is retired. POPIA cross-border review is needed before sending personal data |
| Payroll / SARS | build in-house | **Integrate a certified payroll provider first**; build only if commercially required | PAYE BRS changes yearly; e@syFile certification is a product in itself |

## Tenant isolation design

- Two runtime roles. `constructos_owner` runs migrations. `constructos_app` (NOSUPERUSER, NOBYPASSRLS) is the only role the API uses.
- `withTenant()` wraps each unit of work in a transaction with `set_config('app.current_tenant', id, true)`.
- Every tenant table: `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy with `USING` and `WITH CHECK` on `current_tenant_id()`.
  With no tenant set, the policies fail closed.
- Login runs before a tenant exists, so it uses `auth_find_login()`, a SECURITY DEFINER function owned by the
  non-login role `constructos_auth`. That role is the only one with cross-tenant read access, and only to `tenants` and `users`.
- Module entitlements are resolved server-side from `tenants.active_modules` (short cache), not trusted from the JWT.
- The hybrid tiers (schema-per-tenant / dedicated cluster for enterprise) stay possible: the app always
  goes through `withTenant`, so routing a tenant to another connection is a change in one place.

Verified by `packages/db/test/tenant-isolation.test.ts` (13 cases, run against real Postgres as the app role).

## Consequences

- Platform-level operations (creating tenants, cross-tenant reporting) need a separate, audited
  provisioning path. The app role deliberately cannot do them.
- The Drizzle schema (`packages/db/src/schema.ts`) must be kept in sync with the SQL migrations by hand.
- Rate limiting and the entitlement cache are in-memory until Redis is wired in (open Phase 1 item).
