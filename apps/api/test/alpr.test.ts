import { describe, expect, it, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { DbClient } from '../src/db.js';

/**
 * ALPR subsystem tests against an in-memory stub DB.
 * Proves: list CRUD is manager/office-only for writes (agents get 403);
 * lists sync down to any active user (lightweight inventory + full
 * download); plates are normalized on write ("abc 123" -> "ABC123") and
 * deduped within a list; hit submission returns server-side matches;
 * hits are visible to manager/office with reporter names but not agents;
 * mutations are audit-logged.
 */

// ---------------------------------------------------------------------------
// Stub DB (mirrors company.test.ts, extended with ALPR stores + createMany)
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
      if ('gte' in op || 'lte' in op || 'gt' in op || 'lt' in op) {
        const val = row[k] as unknown;
        if ('gte' in op && (val as never) < (op.gte as never)) return false;
        if ('lte' in op && (val as never) > (op.lte as never)) return false;
        if ('gt' in op && (val as never) <= (op.gt as never)) return false;
        if ('lt' in op && (val as never) >= (op.lt as never)) return false;
        return true;
      }
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
  plateLists: Row[];
  plateEntries: Row[];
  plateHits: Row[];
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
      const { where, orderBy, take } = (args as Row) ?? {};
      let out = rows.filter((r) => matchesWhere(r, where as Row | undefined));
      if (orderBy) {
        const [key, dir] = Object.entries(orderBy as Row)[0] as [string, string];
        out = [...out].sort((a, b) =>
          String(a[key]) < String(b[key]) ? (dir === 'desc' ? 1 : -1) : dir === 'desc' ? -1 : 1,
        );
      }
      if (typeof take === 'number') out = out.slice(0, take);
      return out;
    },
    create: async (args: unknown) => {
      const { data } = args as Row;
      const row: Row = { id: nid(), createdAt: new Date(), updatedAt: new Date(), ...(data as Row) };
      rows.push(row);
      return row;
    },
    createMany: async (args: unknown) => {
      const { data } = args as Row;
      const list = Array.isArray(data) ? data : [data];
      for (const d of list) {
        rows.push({ id: nid(), createdAt: new Date(), updatedAt: new Date(), ...(d as Row) });
      }
      return { count: list.length };
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
    case: crud([]),
    caseStatusHistory: crud([]),
    requiredDocument: crud([]),
    task: crud([]),
    checkIn: crud([]),
    photo: crud([]),
    lot: crud([]),
    caseLotAssignment: crud([]),
    inspectionChecklist: crud([]),
    conditionReport: crud([]),
    deliveryConfirmation: crud([]),
    invoice: crud([]),
    skipWorksheet: crud([]),
    skipPull: crud([]),
    clientContact: crud([]),
    emailTemplate: crud([]),
    emailDraft: crud([]),
    conversation: crud([]),
    conversationMember: crud([]),
    message: crud([]),
    directoryContact: crud([]),
    timeOffRequest: crud([]),
    plateList: crud(stores.plateLists),
    // Real Prisma fills addedAt via @default(now()); mirror that here.
    plateEntry: {
      ...crud(stores.plateEntries),
      createMany: async (args: unknown) => {
        const { data } = args as Row;
        const list = Array.isArray(data) ? data : [data];
        const base = crud(stores.plateEntries);
        let n = 0;
        for (const d of list) {
          await base.create({ data: { addedAt: new Date(), ...(d as Row) } });
          n++;
        }
        return { count: n };
      },
    },
    plateHit: crud(stores.plateHits),
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
  plateLists: [],
  plateEntries: [],
  plateHits: [],
};

let app: FastifyInstance;
let agentToken: string;
let managerToken: string;
let clerkToken: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  stores.roles.push(
    { id: 'role-agent', name: 'agent', canCaptureLotPhotos: true },
    { id: 'role-manager', name: 'manager', canCaptureLotPhotos: true },
    { id: 'role-clerk', name: 'office_clerk', canCaptureLotPhotos: true },
  );
  stores.users.push(
    { id: 'user-agent', name: 'Test Agent', email: 'agent@t.co', roleId: 'role-agent', status: 'active', phone: '555-0001' },
    { id: 'user-manager', name: 'Test Manager', email: 'manager@t.co', roleId: 'role-manager', status: 'active', phone: '555-0002' },
    { id: 'user-clerk', name: 'Test Clerk', email: 'clerk@t.co', roleId: 'role-clerk', status: 'active', phone: '555-0003' },
  );

  app = await buildApp({
    config: { JWT_SECRET: 'test-secret-at-least-32-chars-long!!', UPLOADS_DIR: '/tmp/test-uploads', MAX_UPLOAD_MB: 10 } as never,
    db: makeStub(stores),
  });

  const sign = (sub: string) => app.jwt.sign({ role: 'x' }, { sub } as never);
  agentToken = sign('user-agent');
  managerToken = sign('user-manager');
  clerkToken = sign('user-clerk');
});

const createList = (token: string, payload: unknown) =>
  app.inject({ method: 'POST', url: '/alpr/lists', headers: auth(token), payload });

// ---------------------------------------------------------------------------
// List CRUD + role guards
// ---------------------------------------------------------------------------

describe('plate lists', () => {
  it('manager can create a list; plates are normalized and audit-logged', async () => {
    const res = await createList(managerToken, {
      name: 'Star Leasing 10-14',
      client: 'Star Leasing',
      plates: [
        { plate: 'abc 123', state: 'tx', notes: 'red trailer' },
        { plate: 'XYZ-789', state: 'TX' },
      ],
    });
    expect(res.statusCode).toBe(201);
    const list = (res.json() as Row).list as Row;
    expect(list.name).toBe('Star Leasing 10-14');
    expect(list.client).toBe('Star Leasing');
    expect(list.plateCount).toBe(2);

    const stored = stores.plateEntries.filter((e) => e.listId === list.id).map((e) => e.plate);
    expect(stored).toContain('ABC123');
    expect(stored).toContain('XYZ789');

    const audits = stores.auditLogs.filter((a) => a.action === 'alpr.list_created');
    expect(audits.length).toBe(1);
    expect(audits[0].entityId).toBe(list.id);
  });

  it('office clerk can create a list; agent cannot (403)', async () => {
    const ok = await createList(clerkToken, { name: 'Clerk list', plates: [{ plate: 'AAA111' }] });
    expect(ok.statusCode).toBe(201);

    const denied = await createList(agentToken, { name: 'Agent list', plates: [{ plate: 'BBB222' }] });
    expect(denied.statusCode).toBe(403);
  });

  it('duplicate plates in one payload are deduped, empty-after-normalize rejected', async () => {
    const res = await createList(managerToken, {
      name: 'Dedupe list',
      plates: [{ plate: 'abc 123' }, { plate: 'ABC-123' }, { plate: 'ABC123' }],
    });
    expect(res.statusCode).toBe(201);
    expect(((res.json() as Row).list as Row).plateCount).toBe(1);

    const bad = await createList(managerToken, { name: 'Bad list', plates: [{ plate: ' - ' }] });
    expect(bad.statusCode).toBe(400);
  });

  it('any active user can read the lightweight inventory and full download', async () => {
    const inv = await app.inject({ method: 'GET', url: '/alpr/lists', headers: auth(agentToken) });
    expect(inv.statusCode).toBe(200);
    const lists = (inv.json() as Row).lists as Row[];
    expect(lists.length).toBeGreaterThan(0);
    const first = lists[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('plateCount');
    expect(first).toHaveProperty('updatedAt');
    expect(first).not.toHaveProperty('entries');

    const target = lists.find((l) => l.name === 'Star Leasing 10-14')!;
    const full = await app.inject({ method: 'GET', url: `/alpr/lists/${target.id}`, headers: auth(agentToken) });
    expect(full.statusCode).toBe(200);
    const entries = (full.json() as Row).entries as Row[];
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.plate).sort()).toEqual(['ABC123', 'XYZ789']);
  });

  it('GET /alpr/lists/:id 404s on unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/alpr/lists/nope', headers: auth(agentToken) });
    expect(res.statusCode).toBe(404);
  });

  it('manager can replace entries via PUT; agent cannot', async () => {
    const created = await createList(managerToken, { name: 'Replace me', plates: [{ plate: 'OLD111' }] });
    const id = ((created.json() as Row).list as Row).id as string;

    const denied = await app.inject({
      method: 'PUT',
      url: `/alpr/lists/${id}`,
      headers: auth(agentToken),
      payload: { plates: [{ plate: 'NEW111' }] },
    });
    expect(denied.statusCode).toBe(403);

    const updated = await app.inject({
      method: 'PUT',
      url: `/alpr/lists/${id}`,
      headers: auth(clerkToken),
      payload: { name: 'Replaced', plates: [{ plate: 'new 222' }, { plate: 'NEW333' }] },
    });
    expect(updated.statusCode).toBe(200);
    const list = (updated.json() as Row).list as Row;
    expect(list.name).toBe('Replaced');
    expect(list.plateCount).toBe(2);

    const full = await app.inject({ method: 'GET', url: `/alpr/lists/${id}`, headers: auth(managerToken) });
    const plates = ((full.json() as Row).entries as Row[]).map((e) => e.plate).sort();
    expect(plates).toEqual(['NEW222', 'NEW333']);
    expect(stores.auditLogs.some((a) => a.action === 'alpr.list_updated' && a.entityId === id)).toBe(true);
  });

  it('DELETE is manager-only and removes entries', async () => {
    const created = await createList(managerToken, { name: 'Delete me', plates: [{ plate: 'DEL111' }] });
    const id = ((created.json() as Row).list as Row).id as string;

    const denied = await app.inject({ method: 'DELETE', url: `/alpr/lists/${id}`, headers: auth(clerkToken) });
    expect(denied.statusCode).toBe(403);

    const res = await app.inject({ method: 'DELETE', url: `/alpr/lists/${id}`, headers: auth(managerToken) });
    expect(res.statusCode).toBe(200);
    expect(stores.plateLists.some((l) => l.id === id)).toBe(false);
    expect(stores.plateEntries.some((e) => e.listId === id)).toBe(false);
    expect(stores.auditLogs.some((a) => a.action === 'alpr.list_deleted' && a.entityId === id)).toBe(true);

    const gone = await app.inject({ method: 'GET', url: `/alpr/lists/${id}`, headers: auth(managerToken) });
    expect(gone.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Hits
// ---------------------------------------------------------------------------

describe('plate hits', () => {
  it('agent hit on a listed plate returns server-side matches and stores the hit', async () => {
    const created = await createList(managerToken, {
      name: 'Match list',
      plates: [{ plate: 'HIT 456', state: 'TX' }],
    });
    const listId = ((created.json() as Row).list as Row).id as string;

    const res = await app.inject({
      method: 'POST',
      url: '/alpr/hits',
      headers: auth(agentToken),
      payload: {
        plate: 'hit-456',
        state: 'tx',
        confidence: 0.93,
        latitude: 27.5,
        longitude: -99.5,
        scannedAt: new Date().toISOString(),
        deviceId: 'phone-1',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Row;
    const hit = body.hit as Row;
    expect(hit.plate).toBe('HIT456');
    expect(hit.state).toBe('TX');
    expect(hit.deviceId).toBe('phone-1');
    expect(hit.reportedById).toBe('user-agent');

    const matches = body.matches as Row[];
    expect(matches.length).toBe(1);
    expect(matches[0].listId).toBe(listId);
    expect(matches[0].listName).toBe('Match list');

    expect(stores.auditLogs.some((a) => a.action === 'alpr.hit_reported' && a.entityId === hit.id)).toBe(true);
  });

  it('hit on an unlisted plate is stored with empty matches', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/alpr/hits',
      headers: auth(agentToken),
      payload: { plate: 'ZZZ999', scannedAt: new Date().toISOString() },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Row;
    expect((body.matches as Row[]).length).toBe(0);
    expect((body.hit as Row).plate).toBe('ZZZ999');
  });

  it('a plate on two lists matches both', async () => {
    await createList(managerToken, { name: 'List A', plates: [{ plate: 'DUP 1' }] });
    await createList(managerToken, { name: 'List B', plates: [{ plate: 'dup-1' }] });

    const res = await app.inject({
      method: 'POST',
      url: '/alpr/hits',
      headers: auth(agentToken),
      payload: { plate: 'DUP1', scannedAt: new Date().toISOString() },
    });
    const matches = (res.json() as Row).matches as Row[];
    expect(matches.length).toBe(2);
  });

  it('rejects a plate that is empty after normalization', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/alpr/hits',
      headers: auth(agentToken),
      payload: { plate: '--', scannedAt: new Date().toISOString() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('manager can review hits newest-first with reporter names; agent cannot', async () => {
    const denied = await app.inject({ method: 'GET', url: '/alpr/hits', headers: auth(agentToken) });
    expect(denied.statusCode).toBe(403);

    const res = await app.inject({ method: 'GET', url: '/alpr/hits', headers: auth(managerToken) });
    expect(res.statusCode).toBe(200);
    const hits = (res.json() as Row).hits as Row[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toHaveProperty('reporterName', 'Test Agent');

    const filtered = await app.inject({
      method: 'GET',
      url: '/alpr/hits?plate=hit-456',
      headers: auth(managerToken),
    });
    const fhits = (filtered.json() as Row).hits as Row[];
    expect(fhits.length).toBeGreaterThan(0);
    expect(fhits.every((h) => h.plate === 'HIT456')).toBe(true);
  });

  it('since/until filters bound the result set', async () => {
    const old = await app.inject({
      method: 'POST',
      url: '/alpr/hits',
      headers: auth(agentToken),
      payload: { plate: 'OLD000', scannedAt: '2020-01-01T00:00:00.000Z' },
    });
    expect(old.statusCode).toBe(201);

    const res = await app.inject({
      method: 'GET',
      url: '/alpr/hits?since=2026-01-01T00:00:00.000Z',
      headers: auth(managerToken),
    });
    const hits = (res.json() as Row).hits as Row[];
    expect(hits.some((h) => h.plate === 'OLD000')).toBe(false);
  });
});
