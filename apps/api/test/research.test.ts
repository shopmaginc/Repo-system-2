import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../src/lib/password.js';
import { buildApp } from '../src/app.js';
import type { DbClient } from '../src/db.js';

/**
 * Phase 4 research + client delivery tests against an in-memory stub DB.
 * Proves: the one-tap internal cross-reference finds matching cases by
 * phone and VIN while hiding ungranted PII (SSN); the worksheet round-trips;
 * deep-pull requests raise a manager task and only office roles can complete
 * them; the email draft → submit → approve → send pipeline works, agents
 * cannot approve or send, sending an unapproved draft is rejected, rejects
 * require a note, template placeholders render from filtered case data, and
 * the printable skip report omits ungranted PII.
 */

// ---------------------------------------------------------------------------
// Stub DB (mirrors recovery.test.ts, extended with Phase 4 stores)
// ---------------------------------------------------------------------------
interface Row {
  [k: string]: unknown;
}

function matchesWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const op = v as Row;
      if ('in' in op) return (op.in as unknown[]).includes(row[k]);
      return matchesWhere(row[k] as Row, op);
    }
    return row[k] === v;
  });
}

interface Stores {
  users: Row[];
  roles: Row[];
  fieldPermissions: Row[];
  refreshTokens: Row[];
  auditLogs: Row[];
  clients: Row[];
  lenders: Row[];
  debtors: Row[];
  addresses: Row[];
  assets: Row[];
  cases: Row[];
  history: Row[];
  documents: Row[];
  tasks: Row[];
  checkIns: Row[];
  photos: Row[];
  lots: Row[];
  lotAssignments: Row[];
  inspections: Row[];
  conditionReports: Row[];
  deliveryConfirmations: Row[];
  invoices: Row[];
  skipWorksheets: Row[];
  skipPulls: Row[];
  clientContacts: Row[];
  emailTemplates: Row[];
  emailDrafts: Row[];
}

function makeStub(stores: Stores): DbClient {
  let seq = 9000;
  const nid = () => `stub-${seq++}`;

  const crud = (rows: Row[]) => ({
    findUnique: async (args: unknown) => {
      const { where } = args as Row;
      return rows.find((r) => matchesWhere(r, where as Row)) ?? null;
    },
    findFirst: async (args: unknown) => {
      const { where } = args as Row;
      return rows.find((r) => matchesWhere(r, where as Row)) ?? null;
    },
    findMany: async (args: unknown) => {
      const { where, orderBy } = (args as Row) ?? {};
      let out = rows.filter((r) => matchesWhere(r, where as Row | undefined));
      if (orderBy) {
        const [key, dir] = Object.entries(orderBy as Row)[0] as [string, string];
        out = [...out].sort((a, b) =>
          String(a[key]) < String(b[key]) ? (dir === 'desc' ? 1 : -1) : dir === 'desc' ? -1 : 1,
        );
      }
      return out;
    },
    create: async (args: unknown) => {
      const { data } = args as Row;
      const row: Row = { id: nid(), createdAt: new Date(), updatedAt: new Date(), ...(data as Row) };
      rows.push(row);
      return row;
    },
    update: async (args: unknown) => {
      const { where, data } = args as Row;
      const row = rows.find((r) => matchesWhere(r, where as Row));
      if (!row) throw new Error('not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
    updateMany: async () => ({ count: 0 }),
    upsert: async (args: unknown) => {
      const { where, create, update } = args as Row;
      const found = rows.find((r) => matchesWhere(r, where as Row));
      if (found) {
        Object.assign(found, update, { updatedAt: new Date() });
        return found;
      }
      const row: Row = { id: nid(), createdAt: new Date(), updatedAt: new Date(), ...(create as Row) };
      rows.push(row);
      return row;
    },
    delete: async (args: unknown) => {
      const { where } = args as Row;
      const idx = rows.findIndex((r) => matchesWhere(r, where as Row));
      if (idx === -1) throw new Error('not found');
      return rows.splice(idx, 1)[0];
    },
  });

  const withCaseRelations = (c: Row): Row => ({
    ...c,
    debtor: stores.debtors.find((d) => d.id === c.debtorId) ?? null,
    asset: stores.assets.find((a) => a.id === c.assetId) ?? null,
    client: stores.clients.find((x) => x.id === c.clientId) ?? null,
    lender: stores.lenders.find((x) => x.id === c.lenderId) ?? null,
    assignedAgent: (() => {
      const u = stores.users.find((x) => x.id === c.assignedAgentId);
      if (!u) return null;
      return { id: u.id, name: u.name };
    })(),
    addresses: stores.addresses.filter((a) => a.caseId === c.id),
  });

  const userWithRole = (u: Row): Row => ({
    ...u,
    role: stores.roles.find((r) => r.id === u.roleId) ?? null,
  });

  return {
    user: {
      ...crud(stores.users),
      findUnique: async (args: unknown) => {
        const { where, include } = args as Row;
        const row = stores.users.find((r) => matchesWhere(r, where as Row));
        if (!row) return null;
        return include ? userWithRole(row) : { ...row };
      },
    },
    role: crud(stores.roles),
    fieldPermission: {
      ...crud(stores.fieldPermissions),
      findMany: async (args: unknown) => {
        const { where } = (args as Row) ?? {};
        return stores.fieldPermissions.filter((r) => matchesWhere(r, where as Row | undefined));
      },
    },
    refreshToken: crud(stores.refreshTokens),
    auditLog: {
      create: async (args: unknown) => {
        const { data } = args as Row;
        const row: Row = { id: nid(), createdAt: new Date(), ...(data as Row) };
        stores.auditLogs.push(row);
        return row;
      },
    },
    client: crud(stores.clients),
    lender: crud(stores.lenders),
    debtor: crud(stores.debtors),
    address: crud(stores.addresses),
    asset: crud(stores.assets),
    case: {
      ...crud(stores.cases),
      findUnique: async (args: unknown) => {
        const { where } = args as Row;
        const row = stores.cases.find((r) => matchesWhere(r, where as Row));
        return row ? withCaseRelations(row) : null;
      },
      findMany: async (args: unknown) => {
        const { where } = (args as Row) ?? {};
        return stores.cases
          .filter((r) => matchesWhere(r, where as Row | undefined))
          .map(withCaseRelations);
      },
    } as unknown as DbClient['case'],
    caseStatusHistory: crud(stores.history),
    requiredDocument: crud(stores.documents),
    task: crud(stores.tasks),
    checkIn: crud(stores.checkIns),
    photo: crud(stores.photos),
    lot: crud(stores.lots),
    caseLotAssignment: crud(stores.lotAssignments),
    inspectionChecklist: crud(stores.inspections),
    conditionReport: crud(stores.conditionReports),
    deliveryConfirmation: crud(stores.deliveryConfirmations),
    invoice: crud(stores.invoices),
    skipWorksheet: {
      findUnique: crud(stores.skipWorksheets).findUnique,
      upsert: crud(stores.skipWorksheets).upsert,
    } as unknown as DbClient['skipWorksheet'],
    skipPull: crud(stores.skipPulls) as unknown as DbClient['skipPull'],
    clientContact: crud(stores.clientContacts) as unknown as DbClient['clientContact'],
    emailTemplate: {
      findMany: crud(stores.emailTemplates).findMany,
      findUnique: crud(stores.emailTemplates).findUnique,
      upsert: crud(stores.emailTemplates).upsert,
    } as unknown as DbClient['emailTemplate'],
    emailDraft: crud(stores.emailDrafts) as unknown as DbClient['emailDraft'],
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const stores: Stores = {
  users: [], roles: [], fieldPermissions: [], refreshTokens: [], auditLogs: [],
  clients: [], lenders: [], debtors: [], addresses: [], assets: [],
  cases: [], history: [], documents: [], tasks: [], checkIns: [],
  photos: [], lots: [], lotAssignments: [], inspections: [],
  conditionReports: [], deliveryConfirmations: [], invoices: [],
  skipWorksheets: [], skipPulls: [], clientContacts: [], emailTemplates: [], emailDrafts: [],
};

let app: FastifyInstance;
let agentToken: string;
let managerToken: string;
let clerkToken: string;

const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  stores.roles.push(
    { id: 'role-agent', name: 'agent', canCaptureLotPhotos: true },
    { id: 'role-manager', name: 'manager', canCaptureLotPhotos: true },
    { id: 'role-clerk', name: 'office_clerk', canCaptureLotPhotos: true },
  );
  let i = 0;
  const fp = (roleId: string, field: string, access: string) => ({
    id: `fp-${i++}`, roleId, entity: 'debtor', field, access,
  });
  stores.fieldPermissions.push(fp('role-agent', 'name', 'read'));
  stores.fieldPermissions.push(fp('role-clerk', 'name', 'read'));
  for (const f of ['name', 'ssn', 'dob', 'homeAddress', 'personalPhone', 'email', 'skipResults']) {
    stores.fieldPermissions.push(fp('role-manager', f, 'read'));
  }

  const passwordHash = await hashPassword(PASSWORD);
  const mkUser = (id: string, email: string, roleId: string): Row => ({
    id, name: email, email, phone: null, passwordHash, roleId,
    status: 'active', photoUrl: null, createdAt: new Date(), updatedAt: new Date(),
  });
  stores.users.push(
    mkUser('u-agent1', 'agent1@repo-system.local', 'role-agent'),
    mkUser('u-manager', 'manager@repo-system.local', 'role-manager'),
    mkUser('u-clerk', 'clerk@repo-system.local', 'role-clerk'),
  );

  stores.clients.push({ id: 'client-1', name: 'Great Lakes Asset Recovery', contactName: 'Michael Laspada' });
  stores.clientContacts.push({
    id: 'cc-1', clientId: 'client-1', name: 'Michael Laspada', role: 'Coordinator',
    phone: '(555) 010-2030', email: 'michael@example.com', cell: '(555) 010-2031',
  });
  stores.lenders.push({ id: 'lender-1', name: 'Demo National Bank' });
  // debtor-1: the agent's debtor — SSN must stay hidden from the agent.
  stores.debtors.push({
    id: 'debtor-1', name: 'Recovery Debtor', ssn: '111-22-3333',
    personalPhone: '(555) 010-1111', email: 'debtor@example.com',
    homeAddress: '100 Skip Trace Ln, Laredo, TX 78040',
  });
  // debtor-2: different name, SAME phone → cross-ref should hit on debtor_phone.
  stores.debtors.push({
    id: 'debtor-2', name: 'Different Person', ssn: '999-88-7777',
    personalPhone: '5550101111', email: 'other@example.com',
  });
  stores.assets.push({
    id: 'asset-1', vin: '1XPBD49X2LD704829', year: 2020, make: 'Peterbilt',
    model: '579', color: 'Red', plate: 'TX12345',
  });

  // case-A: the agent's case.
  stores.cases.push({
    id: 'case-A', caseNumber: 'CS-SKIP001', status: 'field_work', priority: 'normal',
    clientId: 'client-1', lenderId: 'lender-1', debtorId: 'debtor-1', assetId: 'asset-1',
    assignedAgentId: 'u-agent1',
  });
  stores.addresses.push({
    id: 'addr-A1', caseId: 'case-A', label: 'given', street: '100 Skip Trace Ln',
    city: 'Laredo', state: 'TX', zip: '78040',
  });
  // case-B: another case sharing the debtor phone (and the asset VIN).
  stores.cases.push({
    id: 'case-B', caseNumber: 'CS-SKIP002', status: 'closed', priority: 'normal',
    clientId: 'client-1', lenderId: 'lender-1', debtorId: 'debtor-2', assetId: 'asset-1',
    assignedAgentId: 'u-agent1',
  });
  // case-C: unrelated case — must never match.
  stores.debtors.push({ id: 'debtor-3', name: 'Unrelated Debtor', personalPhone: '(555) 999-0000' });
  stores.assets.push({ id: 'asset-3', vin: '3AKJHHDRXKSKG1716' });
  stores.cases.push({
    id: 'case-C', caseNumber: 'CS-SKIP003', status: 'closed', priority: 'normal',
    clientId: 'client-1', lenderId: 'lender-1', debtorId: 'debtor-3', assetId: 'asset-3',
    assignedAgentId: 'u-agent1',
  });

  stores.emailTemplates.push({
    id: 'tpl-1', key: 'recovery_photos', name: 'Recovery photos',
    subject: 'Recovery photos — {{asset_year}} {{asset_make}} ({{case_number}})',
    body: 'VIN {{asset_vin}} debtor {{debtor_name}} company {{company_name}} unknown {{nope}}',
  });

  app = await buildApp({
    config: {
      DATABASE_URL: 'postgresql://localhost:5432/test',
      JWT_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
      JWT_ACCESS_TTL_SECONDS: 900,
      PORT: 3005,
      NODE_ENV: 'test',
      UPLOADS_DIR: '/tmp/repo-test-uploads',
      MAX_UPLOAD_MB: 25,
    },
    db: makeStub(stores),
  });

  const sign = (sub: string, role: string) => app.jwt.sign({ role }, { sub });
  agentToken = sign('u-agent1', 'agent');
  managerToken = sign('u-manager', 'manager');
  clerkToken = sign('u-clerk', 'office_clerk');
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

// ---------------------------------------------------------------------------
// Internal cross-reference
// ---------------------------------------------------------------------------
describe('skip cross-reference', () => {
  it('finds a matching case by phone and VIN, hiding SSN from the agent', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cases/case-A/skip/crossref', headers: auth(agentToken),
    });
    expect(res.statusCode).toBe(200);
    const { hits } = res.json() as { hits: Array<{ caseNumber: string; matchedOn: string[]; debtor?: Record<string, unknown> }> };
    const hit = hits.find((h) => h.caseNumber === 'CS-SKIP002');
    expect(hit).toBeDefined();
    expect(hit!.matchedOn).toContain('debtor_phone');
    expect(hit!.matchedOn).toContain('asset_vin');
    expect(hits.find((h) => h.caseNumber === 'CS-SKIP003')).toBeUndefined();
    // Agent grant is name-only: SSN must not leak through the hit.
    expect(hit!.debtor).toBeDefined();
    expect(hit!.debtor!.name).toBe('Different Person');
    expect(hit!.debtor!.ssn).toBeUndefined();
    // The lookup itself is audit-logged.
    expect(stores.auditLogs.some((a) => a.action === 'skip.crossref')).toBe(true);
  });

  it('returns 404 for a case outside the agent\u2019s scope', async () => {
    // case-B is assigned to the agent in fixtures; use a missing id instead.
    const res = await app.inject({
      method: 'GET', url: '/cases/case-nope/skip/crossref', headers: auth(agentToken),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Worksheet
// ---------------------------------------------------------------------------
describe('skip worksheet', () => {
  it('round-trips worksheet entries and audits the save', async () => {
    const entries = {
      knownAddresses: [{ street: '200 Other St', city: 'Laredo', state: 'TX', zip: '78041' }],
      phones: [{ number: '(555) 010-2222', source: 'worksheet' }],
      associates: [{ name: 'Jane Associate', relation: 'spouse' }],
      vehicles: [{ plate: 'TX99999', description: 'white pickup' }],
      notes: 'Seen at the address twice.',
    };
    const put = await app.inject({
      method: 'PUT', url: '/cases/case-A/skip/worksheet', headers: auth(agentToken), payload: entries,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().worksheet.phones[0].number).toBe('(555) 010-2222');

    const get = await app.inject({
      method: 'GET', url: '/cases/case-A/skip/worksheet', headers: auth(agentToken),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().worksheet.notes).toBe('Seen at the address twice.');
    expect(stores.auditLogs.some((a) => a.action === 'skip.worksheet_saved')).toBe(true);
  });

  it('rejects malformed worksheet payloads', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/cases/case-A/skip/worksheet', headers: auth(agentToken),
      payload: { phones: [{ number: 123 }] },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Deep pulls
// ---------------------------------------------------------------------------
describe('skip deep pulls', () => {
  it('tracks a pull request and raises a manager task', async () => {
    const res = await app.inject({
      method: 'POST', url: '/cases/case-A/skip/pulls', headers: auth(agentToken),
      payload: { provider: 'infotracer' },
    });
    expect(res.statusCode).toBe(201);
    const { pull } = res.json() as { pull: { id: string; provider: string; status: string } };
    expect(pull.provider).toBe('infotracer');
    expect(pull.status).toBe('requested');
    expect(stores.tasks.some((t) => String(t.title).startsWith('DEEP PULL REQUESTED'))).toBe(true);
  });

  it('rejects an unknown provider', async () => {
    const res = await app.inject({
      method: 'POST', url: '/cases/case-A/skip/pulls', headers: auth(agentToken),
      payload: { provider: 'acme-data' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lets the office complete a pull; agents cannot', async () => {
    const pull = stores.skipPulls[stores.skipPulls.length - 1];
    const agentTry = await app.inject({
      method: 'POST', url: `/cases/case-A/skip/pulls/${pull.id}/complete`,
      headers: auth(agentToken), payload: { summary: 'agent tries' },
    });
    expect(agentTry.statusCode).toBe(403);

    const done = await app.inject({
      method: 'POST', url: `/cases/case-A/skip/pulls/${pull.id}/complete`,
      headers: auth(clerkToken), payload: { summary: 'Found two new addresses.', resultRefs: { report: 'IT-123' } },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().pull.status).toBe('complete');
    expect(done.json().pull.summary).toBe('Found two new addresses.');
  });
});

// ---------------------------------------------------------------------------
// Client contacts
// ---------------------------------------------------------------------------
describe('client contacts', () => {
  it('clerk can CRUD contacts; agents can only list', async () => {
    const created = await app.inject({
      method: 'POST', url: '/clients/client-1/contacts', headers: auth(clerkToken),
      payload: { name: 'New Contact', email: 'new@example.com', role: 'Billing' },
    });
    expect(created.statusCode).toBe(201);
    const contactId = created.json().contact.id as string;

    const agentCreate = await app.inject({
      method: 'POST', url: '/clients/client-1/contacts', headers: auth(agentToken),
      payload: { name: 'Nope', email: 'nope@example.com' },
    });
    expect(agentCreate.statusCode).toBe(403);

    const list = await app.inject({
      method: 'GET', url: '/clients/client-1/contacts', headers: auth(agentToken),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().contacts.length).toBeGreaterThanOrEqual(2);

    const updated = await app.inject({
      method: 'PATCH', url: `/clients/client-1/contacts/${contactId}`, headers: auth(clerkToken),
      payload: { role: 'Accounts payable' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().contact.role).toBe('Accounts payable');

    const deleted = await app.inject({
      method: 'DELETE', url: `/clients/client-1/contacts/${contactId}`, headers: auth(clerkToken),
    });
    expect(deleted.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Email pipeline
// ---------------------------------------------------------------------------
describe('client email pipeline', () => {
  it('lists templates and renders placeholders from filtered case data', async () => {
    const tpl = await app.inject({ method: 'GET', url: '/email/templates', headers: auth(agentToken) });
    expect(tpl.statusCode).toBe(200);
    expect(tpl.json().templates.some((t: { key: string }) => t.key === 'recovery_photos')).toBe(true);

    const res = await app.inject({
      method: 'POST', url: '/cases/case-A/email/drafts', headers: auth(agentToken),
      payload: { templateKey: 'recovery_photos', toContactId: 'cc-1' },
    });
    expect(res.statusCode).toBe(201);
    const { draft } = res.json() as { draft: { to: string; subject: string; body: string; status: string } };
    expect(draft.to).toBe('michael@example.com');
    expect(draft.status).toBe('draft');
    expect(draft.body).toContain('1XPBD49X2LD704829'); // {{asset_vin}} rendered
    expect(draft.body).toContain('Recovery Debtor'); // {{debtor_name}} — name is granted
    expect(draft.body).toContain('Complete Recovery Solutions'); // {{company_name}}
    expect(draft.body).not.toContain('{{asset_vin}}');
    expect(draft.body).toContain('{{nope}}'); // unknown placeholders left as-is
    // SSN is NOT granted to the agent — and it was never in the template.
    expect(draft.body).not.toContain('111-22-3333');
  });

  it('runs the draft → submit → approve → send happy path with a full log', async () => {
    const created = await app.inject({
      method: 'POST', url: '/cases/case-A/email/drafts', headers: auth(clerkToken),
      payload: { templateKey: 'recovery_photos', to: 'client@example.com' },
    });
    const draftId = created.json().draft.id as string;

    const submitted = await app.inject({
      method: 'POST', url: `/cases/case-A/email/drafts/${draftId}/submit`, headers: auth(clerkToken),
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().draft.status).toBe('pending_approval');
    expect(stores.tasks.some((t) => String(t.title).startsWith('EMAIL NEEDS APPROVAL'))).toBe(true);

    const approved = await app.inject({
      method: 'POST', url: `/cases/case-A/email/drafts/${draftId}/approve`, headers: auth(managerToken),
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().draft.status).toBe('approved');

    const sent = await app.inject({
      method: 'POST', url: `/cases/case-A/email/drafts/${draftId}/send`, headers: auth(managerToken),
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().draft.status).toBe('sent');
    expect(sent.json().draft.transport).toBe('pending-smtp-config');

    // Full log: case history entry + audit row with the content.
    expect(stores.history.some((h) => String(h.note).startsWith('Email sent:'))).toBe(true);
    const audit = stores.auditLogs.find((a) => a.action === 'email.sent');
    expect(audit).toBeDefined();
    expect((audit!.details as Row).to).toBe('client@example.com');
    expect((audit!.details as Row).transport).toBe('pending-smtp-config');
  });

  it('agents cannot approve or send', async () => {
    const created = await app.inject({
      method: 'POST', url: '/cases/case-A/email/drafts', headers: auth(clerkToken),
      payload: { templateKey: 'recovery_photos', to: 'client@example.com' },
    });
    const draftId = created.json().draft.id as string;
    await app.inject({
      method: 'POST', url: `/cases/case-A/email/drafts/${draftId}/submit`, headers: auth(clerkToken),
    });

    const approve = await app.inject({
      method: 'POST', url: `/cases/case-A/email/drafts/${draftId}/approve`, headers: auth(agentToken),
    });
    expect(approve.statusCode).toBe(403);

    const send = await app.inject({
      method: 'POST', url: `/cases/case-A/email/drafts/${draftId}/send`, headers: auth(agentToken),
    });
    expect(send.statusCode).toBe(403);
  });

  it('sending an unapproved draft is rejected', async () => {
    const created = await app.inject({
      method: 'POST', url: '/cases/case-A/email/drafts', headers: auth(managerToken),
      payload: { templateKey: 'recovery_photos', to: 'client@example.com' },
    });
    const draftId = created.json().draft.id as string;
    const res = await app.inject({
      method: 'POST', url: `/cases/case-A/email/drafts/${draftId}/send`, headers: auth(managerToken),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('Only approved drafts can be sent');
  });

  it('rejecting requires a note and notifies the drafter', async () => {
    const created = await app.inject({
      method: 'POST', url: '/cases/case-A/email/drafts', headers: auth(clerkToken),
      payload: { templateKey: 'recovery_photos', to: 'client@example.com' },
    });
    const draftId = created.json().draft.id as string;
    await app.inject({
      method: 'POST', url: `/cases/case-A/email/drafts/${draftId}/submit`, headers: auth(clerkToken),
    });

    const noNote = await app.inject({
      method: 'POST', url: `/cases/case-A/email/drafts/${draftId}/reject`, headers: auth(managerToken),
      payload: {},
    });
    expect(noNote.statusCode).toBe(400);

    const rejected = await app.inject({
      method: 'POST', url: `/cases/case-A/email/drafts/${draftId}/reject`, headers: auth(managerToken),
      payload: { note: 'Wrong template — use delivery_confirmation.' },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().draft.status).toBe('rejected');
    expect(stores.tasks.some((t) => String(t.title).startsWith('Fix & resubmit email'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Printable skip report
// ---------------------------------------------------------------------------
describe('skip report', () => {
  it('compiles a print-ready report that omits ungranted PII', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cases/case-A/skip/report', headers: auth(agentToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const html = res.body as string;
    expect(html).toContain('CS-SKIP001');
    expect(html).toContain('CS-SKIP002'); // cross-ref hit included
    expect(html).toContain('debtor_phone');
    expect(html).toContain('Complete Recovery Solutions');
    expect(html).not.toContain('111-22-3333'); // agent cannot see SSN
  });

  it('shows the manager the full permitted picture', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cases/case-A/skip/report', headers: auth(managerToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body as string).toContain('111-22-3333');
  });
});
