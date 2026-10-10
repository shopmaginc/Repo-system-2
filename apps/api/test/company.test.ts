import { describe, expect, it, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { DbClient } from '../src/db.js';

/**
 * Phase 5 company operations tests against an in-memory stub DB.
 * Proves: suspended users lose messaging access immediately (401); a
 * non-member cannot read or post in a direct conversation (404); the
 * company-wide channel is visible and writable to every active user;
 * message sends are audit-logged WITHOUT the body; the directory is
 * addable by any staff and deletable only by the adder or a manager;
 * time-off approval is manager-only; dispatch availability excludes
 * approved time off (but not denied); the weekly report counts match
 * the underlying rows; agents are denied the report endpoint.
 */

// ---------------------------------------------------------------------------
// Stub DB (mirrors research.test.ts, extended with Phase 5 stores)
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
  cases: Row[];
  history: Row[];
  invoices: Row[];
  conversations: Row[];
  conversationMembers: Row[];
  messages: Row[];
  directoryContacts: Row[];
  timeOffRequests: Row[];
}

function makeStub(stores: Stores): DbClient {
  let seq = 10000;
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
    deleteMany: async (args: unknown) => {
      const { where } = (args as Row) ?? {};
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matchesWhere(rows[i], where as Row | undefined)) rows.splice(i, 1);
      }
      return { count: before - rows.length };
    },
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
      findMany: async (args: unknown) => {
        const { where, include } = (args as Row) ?? {};
        const out = stores.users.filter((r) => matchesWhere(r, where as Row | undefined));
        return include ? out.map(userWithRole) : out.map((r) => ({ ...r }));
      },
    },
    role: crud(stores.roles),
    fieldPermission: { ...crud(stores.fieldPermissions), upsert: crud(stores.fieldPermissions).upsert },
    refreshToken: crud(stores.refreshTokens),
    auditLog: crud(stores.auditLogs),
    client: crud([]),
    lender: crud([]),
    debtor: crud([]),
    address: crud([]),
    asset: crud([]),
    case: crud(stores.cases),
    caseStatusHistory: crud(stores.history),
    requiredDocument: crud([]),
    task: crud([]),
    checkIn: crud([]),
    photo: crud([]),
    lot: crud([]),
    caseLotAssignment: crud([]),
    inspectionChecklist: crud([]),
    conditionReport: crud([]),
    deliveryConfirmation: crud([]),
    invoice: crud(stores.invoices),
    skipWorksheet: crud([]),
    skipPull: crud([]),
    clientContact: crud([]),
    emailTemplate: crud([]),
    emailDraft: crud([]),
    conversation: crud(stores.conversations),
    conversationMember: crud(stores.conversationMembers),
    message: crud(stores.messages),
    directoryContact: crud(stores.directoryContacts),
    timeOffRequest: crud(stores.timeOffRequests),
  } as unknown as DbClient;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const stores: Stores = {
  users: [],
  roles: [],
  fieldPermissions: [],
  refreshTokens: [],
  auditLogs: [],
  cases: [],
  history: [],
  invoices: [],
  conversations: [],
  conversationMembers: [],
  messages: [],
  directoryContacts: [],
  timeOffRequests: [],
};

let app: FastifyInstance;
let agentToken: string;
let managerToken: string;
let driverToken: string;
let clerkToken: string;
let suspendedToken: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  stores.roles.push(
    { id: 'role-agent', name: 'agent', canCaptureLotPhotos: true },
    { id: 'role-manager', name: 'manager', canCaptureLotPhotos: true },
    { id: 'role-driver', name: 'transport_driver', canCaptureLotPhotos: true },
    { id: 'role-clerk', name: 'office_clerk', canCaptureLotPhotos: true },
  );
  stores.users.push(
    { id: 'user-agent', name: 'Test Agent', email: 'agent@t.co', roleId: 'role-agent', status: 'active', phone: '555-0001' },
    { id: 'user-manager', name: 'Test Manager', email: 'manager@t.co', roleId: 'role-manager', status: 'active', phone: '555-0002' },
    { id: 'user-driver', name: 'Test Driver', email: 'driver@t.co', roleId: 'role-driver', status: 'active', phone: '555-0003' },
    { id: 'user-clerk', name: 'Test Clerk', email: 'clerk@t.co', roleId: 'role-clerk', status: 'active', phone: '555-0004' },
    { id: 'user-suspended', name: 'Ex Employee', email: 'ex@t.co', roleId: 'role-agent', status: 'suspended', phone: '555-0005' },
  );
  // Company-wide channel seeded like the real seed script.
  stores.conversations.push({
    id: 'conv-wide',
    kind: 'company_wide',
    title: 'Company wide',
    createdById: 'user-manager',
    createdAt: new Date(),
  });

  app = await buildApp({
    config: { JWT_SECRET: 'test-secret-at-least-32-chars-long!!', UPLOADS_DIR: '/tmp/test-uploads', MAX_UPLOAD_MB: 10 } as never,
    db: makeStub(stores),
  });

  const sign = (sub: string) => app.jwt.sign({ role: 'x' }, { sub } as never);
  agentToken = sign('user-agent');
  managerToken = sign('user-manager');
  driverToken = sign('user-driver');
  clerkToken = sign('user-clerk');
  suspendedToken = sign('user-suspended');
});

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

describe('messaging', () => {
  it('creates a direct conversation; both members can list and post', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: auth(agentToken),
      payload: { kind: 'direct', memberIds: ['user-manager'], title: 'Case sync' },
    });
    expect(created.statusCode).toBe(201);
    const convId = (created.json() as Row).conversation.id as string;

    const list = await app.inject({ method: 'GET', url: '/conversations', headers: auth(managerToken) });
    const convs = (list.json() as Row).conversations as Row[];
    expect(convs.some((c) => c.id === convId)).toBe(true);

    const sent = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: auth(managerToken),
      payload: { body: 'On my way to the lot' },
    });
    expect(sent.statusCode).toBe(201);
    const msg = (sent.json() as Row).message as Row;
    expect(msg.senderName).toBe('Test Manager');

    const read = await app.inject({
      method: 'GET',
      url: `/conversations/${convId}/messages`,
      headers: auth(agentToken),
    });
    expect(read.statusCode).toBe(200);
    const msgs = (read.json() as Row).messages as Row[];
    expect(msgs.length).toBe(1);
    expect(msgs[0].body).toBe('On my way to the lot');
    expect(msgs[0].senderName).toBe('Test Manager');
  });

  it('rejects direct conversation creation with non-active members', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: auth(agentToken),
      payload: { kind: 'direct', memberIds: ['user-suspended'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('non-member gets 404 reading and posting in a direct conversation', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: auth(agentToken),
      payload: { kind: 'direct', memberIds: ['user-manager'] },
    });
    const convId = (created.json() as Row).conversation.id as string;

    const read = await app.inject({
      method: 'GET',
      url: `/conversations/${convId}/messages`,
      headers: auth(driverToken),
    });
    expect(read.statusCode).toBe(404);

    const post = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: auth(driverToken),
      payload: { body: 'hello?' },
    });
    expect(post.statusCode).toBe(404);
  });

  it('company-wide channel is visible and writable to every active user', async () => {
    for (const token of [agentToken, driverToken, clerkToken]) {
      const list = await app.inject({ method: 'GET', url: '/conversations', headers: auth(token) });
      const convs = (list.json() as Row).conversations as Row[];
      expect(convs.some((c) => c.kind === 'company_wide')).toBe(true);
    }
    const post = await app.inject({
      method: 'POST',
      url: '/conversations/conv-wide/messages',
      headers: auth(driverToken),
      payload: { body: 'Morning all — truck is rolling' },
    });
    expect(post.statusCode).toBe(201);
  });

  it('suspended users lose messaging access immediately', async () => {
    const list = await app.inject({ method: 'GET', url: '/conversations', headers: auth(suspendedToken) });
    expect(list.statusCode).toBe(401);
    const post = await app.inject({
      method: 'POST',
      url: '/conversations/conv-wide/messages',
      headers: auth(suspendedToken),
      payload: { body: 'should not work' },
    });
    expect(post.statusCode).toBe(401);
  });

  it('message sends are audit-logged without the body', async () => {
    const before = stores.auditLogs.length;
    await app.inject({
      method: 'POST',
      url: '/conversations/conv-wide/messages',
      headers: auth(agentToken),
      payload: { body: 'sensitive chatter here' },
    });
    const rows = stores.auditLogs.slice(before).filter((r) => r.action === 'company.message_sent');
    expect(rows.length).toBe(1);
    expect(rows[0].entityType).toBe('conversation');
    expect(JSON.stringify(rows[0].details)).not.toContain('sensitive chatter here');
  });

  it('paginates messages latest-first with a cursor', async () => {
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      stores.messages.push({
        id: `page-msg-${i}`,
        conversationId: 'conv-wide',
        senderId: 'user-agent',
        body: `msg ${i}`,
        createdAt: new Date(base + i * 1000),
      });
    }
    const first = await app.inject({
      method: 'GET',
      url: '/conversations/conv-wide/messages?limit=2',
      headers: auth(agentToken),
    });
    const page1 = (first.json() as Row).messages as Row[];
    expect(page1.length).toBe(2);
    expect(page1[0].body).toBe('msg 2');
    const nextBefore = (first.json() as Row).nextBefore as string;
    expect(nextBefore).toBeTruthy();
    const second = await app.inject({
      method: 'GET',
      url: `/conversations/conv-wide/messages?limit=2&before=${nextBefore}`,
      headers: auth(agentToken),
    });
    const page2 = (second.json() as Row).messages as Row[];
    expect(page2.some((m) => m.body === 'msg 0')).toBe(true);
    expect(page2.some((m) => m.body === 'msg 2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

describe('directory', () => {
  it('any staff can add; search finds by name, company, or role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/directory',
      headers: auth(agentToken),
      payload: { name: 'Tow Dispatch', company: 'Quick Tow', role: 'Dispatcher', phone: '555-1111' },
    });
    expect(res.statusCode).toBe(201);

    const search = await app.inject({
      method: 'GET',
      url: '/directory?q=quick',
      headers: auth(driverToken),
    });
    const contacts = (search.json() as Row).contacts as Row[];
    expect(contacts.length).toBe(1);
    expect(contacts[0].name).toBe('Tow Dispatch');
    expect(contacts[0].phone).toBe('555-1111');
    expect(contacts[0].addedByName).toBe('Test Agent');
  });

  it('only the adder or a manager can delete', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/directory',
      headers: auth(agentToken),
      payload: { name: 'Deletable Contact' },
    });
    const id = (res.json() as Row).contact.id as string;

    const denied = await app.inject({
      method: 'DELETE',
      url: `/directory/${id}`,
      headers: auth(driverToken),
    });
    expect(denied.statusCode).toBe(403);

    const adderOk = await app.inject({
      method: 'DELETE',
      url: `/directory/${id}`,
      headers: auth(agentToken),
    });
    expect(adderOk.statusCode).toBe(200);

    const res2 = await app.inject({
      method: 'POST',
      url: '/directory',
      headers: auth(driverToken),
      payload: { name: 'Manager Deletes This' },
    });
    const id2 = (res2.json() as Row).contact.id as string;
    const mgrOk = await app.inject({
      method: 'DELETE',
      url: `/directory/${id2}`,
      headers: auth(managerToken),
    });
    expect(mgrOk.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Time off + dispatch availability
// ---------------------------------------------------------------------------

describe('time off', () => {
  it('request round-trips; approval is manager-only', async () => {
    const req = await app.inject({
      method: 'POST',
      url: '/time-off',
      headers: auth(agentToken),
      payload: { startDate: '2026-10-20', endDate: '2026-10-22', reason: 'Family' },
    });
    expect(req.statusCode).toBe(201);
    const id = (req.json() as Row).request.id as string;

    const agentApprove = await app.inject({
      method: 'POST',
      url: `/time-off/${id}/approve`,
      headers: auth(agentToken),
      payload: {},
    });
    expect(agentApprove.statusCode).toBe(403);

    const mgrApprove = await app.inject({
      method: 'POST',
      url: `/time-off/${id}/approve`,
      headers: auth(managerToken),
      payload: { note: 'Covered' },
    });
    expect(mgrApprove.statusCode).toBe(200);
    expect((mgrApprove.json() as Row).request.status).toBe('approved');

    const mine = await app.inject({ method: 'GET', url: '/time-off', headers: auth(agentToken) });
    const mineList = (mine.json() as Row).requests as Row[];
    expect(mineList.some((r) => r.id === id && r.status === 'approved')).toBe(true);

    const pending = await app.inject({
      method: 'GET',
      url: '/time-off?status=pending',
      headers: auth(managerToken),
    });
    const pendingList = (pending.json() as Row).requests as Row[];
    expect(pendingList.some((r) => r.id === id)).toBe(false);
  });

  it('rejects an end date before the start date', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/time-off',
      headers: auth(agentToken),
      payload: { startDate: '2026-10-22', endDate: '2026-10-20' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('availability excludes approved time off but not denied', async () => {
    // Driver takes approved time off covering 2026-11-05.
    const req = await app.inject({
      method: 'POST',
      url: '/time-off',
      headers: auth(driverToken),
      payload: { startDate: '2026-11-05', endDate: '2026-11-06' },
    });
    const id = (req.json() as Row).request.id as string;
    await app.inject({ method: 'POST', url: `/time-off/${id}/approve`, headers: auth(managerToken), payload: {} });

    // Clerk requests time off but gets denied.
    const req2 = await app.inject({
      method: 'POST',
      url: '/time-off',
      headers: auth(clerkToken),
      payload: { startDate: '2026-11-05', endDate: '2026-11-05' },
    });
    const id2 = (req2.json() as Row).request.id as string;
    await app.inject({ method: 'POST', url: `/time-off/${id2}/deny`, headers: auth(managerToken), payload: {} });

    const avail = await app.inject({
      method: 'GET',
      url: '/dispatch/availability?date=2026-11-05',
      headers: auth(managerToken),
    });
    expect(avail.statusCode).toBe(200);
    const list = (avail.json() as Row).available as Row[];
    // Driver is out; agent is in; clerk is not field staff (agent/driver only).
    expect(list.some((u) => u.userId === 'user-driver')).toBe(false);
    expect(list.some((u) => u.userId === 'user-agent')).toBe(true);
    expect(list.some((u) => u.userId === 'user-clerk')).toBe(false);

    const denied = await app.inject({
      method: 'GET',
      url: '/dispatch/availability?date=2026-11-05',
      headers: auth(agentToken),
    });
    expect(denied.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Weekly report
// ---------------------------------------------------------------------------

describe('weekly report', () => {
  beforeAll(async () => {
    const now = Date.now();
    const twoWeeksAgo = new Date(now - 14 * 86_400_000);
    const yesterday = new Date(now - 86_400_000);
    stores.cases.push(
      { id: 'case-r1', caseNumber: 'R-1', status: 'possession', assignedAgentId: 'user-agent', createdAt: new Date(now - 5 * 86_400_000) },
      { id: 'case-r2', caseNumber: 'R-2', status: 'delivery', assignedAgentId: 'user-agent', createdAt: new Date(now - 10 * 86_400_000) },
      { id: 'case-r3', caseNumber: 'R-3', status: 'closed', assignedAgentId: null, createdAt: twoWeeksAgo },
    );
    stores.history.push(
      { id: 'h-r1', caseId: 'case-r1', from: 'verify', to: 'possession', actorId: 'user-agent', createdAt: yesterday },
      { id: 'h-r2', caseId: 'case-r2', from: 'lot_storage', to: 'delivery', actorId: 'user-agent', createdAt: yesterday },
      // Old possession — outside this week, must not count.
      { id: 'h-r3', caseId: 'case-r3', from: 'verify', to: 'possession', actorId: 'user-agent', createdAt: twoWeeksAgo },
    );
    stores.invoices.push(
      { id: 'inv-r1', caseId: 'case-r2', invoiceNumber: 'INV-1', status: 'pending', createdAt: yesterday, updatedAt: yesterday },
      { id: 'inv-r2', caseId: 'case-r3', invoiceNumber: 'INV-2', status: 'approved', createdAt: twoWeeksAgo, updatedAt: yesterday },
    );
  });

  it('denies agents, returns correct counts for managers', async () => {
    const denied = await app.inject({ method: 'GET', url: '/reports/week', headers: auth(agentToken) });
    expect(denied.statusCode).toBe(403);

    const res = await app.inject({ method: 'GET', url: '/reports/week', headers: auth(managerToken) });
    expect(res.statusCode).toBe(200);
    const report = (res.json() as Row).report as Row;
    expect((report.casesByStatus as Row).possession).toBe(1);
    expect((report.casesByStatus as Row).delivery).toBe(1);
    expect((report.casesByStatus as Row).closed).toBe(1);
    expect(report.possessions).toBe(1);
    expect(report.deliveries).toBe(1);
    expect(report.invoicesCreated).toBe(1);
    expect(report.invoicesApproved).toBe(1);
    // case-r1: created 5 days ago, possessed yesterday → ~4 days.
    expect(report.avgDaysIntakeToPossession).toBe(4);
    const agents = report.perAgent as Row[];
    const agent = agents.find((a) => a.agentId === 'user-agent');
    expect(agent.assignedCases).toBe(2);
    expect(agent.possessions).toBe(1);
    expect(report.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
