# Backend architecture

Status: living document. Last updated 2026-11-09.

## 1. Service topology

The target is three services behind one ALB, as in the blueprint, with two changes.
Services talk to each other through **events**, not through direct synchronous calls.
And the AI engine is **internal-only**.

```
                ALB (WAF in front)
   /api/*  ───────────────► core-api      (NestJS)   ── system of record, all writes that matter
   /sync/* ───────────────► edge-sync     (Go)       ── device sync + telemetry ingestion
   /ai/*   ───────────────► ai-engine     (FastAPI)  ── async jobs; results are suggestions only

   All three ──► Aurora PostgreSQL (RLS)   each as its OWN database role
   core-api  ──► transactional outbox ──► SQS / EventBridge ──► edge-sync, ai-engine, notifier
```

| Service | DB role | Privileges | Why |
|---|---|---|---|
| core-api | `constructos_app` | read/write tenant tables, insert audit | System of record |
| edge-sync | `constructos_sync` | read/write site diary, read projects, append audit | A bug in sync code cannot edit valuations or payroll |
| ai-engine | `constructos_ai` | **read-only** business data + write `ai_jobs`, append audit | An AI or prompt-injection bug cannot modify business data |

All three use the same `withTenant` / `SET LOCAL app.current_tenant` pattern and verify the same JWT
(or a service token that carries the tenant ID). No service has `BYPASSRLS`.

**Status.** All three services are built and run in containers (`docker compose --profile app`).
The AI engine is reachable on `/ai/*` but only with a valid token, `mod_ai` and an allowed role. Jobs run
in a background thread for now; move them to an SQS consumer before production load.

**Sync protocol (v1).**
- Devices create rows with client UUIDs, so a retried push returns `duplicate` instead of creating a copy.
- Updates carry `baseVersion`. If the server copy changed meanwhile, the device gets `conflict` plus
  the server record; nothing is overwritten silently.
- Pulls use a global `change_seq` cursor with a 2-second settle window, so rows from transactions
  that commit out of order are not skipped.
- gRPC and telemetry ingestion are not built yet.

## 2. Built so far

| Capability | Where | Verified by |
|---|---|---|
| Tenant isolation (RLS, fail-closed) | `packages/db/migrations/0001_*` | 13 integration tests |
| Login, JWT, role and module guards | `apps/api/src/auth` | Smoke test |
| **Audit ledger**: append-only, per-tenant SHA-256 chain computed in the DB | `migrations/0002_*`, `/audit/events`, `/audit/verify` | 7 tests, incl. concurrent appends and superuser tampering |
| **File storage**: presigned S3 upload/download, server-chosen keys, type allow-list, size check | `apps/api/src/files`, `files` table | Smoke test: cross-tenant download returns 404, cross-tenant project ID returns 400 |
| **Redis**: shared rate limits + entitlement cache, degrades to memory/DB if Redis is down | `apps/api-core/src/redis` | Smoke test (429 after 10/min; cache key with TTL) |
| **Per-service DB roles**, site diary, AI jobs | `migrations/0003_*` | 5 tests (least privilege per role) |
| **Edge-sync service** (Go): batched idempotent push, versioned conflicts, cursor pull | `apps/sync-service` | Go unit tests + end-to-end run |
| **AI engine** (FastAPI): Claude BOQ extraction from PDFs, diary risk review, BOQ arithmetic check | `apps/ai-engine` | 12 pytest tests + end-to-end run (fake provider) |
| **Formula engine**: decimal, sandboxed, size and depth limits | `packages/dsl-parser`, `/api/v1/formulas/evaluate` | 16 tests |

## 3. What else the backend must do (gap analysis)

Ordered by how early each item blocks real customers. **P0** means needed before the first paying tenant.

### P0: platform essentials
1. **Project-level access control.** Today any user sees every project in their tenant. Contractors
   need project membership: a foreman on Shaft 4 must not see the N3 valuation. Add a `project_members` table and include it in RLS.
2. **Idempotency keys and optimistic concurrency.** Offline devices retry. Every write must accept an
   `Idempotency-Key`, and every mutable row needs a `version` column, or you get duplicate diary entries and lost updates.
3. **Transactional outbox + worker.** Write events in the same transaction as the change, then publish to SQS.
   This feeds notifications, sync, AI jobs and integrations without dual-write bugs.
4. **Approval workflow engine.** Valuations, variations, POs, timesheets and payment certificates all need
   multi-level approval with delegation, thresholds and an audit trail. Build one generic engine, not one per module.
5. **Notifications.** Email, SMS and **WhatsApp** (the default channel on SA sites), plus push to devices. Driven by the outbox.
6. **User lifecycle.** Invites, password reset, MFA, refresh tokens with revocation, and device registration for shared site tablets.
7. **Tenant provisioning and subscriptions.** A separate, audited platform-admin path to create tenants,
   change modules and suspend for non-payment. The app role deliberately cannot do this.
8. **Malware scanning of uploads.** Uploaded files stay quarantined until scanned (e.g. GuardDuty Malware Protection for S3).
9. **Observability.** Structured logs with tenant and request IDs, OpenTelemetry tracing across the three services, alerts, and per-tenant usage metrics.

### P1: construction domain (what makes it a construction OS)
10. **Contract administration.** NEC4 early warnings and compensation events (8-week time bar), FIDIC notices
    (28-day claims), deadline clocks, and reminders before time bars expire. Missing a time bar costs contractors real money.
11. **Payment certificates and valuations.** Measured work against the BOQ, retention (with release on
    practical completion), advance payment recovery, contract price adjustment (CPA) using Stats SA indices, and VAT.
12. **CVR ledger.** Cost-to-date, value-to-date, forecast final cost/value, and margin per cost code, with period close and locks.
13. **Document control.** Drawing revisions, transmittals, RFIs, submittals, superseded-revision warnings.
14. **Time and attendance.** Clock-in with geofencing, bulk crew timesheets, and an export to payroll.
15. **Plant and equipment.** Hire on/off, utilisation and costing from telematics (edge-sync ingests, core costs).
16. **Procurement.** Requisition → quote comparison → PO → goods received note → invoice 3-way match, plus supplier B-BBEE and CSD/CIDB checks.
17. **HSE.** Incidents, toolbox talks, permits to work, inspections, and Section 37(2) mandatary agreements.

### P1: compliance and data protection
18. **POPIA controls.**
    - Encrypt ID numbers and bank details at field level.
    - Retention schedules and anonymisation of former workers.
    - Data-subject access requests.
    - Logged support-staff access ("break-glass" with tenant consent).
19. **Audit anchoring** (Phase 3). KMS-sign each tenant's chain head on a schedule and write it to the Object Lock bucket.
20. **Backups and DR runbook.** Tested restore and a per-tenant export (customers will ask for it on exit).

### P2: integrations and reporting
21. **Accounting/ERP connectors.** Sage, Xero, Pastel; SAP for enterprise.
22. **Payroll provider** (instead of building the SARS engine), with timesheet export in and cost journals back.
23. **Bank payment files**, with supplier payments approved in-app.
24. **Outbound webhooks and a public API** with per-tenant API keys and scopes.
25. **Document generation.** PDF payment certificates, valuations, CVR packs and Excel exports.
26. **Reporting replica** for analytics, so heavy reports never run on the writer.

### AI engine scope (when built)
- Asynchronous jobs only (tender BOQ extraction, contract clause and risk review, CVR variance explanations). Results are
  **suggestions a human approves**, never direct writes to business tables.
- Uses a current Claude model (the blueprint's Claude 3.5 Sonnet is retired) behind a provider interface.
- pgvector embeddings are stored with `tenant_id` under RLS, so retrieval cannot cross tenants.
- POPIA: get legal sign-off before sending personal information (HR, payroll, incident data) to an offshore API.

## 4. Cross-cutting API conventions

- `/api/v1` URL versioning. Breaking changes need a new version.
- Errors: `{ statusCode, message, issues? }`. Validation via zod at every boundary.
- Money: `numeric` in the DB, decimal strings in JSON. Never floats.
- Time: `timestamptz` and ISO-8601 UTC on the wire. Display in Africa/Johannesburg.
- Pagination: keyset (`?beforeSeq=`, `?cursor=`), never offset on large tables.
- Every state change that matters legally or financially calls `appendAudit` in the **same transaction**.
