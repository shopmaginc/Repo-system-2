# repo-system

All-in-one repossession operations management system.

**Phase 5 — company operations (final phase).** In-app peer-to-peer and
company-wide messaging (text + photo/video attachments, with send events —
never message bodies — in the audit log), the shared searchable company
contact directory (anyone can add; adder-or-manager can edit/remove), the
company-wide time-off calendar with manager approval feeding dispatch
availability, and a manager-only weekly report (cases by status,
possessions, deliveries, invoices, average intake→possession days, per-agent
counts). Suspended/revoked staff lose messaging, directory, and dispatch
access on their next request — the auth hook loads the user fresh every
request.

> Design prime directive (from the blueprint): if a workflow takes more steps
> than the old way, it is wrong. Security is an operating function, not a
> setting added at the end.

## Architecture

```
repo-system/
├── apps/api/            # Fastify + TypeScript backend (Node 20+)
│   ├── prisma/          # Prisma schema, migrations, seed script
│   └── src/
│       ├── lib/         # permissions engine, audit helper, password/token utils
│       ├── middleware/  # auth hook (JWT + per-request status check), guards
│       └── routes/      # health, auth, admin (manager-only user admin)
├── packages/shared/    # Shared types: roles, permission model, API shapes
└── docker-compose.yml   # Local PostgreSQL 15
```

**Permission model.** Managers edit a per-role, per-entity, per-field access
matrix (`FieldPermission` rows: `hidden` | `read` | `write`). The engine is
**default-deny**: any field with no explicit grant resolves to `hidden`.
Sensitive debtor fields (SSN, DOB, home address, personal phone, skip results)
are hidden for every role except manager in the seed data. Route guards
(`requireRole`, `requireFieldAccess`) enforce the matrix, and every denial is
audit-logged.

**Sessions.** Short-lived JWT access tokens (15 min default) + rotating opaque
refresh tokens (SHA-256 hashed at rest, single-use). The auth hook loads the
user from the database on **every** request, so suspend/revoke takes effect on
the very next request — and all refresh tokens are revoked at suspend/revoke
time, so no new access tokens can be minted.

## Run it locally

Prerequisites: Node 20+, Docker.

```bash
# 1. Start Postgres
docker compose up -d

# 2. Configure (never commit a real .env)
cp apps/api/.env.example apps/api/.env
# optionally: edit POSTGRES_* in your shell env to match docker-compose

# 3. Install, migrate, seed
npm install
npm run prisma:generate
npm run db:migrate
npm run db:seed     # prints DEV-ONLY manager credentials

# 4. Run
npm run dev         # API on http://localhost:3000
npm run dev:field   # Field PWA on http://localhost:5173 (proxies /api/* to :3000)
```

Health check: `GET http://localhost:3000/health`

### Field app (Phase 2)

`apps/field/` is the agent's mobile workspace: login → map of assigned
addresses (pins, nearest-first stop list) → tap-a-pin case card (VIN, debtor
as permitted, client + rep contact with tap-to-call/text, lender/bank) →
check-ins, field notes, two-capture VIN double-check, and one-tap possession
with transport-handoff task. The "More" tab holds the digital business card
(scannable vCard QR) and the digital ID badge. Installable PWA (manifest +
service worker), dark mobile-first theme, Leaflet + OpenStreetMap tiles (no
API key). In dev, Vite proxies `/api/*` to the backend, so the app works
from a phone on the same network via the dev machine's LAN address.

### Key endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | no | liveness |
| POST | `/auth/login` | no | email+password → token pair |
| POST | `/auth/refresh` | no | rotate refresh token (single-use) |
| POST | `/auth/logout` | no | revoke refresh token |
| GET | `/admin/users` | manager | list users (no password hashes, ever) |
| POST | `/admin/users` | manager | invite/create; returns initial password once |
| PATCH | `/admin/users/:id/role` | manager | reassign role |
| POST | `/admin/users/:id/suspend` | manager | immediate session kill |
| POST | `/admin/users/:id/revoke` | manager | immediate session kill |
| POST | `/admin/users/:id/reinstate` | manager | restore access |
| GET | `/admin/roles` | manager | roles + permission grants |
| PUT | `/admin/roles/:name/permissions` | manager | replace a role's matrix |
| POST | `/cases/intake` | clerk, manager | order intake: debtor/client/lender/asset/addresses in one payload; creates the 5 required-document rows |
| POST | `/cases/extract-vins` | clerk, manager | pull 17-char VIN candidates (+check-digit flags) from pasted order text; nothing auto-created |
| GET | `/cases` | all | role-scoped listing (agents see only their assignments) |
| GET | `/cases/:id` | all | detail; debtor PII filtered through the permission matrix |
| POST | `/cases/:id/assign` | clerk, manager | assign/transfer to an agent (intake → assigned) |
| POST | `/cases/:id/status` | in-scope | advance/hold with note; state machine validated, `cancelled` is manager-only |
| POST | `/cases/:id/verify-vin` | agent, manager | solo double-check: two scans must agree with each other and the asset VIN; result logged |
| GET | `/cases/:id/billing-eligibility` | clerk, manager | invoice gate: which required documents are done, whether invoicing unlocks |
| POST | `/cases/:id/documents/:kind/submit` | in-scope | submit a required document for review |
| POST | `/cases/:id/documents/:kind/approve` | manager | approve; invoice approval blocked until the gate passes |
| POST | `/cases/:id/tasks` | clerk, manager | create a task on a case |
| GET | `/cases/:id/tasks` | in-scope | list tasks |
| PATCH | `/cases/:id/tasks/:taskId` | assignee, clerk, manager | mark done |
| GET | `/auth/me` | all | own profile (name, role) for badges/cards |
| GET | `/field/assignments` | agent, manager | own active cases; `?lat=&lng=` sorts nearest-first |
| GET | `/field/cases/:id/card` | agent, manager | tap-a-pin case card; 404 unless assigned to you |
| POST | `/field/cases/:id/check-in` | agent, manager | GPS breadcrumb + timeline entry |
| POST | `/field/cases/:id/notes` | agent, manager | field note on the timeline |
| POST | `/field/cases/:id/possession` | agent, manager | verify→possession via state machine; creates transport-handoff task |
| GET | `/cases/:id/skip/crossref` | agent, clerk, manager | one-tap internal cross-reference: debtor/phones/addresses/VIN vs all cases; PII filtered |
| GET/PUT | `/cases/:id/skip/worksheet` | agent, clerk, manager | structured skip worksheet (addresses, phones, associates, vehicles, notes) |
| GET/POST | `/cases/:id/skip/pulls` | agent, clerk, manager | deep-pull requests (infotracer/beenverified/opencorporates); raises a manager task |
| POST | `/cases/:id/skip/pulls/:pullId/complete` | clerk, manager | attach pull results (summary + result refs) |
| GET | `/cases/:id/skip/report` | agent, clerk, manager | compiled skip report as print-optimized HTML (print → PDF); PII filtered |
| GET/POST/PATCH/DELETE | `/clients/:id/contacts[/:contactId]` | list: agent+; write: clerk, manager | contacts on the client record |
| GET | `/email/templates` | all | seeded client-email templates |
| GET/POST | `/cases/:id/email/drafts` | agent, clerk, manager | draft from template; `{{placeholders}}` render from filtered case data |
| POST | `/cases/:id/email/drafts/:draftId/submit` | agent, clerk, manager | → pending_approval; raises manager task |
| POST | `/cases/:id/email/drafts/:draftId/approve` | manager | approve |
| POST | `/cases/:id/email/drafts/:draftId/reject` | manager | reject with required note; notifies drafter |
| POST | `/cases/:id/email/drafts/:draftId/send` | manager | approved only; records send (status, content, `transport: pending-smtp-config`) — no SMTP configured, real delivery needs SMTP env config at deploy time |
| GET | `/conversations` | all | my direct conversations + the company-wide channel |
| POST | `/conversations` | all | new direct conversation (active members only), or ensure the company-wide channel |
| GET | `/conversations/:id/messages` | member | latest-first, `?limit=&before=` cursor; sender identity attached; 404 for non-members |
| POST | `/conversations/:id/messages` | member | send text + photo/video refs; audit logs the event, never the body |
| POST | `/uploads` | all | message attachment upload (JPEG/PNG/WebP/HEIC/PDF/MP4/MOV); returns a ref |
| GET | `/uploads/:ref` | all | serve a stored attachment |
| GET | `/directory?q=` | all | shared company directory search (name/company/role) |
| POST | `/directory` | all | anyone in the company can add a contact |
| PATCH/DELETE | `/directory/:id` | adder, manager | edit/remove a directory contact |
| POST | `/time-off` | all | request time off (start/end dates, reason) |
| GET | `/time-off` | own; manager all | list requests; `?status=` filter for managers |
| POST | `/time-off/:id/approve`, `/time-off/:id/deny` | manager | decide a pending request (audited) |
| GET | `/dispatch/availability?date=` | clerk, manager | active agents/drivers NOT on approved time off that day |
| GET | `/reports/week` | manager | this week's numbers: cases by status, possessions, deliveries, invoices, avg intake→possession days, per-agent counts |

## Security notes

- Passwords: bcrypt (cost 12). Login failures return a single generic message —
  the API never reveals whether the email, password, or account status failed.
- Error responses are `{ error: { code, message } }`. Stack traces never reach
  clients.
- All input validated with zod; validation failures return field-level detail.
- Audit log records auth events, user-admin actions, and every denied
  permission check (actor, action, entity, timestamp, IP, result).
- JWT secret must be ≥ 32 chars; the app refuses to boot without one.
- The seed's manager credentials (`manager@repo-system.local`) are
  **DEV-ONLY** — local development, never production, never committed.
- `DevicePolicy` seeds `personal` (screenshots blocked, no local downloads)
  and `company_owned` profiles. Note: screenshot blocking is enforceable only
  in the native Android app (Phase 2+); the API records the policy, the client
  enforces it.

## Tests

```bash
npm test   # vitest: permission engine (default-deny) + session invalidation
```

Tests run against an in-memory stub DB — no Postgres required. They prove:
default-deny on unknown fields, write-implies-read, suspend/revoke killing live
sessions and refresh chains, single-use refresh rotation, role guards, and
audit-logged permission denials.

## What's next — deployment

**Start here: [DEPLOY.md](./DEPLOY.md)** — the step-by-step deploy guide
for the free stack ($0/mo): Neon Postgres + Render API + Cloudflare Pages
PWA + Cloudflare R2 file storage, with the $5/mo Railway path for later.

All five phases are shipped and the acceptance gates are green:

- Phase 0: secure foundation (roles, permission matrix, auth, audit)
- Phase 1: case operations core (state machine, intake, VIN double-check, invoice gate)
- Phase 2: field agent workspace (map, case cards, check-ins, possession handoff, PWA)
- Phase 3: recovery to invoice (lot capture, review queue, delivery, condition reports, invoicing)
- Phase 4: research + client delivery (skip module, email composer with approval)
- Phase 5: company operations (messaging, directory, time off, dispatch availability, weekly report)

The native Android shell (screenshot blocking on personal devices via
FLAG_SECURE, native camera/barcode scanning) remains the mobile hardening
track alongside — the PWA enforces nothing at the OS level.

### Deployment readiness — still needs real services at deploy time

- **PostgreSQL**: migrations `0001`–`0005` are in
  `apps/api/prisma/migrations/`; run `npm run db:migrate && npm run db:seed`
  on a real database. Migrations `0003`–`0005` were hand-written (no
  Postgres/shadow DB in the build environment) — validate with
  `prisma migrate dev` against a staging database before production.
- **SMTP**: `POST /cases/:id/email/drafts/:draftId/send` records the send
  intent with `transport: "pending-smtp-config"`. Wire a real mail
  transport (SMTP env config) before client emails can actually deliver.
- **JWT secret**: the API refuses to boot without a ≥32-char `JWT_SECRET`.
- **Uploads**: files land under `UPLOADS_DIR` (default `./uploads`) on local
  disk with `0o640` permissions. For multi-instance hosting, move this to
  object storage (S3/R2) — the path is centralized in the route helpers.
- **Seed credentials**: `manager@repo-system.local` is DEV-ONLY; create real
  users via `/admin/users` and rotate before going live.
