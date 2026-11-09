# ConstructOS: what it is and how it works

**Written for:** the product owner, and anyone they pass it to who needs the whole picture, end to end:
new developers, managers and stakeholders. It is built from the codebase, the `docs/` folder and the
10-module product specification. It separates what is **built and running** from what is **designed
but not built** and what is **planned**, so nobody mistakes a screen design for working software.

Last updated: 9 November 2026.

---

## 1. In one paragraph

ConstructOS (also referred to as Baheka Construction OS) is a multi-tenant operating system for South
African and SADC construction and mining contractors, CIDB Grade 5 to 9 (GB/CE). It covers a contract
from tender and estimate, through award, site execution, commercial control (valuations and
cost-value reconciliation), procurement, plant, safety and payroll, to the client's sign-off and the
final account. It sells as ten modules, each switched on per customer. In front of them sits an
**Administration & Commercial** module. It runs every job through four gated phases (**Scoping →
Planning → Execution → Invoicing**), so no work starts before the scope and baseline costs are
frozen, and no invoice is raised on anything but verified actuals. Three things sit underneath
every module:
- **Hard data isolation** between rival contractors, enforced by the database itself.
- **Offline-first field capture** that keeps working through loadshedding and on remote mining sites.
- **A tamper-evident audit ledger** that serves as evidence in FIDIC/NEC disputes, for auditors and for SARS.

## 2. The business it serves

Mid-market to enterprise contractors run several multi-million-rand contracts at once, often far from
reliable connectivity. Today that work is split across Sage or VIP payroll, Excel CVRs, paper site
diaries, email RFIs and WhatsApp. The commercial cycle looks like this:

1. **A client goes to tender.** Public commissioners (SANRAL, Eskom, Transnet, municipalities) or
   private developers and mine owners issue tender documents with a Bill of Quantities (BOQ).
2. **The contractor bids.** They measure quantities from drawings, price them against unit rates,
   form joint ventures for B-BBEE scoring, and submit.
3. **The contract is awarded** under conditions of contract: FIDIC (Red/Yellow/Silver), NEC4 ECC,
   JBCC or GCC 2015.
4. **The work is executed on site.** Foremen record daily progress, weather, headcounts, delays and
   safety. Engineers answer RFIs and issue site instructions.
5. **The contractor is paid monthly** through interim payment certificates. Retention is held back,
   and variations and compensation events must be notified within contractual time bars.
6. **Costs are controlled.** Labour (payroll and bargaining councils), materials (procurement and
   B-BBEE spend) and plant (fleet) all land on cost codes and are reconciled against certified value (CVR).
7. **Completion.** The client signs off milestones, retention is released, and the final account closes.

ConstructOS digitises each step and keeps one record per contract.

## 3. The core objects

### Built (in the database today)

| Object | What it is |
|---|---|
| **Tenant** | A customer organisation. Holds its tier and `active_modules` (which of the 10 modules it pays for). Everything else belongs to exactly one tenant. |
| **User** | A person in a tenant, with one role: `owner`, `admin`, `project_manager`, `site_foreman`, `finance` or `viewer`. |
| **Project** | A contract/site: code, name, status, conditions of contract, contract value. |
| **SiteDiaryEntry** | One day's site record: date, weather, workforce, work completed, delays, safety notes. Created with a client-generated ID so offline retries never duplicate. Carries a `version` (conflict detection) and a `change_seq` (sync cursor). |
| **File** | A document in S3 (drawing, photo, contract, tax certificate, HSE record) with its category, size and upload status. The storage key is always chosen by the server and prefixed with the tenant ID. |
| **AuditEvent** | One append-only, hash-chained ledger entry (for example `project.created`, `file.downloaded`, `diary.synced`). |
| **AiJob** | A requested AI analysis (BOQ extraction or diary risk review), its status and its result. The result is a suggestion and never changes business data. |
| **Estimate** | A client Job Card Estimate (JCE): reference, client, stage (`intake → technical_review → client_approval → baseline_locked`, or `rejected`), client approval/PO reference and, once locked, the frozen baseline totals and the project it created. |
| **EstimateLine** | One line of an estimate with **two sides**: the client's quantity and rate, and the internal takeoff's quantity and rate. Either side may be blank, which is itself a flag. |

### Planned (per module; see §5)

Employee, PayRun, BidOpportunity, JvPartner, CostCode, Valuation (IPC), Variation/CompensationEvent,
RateItem, Takeoff, Requisition, PurchaseOrder, GoodsReceivedNote, SupplierInvoice, PlantItem,
WorkOrder, Incident, ToolboxTalk, NCR, RFI, SiteInstruction, Milestone and SignOff. Each will follow
the same tenancy pattern as the built objects (see §6).

## 4. The lifecycle

### 4.1 The governed job pipeline (Administration & Commercial)

Every job moves through four phases in order. Each phase must close before the next can open, and
every step is recorded in the audit trail.

| Phase | What happens | Gate to the next phase | State today |
|---|---|---|---|
| **1. Scoping** | Client JCE received and standardised, with lines imported by AI from the PDF or captured by hand. Technical team measures and prices the internal takeoff. Line-by-line comparison flags scope and pricing gaps. Commercial sign-off, then client approval. | **Baseline locked:** client approval/PO reference recorded, variances explicitly acknowledged, scope and baseline costs frozen, project created. | **Live** |
| **2. Planning** | Project portfolio (PPM) Kanban: tasks, qualified crews, plant and materials, milestones mapped to the locked baseline | Plan approved: resources allocated, ready for execution | Planned |
| **3. Execution** | Geofenced clock-ins, daily diaries, material usage and progress tracked against the baseline; margin drift flagged early | Work complete: actuals verified | Diary and offline sync **Live**; clock-ins and progress Planned |
| **4. Invoicing** | Claims and invoices generated **only from verified actuals** (logged hours, materials used, confirmed progress), never from the estimate | Invoice approved and paid | Planned |

**Scoping stage rules, enforced in the database and not only the API:**
- **Stage order:** stages can only move in the allowed order (no skipping), and estimates can't be deleted.
- **Line freeze:** lines can only change in Intake and Technical Review. They freeze when the estimate goes to the client.
- **Baseline freeze:** once the baseline is locked, nothing about the estimate or its lines can change. Changes from then on are variations.

**Approval tiers, enforced in the API:**

| Step | Who can do it |
|---|---|
| Submit for technical review | Project manager, admin or owner |
| Commercial sign-off (send to client) | Finance, admin or owner |
| Lock the baseline | Admin or owner |
| Reject (reason required) | Admin or owner |

**Guards:**
- An estimate can't go to technical review with no lines.
- It can't go to the client while any client line has no internal takeoff.
- The baseline can't be locked without a client approval reference, or with flagged lines unless the
  variances are explicitly acknowledged. The acknowledgement and the leakage amount are written to the audit trail.

**Discrepancy flags** (computed with exact decimals):

| Flag | Meaning |
|---|---|
| Under-recovery | Internal cost is higher than what the client will pay (margin leakage) |
| Unpriced by client | Internal scope the client has not priced |
| Not assessed | A client line with no internal takeoff yet |
| Quantity differs | Client and internal quantities don't match |
| Rate > 2% off | Client and internal rates differ by more than 2% |

The pipeline totals the **leakage at risk** across all open estimates.

### 4.2 Project status and modules

A project carries a status: **tender → awarded → active → practical completion → final account → closed**.
Projects created by a baseline lock start as `awarded`; other status changes are still made by hand.
The intended end-to-end flow across modules:

| Phase | What happens | Module(s) | State today |
|---|---|---|---|
| Pursue | Opportunity tracked, pre-qualification, JV formed | 2 CRM & Bids | Preview |
| Price | Takeoffs from drawings, unit rates, BOQ priced; AI extracts the client BOQ | 4 Estimating, 10 AI | AI extraction **live**; estimating Preview |
| Award | Project registered with contract form and value | Core | **Live** |
| Mobilise | Workforce, plant and suppliers set up | 1 Payroll, 7 Fleet, 5 Procurement | Preview |
| Execute | Daily diaries (web or offline tablets), RFIs and site instructions, safety | 6 Field, 8 HSE | Diary and sync **live**; RFIs and HSE Preview |
| Control | Monthly IPCs, retention, variations and time bars, CVR by cost code | 3 Finance & CVR | Rules engine **live**; CVR Preview |
| Report | Owner sees progress, safety and programme, with margins hidden; signs milestones | 9 Client Portal | Preview |
| Close | Retention released, final account, records retained | 3, Audit | Audit ledger **live** |

**Rules that already hold:**
- Every financially or legally significant change writes an audit event **in the same database
  transaction** as the change, so the record and its audit entry can never disagree.
- AI never moves status or money. It only produces suggestions.
- Offline edits never silently overwrite newer server data. They come back as a **conflict** with the
  server's copy for a person to resolve.

**Still to design:** a workflow/state-machine layer (like ScopeFlow's orchestrator) with guards and
approvals for project status, valuations, variations, purchase orders and pay runs. Until it exists,
statuses are not enforced.

## 5. The modules

Status key:
- **Live:** backed by real services and data.
- **Preview:** designed screens with clearly labelled sample data; no backend yet.
- **Planned:** specified, not yet designed in the app.

| # | Module | Tier | Status | Built today | Next to build |
|---|---|---|---|---|---|
| 0 | Administration & Commercial | Base Core | **Live** (Scoping phase) | JCE intake pipeline (Kanban, drag between stages); client vs internal comparison with discrepancy flags and leakage; AI import of client BOQ lines; role-tiered approvals; baseline lock that creates the project; approval history from the audit trail | Formal estimate PDF for the client; digital signatures; estimate versions/revisions; then the Planning (PPM board), Execution and Invoicing phases |
| 1 | HRIS & SARS Payroll | Base Core / Tier A | Preview | Screens: pay run, workforce mix, SARS filings, bargaining councils | Employee directory and Paterson grading; time & attendance; **decision needed: integrate a certified payroll provider vs build the SARS engine** (see §9) |
| 2 | CRM & Bids | Base Core | Preview | Screens: tender pipeline board, JV partners | Opportunity and stage-gate model; JV equity and B-BBEE scoring; BOQ ingestion workspace (reuse AI extraction) |
| 3 | Finance & CVR | Base Core / Tier A | Rules engine **Live**, rest Preview | Formula engine for overtime, retention, allowances and escalation caps (decimal, sandboxed); CVR, IPC and variation screens | Cost codes and the CVR ledger; IPCs and retention; variations and compensation events with time-bar clocks; Haylett/CPAP escalation |
| 4 | Estimating & Takeoff | Tier B | Preview (AI extraction Live) | Unit-rate library and takeoff screens; links to live AI BOQ extraction | Rate library and assemblies; PDF/CAD takeoff viewer; subcontractor quote adjudication; addenda versions |
| 5 | Supply Chain & Procurement | Tier A | Preview | Screens: requisitions and approval, B-BBEE spend by level, three-way matching | Requisition → PO approval matrix; GRNs; invoice matching; supplier B-BBEE scorecard; stores |
| 6 | Field Operations & Daily Logs | Base Core | **Live** (RFIs Preview) | Site diary on web and offline sync; cross-project feed; KPIs (entries, labour-days, weather days, synced from devices) | Photos on diary entries; RFIs and site instructions; QA inspection sign-offs; mobile app with offline queue |
| 7 | Fleet, Equipment & CMMS | Tier B | Preview | Screens: plant register, utilisation, service status | Telematics integrations (Samsara, CAT VisionLink, KOMTRAX); service work orders; internal plant billing to cost codes |
| 8 | HSE & Safety | Tier A | Preview | Screens: LTIFR/LTI-free days, incidents, toolbox talks, NCRs | Incident reporting with RCA (OHS Act / COIDA); inductions with signatures; MHSA competency matrix; checklists → NCRs |
| 9 | Client / Owner Portal | Tier C | Preview | Screen: owner view with redacted financials and milestone sign-off | External client users and a portal role; S-curve; sign-off vault; AFC drawing access |
| 10 | AI Operations Agent | Tier C | **Live** | Tender BOQ extraction from PDF (with arithmetic check of every line); site-diary risk review; job history | Predictive cost/schedule variance; pgvector semantic search; PPE photo audits |

Every preview page shows a "Design preview · sample data" banner, and its sidebar item carries a
**Preview** tag.

### 5.1 Field Operations in detail (the reference implementation)

This is the module to copy when building the others.

- **Capture.** Foremen log on the web (`POST /api/v1/projects/:id/diary`) or on a site tablet. The
  tablet writes to a local store and later **pushes a batch** to the Go sync service (`POST /sync/v1/push`, up to 500 changes).
- **Idempotency.** Each entry has a client UUID. A retried push returns `duplicate`, not a second row.
- **Conflicts.** Edits carry `baseVersion`. If the server copy changed in the meantime, the device gets
  `conflict` plus the server record. Nothing is overwritten silently.
- **Pull.** Devices pull projects plus diary changes after a cursor (`GET /sync/v1/pull?since=`). A
  short settle window means rows from transactions that commit out of order are not skipped.
- **Audit.** Web entries write `diary.created`; each device batch writes one `diary.synced` with counts.
- **Isolation.** The sync service runs as its own database role and can only touch diaries and read projects.

### 5.2 AI Operations Agent in detail

- Jobs are asynchronous: request → `queued` → `running` → `succeeded`/`failed`. The UI polls for progress.
- **BOQ extraction:**
  1. The PDF is read from S3 and sent to Claude as a document.
  2. Claude must answer in a fixed JSON schema.
  3. The result is validated.
  4. Every `quantity × rate = amount` is then **re-checked in code**, and mismatches are flagged.
- **Diary review:** the last 60 entries are reviewed for delay, weather, safety, productivity and resourcing
  risks, citing the dates that support each finding.
- **Model:** uses `claude-opus-5-5` with a server-side refusal fallback. Local development uses a fake
  provider by default, so no API spend.
- **Safety:** the AI service's database role is **read-only** on business data. Document contents are
  treated as untrusted input, so instructions inside a PDF are ignored.

## 6. Features that run across the whole system

- **Tenant isolation:**
  - Every tenant table has PostgreSQL Row Level Security (`ENABLE` + `FORCE`), with policies on both
    reads and writes.
  - Each request runs in a transaction that sets the tenant with `SET LOCAL` semantics, so it can't
    leak across pooled connections.
  - With no tenant set, the database returns nothing (fails closed).
  - Child records reference parents by `(tenant_id, id)`, so a row can never point at another tenant's project.
  - 13 automated tests prove this against a real database.
- **One database role per service:**

  | Service | Role | Access |
  |---|---|---|
  | Core API | `constructos_app` | Reads and writes business data |
  | Sync service | `constructos_sync` | Site diary only, plus read access to projects |
  | AI engine | `constructos_ai` | Read-only, plus its job table |

  None can bypass row security, and each service refuses to start with the owner role.
- **Roles and entitlements:** what a user may do is checked on two axes:
  - **Role:** for example, only owners, admins and project managers create projects.
  - **Module:** for example, Field Operations needs `mod_field`. Entitlements are read from the
    database (cached 30 seconds in Redis), not trusted from the login token, so a suspended module stops working within seconds.
- **Audit ledger:**
  - Append-only: updates and deletes are blocked, even for the database owner.
  - Each event's SHA-256 hash includes the previous event's hash.
  - "Verify integrity" re-hashes the chain and reports the first broken event.
  - Tests prove that a database administrator who bypasses the protection is detected.
- **Documents:**
  - Uploads and downloads go **straight to S3** with short-lived signed URLs; files never pass through the API.
  - The server chooses the storage path, and only allow-listed file types are accepted.
  - Contract and tax document downloads are audited.
- **Commercial rules engine:**
  - A small formula language with exact decimal arithmetic, for client-specific overtime, retention,
    allowances and escalation.
  - Formulas are interpreted, never executed as code, and are capped in size and depth.
- **Money:** always `numeric` in the database and decimal strings in JSON, never floating point.
- **Security basics:**
  - Login is rate-limited (10 a minute, shared via Redis) and passwords are hashed with argon2.
  - Login tokens expire after 15 minutes.
  - Security headers are set, and TLS is enforced to the database in AWS.
- **User experience:**
  - Enterprise design system with light and dark themes and responsive layout down to phone width.
  - ⌘K/Ctrl K command palette to jump to modules and projects.
  - Charts follow an accessibility method: validated colours, legends, and a table view for every chart.

## 7. Technology and deployment

| Layer | Choice |
|---|---|
| Web app | React 19, TypeScript, Vite, Tailwind CSS 4, Recharts, lucide icons; served by nginx |
| Core API | Node.js 22, NestJS 11, Drizzle ORM, zod validation |
| Edge sync | Go 1.24, pgx, net/http (gRPC planned) |
| AI engine | Python 3.12, FastAPI, Anthropic SDK (Claude), psycopg 3 |
| Shared packages | `packages/db` (schema, SQL migrations, isolation tests), `packages/dsl-parser` (formula engine) |
| Database | PostgreSQL 16 (Aurora Serverless v2 in AWS) with Row Level Security; pgvector available |
| Cache | Redis (ElastiCache in AWS): rate limits and entitlement cache |
| Files | S3 (KMS-encrypted, versioned); an Object Lock bucket for audit anchors |
| Local environment | Docker Compose mirrors AWS: Postgres, Redis, S3 mock and the four app services (web on **http://localhost:8070**) |
| AWS (target) | af-south-1 (Cape Town) for POPIA. VPC, Aurora, KMS, S3, ECR, ECS Fargate in Terraform (`infra/terraform`, not yet validated). The console-built VPC and the `construct-os-tenant-storage-prod` bucket are separate and not yet wired to the code. |
| Testing | Vitest (database isolation, audit ledger, service roles, formula engine), pytest (AI engine), Go tests (sync), end-to-end smoke runs through the gateway |

Repository layout: `apps/api-core`, `apps/sync-service`, `apps/ai-engine`, `apps/web`,
`packages/db`, `packages/dsl-parser`, `infra/terraform`, `docs/`.

## 8. Design principles that recur in the code

1. **The database is the last line of defence.** Isolation, append-only audit and least privilege are
   enforced in PostgreSQL, not only in application code.
2. **Tenant comes from the verified token, never from the request.**
3. **Never silently move money or overwrite work.** Use conflicts instead of last-write-wins, decimals
   instead of floats, audit in the same transaction, and AI as suggestion only.
4. **Idempotent by design.** Client-generated IDs make retries from unreliable site connections safe.
5. **Fail closed.** No tenant context means no data. A missing module means 403. A Redis outage falls
   back to the database instead of taking the API down.
6. **Honest UI.** Sample data is always labelled. Status always carries an icon and a label, never colour alone.

## 9. Where it stands, and decisions for the product owner

**Built and verified (9 November 2026):**
- Three backend services, the web app, five database migrations and two shared packages.
- 32 database tests, 6 variance tests, 16 formula-engine tests and 12 AI-engine tests, plus the Go suites, all passing.
- End-to-end runs through the gateway covering login, projects, diary, sync, documents, AI jobs, the
  rules engine, audit verification, and the full Scoping phase: intake to baseline lock, including
  every guard and approval tier.

**Not yet built:**
- The Planning, Execution and Invoicing phases of the job pipeline.
- The client estimate PDF and digital signatures.
- Backends for modules 1, 2, 4, 5, 7, 8 and 9, and RFIs in module 6.
- A general workflow/approval engine beyond estimates.
- The mobile field app.
- Running the CI/CD pipeline and the AWS deployment for real. Both are written and statically
  validated (`docs/deployment.md`), but have not yet run against the account.
- Emailing invite links (SES), SSO and MFA. User onboarding itself is built: one-time invite and
  reset links, plus Buildkite organisation provisioning.
- Production secrets management for service-role passwords.

**Decisions needed:**
1. **Launch scope vs January 2027.** The full 10-module scope is roughly a 12-month programme. A
   credible first release is Core + Field Operations + Finance & CVR + AI.
2. **Payroll: integrate or build.** SARS PAYE specifications change every tax year and e@syFile
   certification is a product in itself. Integrating a certified payroll provider first removes the
   largest regulatory risk.
3. **AI model and POPIA.** The specification names Claude 3.5 Sonnet, which is retired; the code uses
   the current model. Sending personal information (HR, payroll, incident details) to an offshore API
   needs legal sign-off before AI is enabled for those modules.
4. **AWS:** connect the console-provisioned VPC and bucket, or adopt the Terraform definitions as the
   source of truth. Running both will drift.
5. **Build order.** Recommended: the **Planning** phase next (PPM board on top of locked baselines),
   then **Invoicing from actuals**, since together with Scoping they close the commercial loop. After
   that, Finance & CVR, which consumes the same baselines and actuals.
