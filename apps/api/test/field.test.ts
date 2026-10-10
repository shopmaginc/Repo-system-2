import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../src/lib/password.js';
import { haversineMeters } from '../src/routes/field.js';
import { buildApp } from '../src/app.js';
import type { DbClient } from '../src/db.js';

/**
 * Phase 2 field-workspace tests against an in-memory stub DB.
 * Proves: agents see only their own active assignments, case cards 404 for
 * unassigned cases, debtor PII stays hidden on the card, check-ins write
 * history + audit rows, possession advances status and creates the
 * transport-handoff task, and illegal possession moves are rejected.
 */

// ---------------------------------------------------------------------------
// Stub DB (mirrors cases.test.ts, extended with checkIns)
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
    checkIns: stores.checkIns.filter((x) => x.caseId === c.id),
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
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const stores: Stores = {
  users: [], roles: [], fieldPermissions: [], refreshTokens: [], auditLogs: [],
  clients: [], lenders: [], debtors: [], addresses: [], assets: [],
  cases: [], history: [], documents: [], tasks: [], checkIns: [],
};

let app: FastifyInstance;
let agent1Token: string;
let agent2Token: string;

const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  stores.roles.push(
    { id: 'role-agent', name: 'agent', canCaptureLotPhotos: true },
    { id: 'role-manager', name: 'manager', canCaptureLotPhotos: true },
  );
  // Agent: debtor name only. Manager: full PII.
  let i = 0;
  const fp = (roleId: string, field: string, access: string) => ({
    id: `fp-${i++}`, roleId, entity: 'debtor', field, access,
  });
  stores.fieldPermissions.push(fp('role-agent', 'name', 'read'));
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
    mkUser('u-agent2', 'agent2@repo-system.local', 'role-agent'),
    mkUser('u-manager', 'manager@repo-system.local', 'role-manager'),
  );

  // Shared fixtures: one client with rep contact, one lender, debtors/assets.
  stores.clients.push({
    id: 'client-1', name: 'Great Lakes Asset Recovery',
    contactName: 'Michael Laspada', contactPhone: '(555) 010-9000',
    contactEmail: 'm.laspada@example.com', contactCell: '(555) 010-9001',
  });
  stores.lenders.push({ id: 'lender-1', name: 'Demo National Bank' });
  stores.debtors.push(
    { id: 'debtor-1', name: 'Field Debtor One', ssn: '111-22-3333', personalPhone: '(555) 010-1111' },
    { id: 'debtor-2', name: 'Field Debtor Two', ssn: '444-55-6666', personalPhone: '(555) 010-2222' },
  );
  stores.assets.push(
    { id: 'asset-1', vin: '1XPBD49X2LD704829', year: 2020, make: 'Peterbilt', model: '579', color: 'Red', plate: 'TX12345' },
    { id: 'asset-2', vin: '3AKJHHDRXKSKG1716', year: 2019, make: 'Freightliner', model: 'Cascadia', color: 'White', plate: 'TX67890' },
  );

  // case-1: agent1, field_work, geocoded Laredo address.
  stores.cases.push({
    id: 'case-1', caseNumber: 'CS-FIELD001', status: 'field_work', priority: 'high',
    clientId: 'client-1', lenderId: 'lender-1', debtorId: 'debtor-1', assetId: 'asset-1',
    assignedAgentId: 'u-agent1',
  });
  stores.addresses.push({
    id: 'addr-1', caseId: 'case-1', label: 'given', street: '110 Coal Mines Rd',
    city: 'Laredo', state: 'TX', zip: '78045', lat: 27.5306, lng: -99.4861,
  });
  // case-2: agent1, closed — must NOT appear in assignments.
  stores.cases.push({
    id: 'case-2', caseNumber: 'CS-FIELD002', status: 'closed', priority: 'normal',
    clientId: 'client-1', lenderId: 'lender-1', debtorId: 'debtor-2', assetId: 'asset-2',
    assignedAgentId: 'u-agent1',
  });
  // case-3: agent2, assigned — agent1 must NOT see it.
  stores.cases.push({
    id: 'case-3', caseNumber: 'CS-FIELD003', status: 'assigned', priority: 'normal',
    clientId: 'client-1', lenderId: 'lender-1', debtorId: 'debtor-2', assetId: 'asset-2',
    assignedAgentId: 'u-agent2',
  });
  // case-4: agent1, verify, far-away address (Houston) — for nearest-first.
  stores.cases.push({
    id: 'case-4', caseNumber: 'CS-FIELD004', status: 'verify', priority: 'normal',
    clientId: 'client-1', lenderId: 'lender-1', debtorId: 'debtor-1', assetId: 'asset-1',
    assignedAgentId: 'u-agent1',
  });
  stores.addresses.push({
    id: 'addr-4', caseId: 'case-4', label: 'given', street: '900 Far Away Blvd',
    city: 'Houston', state: 'TX', zip: '77001', lat: 29.7604, lng: -95.3698,
  });
  // case-5: agent1, intake — possession from here must be rejected (422).
  stores.cases.push({
    id: 'case-5', caseNumber: 'CS-FIELD005', status: 'intake', priority: 'normal',
    clientId: 'client-1', lenderId: 'lender-1', debtorId: 'debtor-1', assetId: 'asset-1',
    assignedAgentId: 'u-agent1',
  });

  app = await buildApp({
    config: {
      DATABASE_URL: 'postgresql://stub/stub',
      JWT_SECRET: 'test-secret-that-is-long-enough-0123456789',
      JWT_ACCESS_TTL_SECONDS: 900,
      PORT: 3003,
      NODE_ENV: 'test',
    },
    db: makeStub(stores),
  });

  const sign = (sub: string, role: string) => app.jwt.sign({ role }, { sub });
  agent1Token = sign('u-agent1', 'agent');
  agent2Token = sign('u-agent2', 'agent');
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

// ---------------------------------------------------------------------------
// Haversine helper
// ---------------------------------------------------------------------------
describe('haversineMeters', () => {
  it('is ~0 for identical points and sane for Laredo->Houston', () => {
    expect(haversineMeters(27.5, -99.4, 27.5, -99.4)).toBeCloseTo(0, 6);
    const d = haversineMeters(27.5306, -99.4861, 29.7604, -95.3698);
    expect(d).toBeGreaterThan(400_000);
    expect(d).toBeLessThan(600_000);
  });
});

// ---------------------------------------------------------------------------
// GET /field/assignments
// ---------------------------------------------------------------------------
describe('GET /field/assignments', () => {
  it('shows the agent only their own active cases', async () => {
    const res = await app.inject({ method: 'GET', url: '/field/assignments', headers: auth(agent1Token) });
    expect(res.statusCode).toBe(200);
    const numbers = res.json().assignments.map((a: { caseNumber: string }) => a.caseNumber);
    expect(numbers).toContain('CS-FIELD001');
    expect(numbers).toContain('CS-FIELD004');
    expect(numbers).toContain('CS-FIELD005');
    expect(numbers).not.toContain('CS-FIELD002'); // closed
    expect(numbers).not.toContain('CS-FIELD003'); // agent2's
  });

  it('sorts nearest-first when ?lat=&lng= is given', async () => {
    const res = await app.inject({
      method: 'GET', url: '/field/assignments?lat=27.53&lng=-99.49', headers: auth(agent1Token),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().assignments as Array<{ caseNumber: string; distanceMeters: number | null }>;
    expect(rows[0].caseNumber).toBe('CS-FIELD001'); // Laredo pin, ~1km away
    expect(rows[0].distanceMeters).not.toBeNull();
    const houston = rows.find((r) => r.caseNumber === 'CS-FIELD004')!;
    expect(houston.distanceMeters).toBeGreaterThan(400_000);
    expect(rows.map((r) => r.caseNumber).indexOf('CS-FIELD001'))
      .toBeLessThan(rows.map((r) => r.caseNumber).indexOf('CS-FIELD004'));
  });

  it('hides debtor PII on the assignment rows', async () => {
    const res = await app.inject({ method: 'GET', url: '/field/assignments', headers: auth(agent1Token) });
    const row = res.json().assignments.find((a: { caseNumber: string }) => a.caseNumber === 'CS-FIELD001');
    expect(row.debtor.name).toBe('Field Debtor One');
    expect(row.debtor.ssn).toBeUndefined();
    expect(row.debtor.personalPhone).toBeUndefined();
    expect(row.asset.vin).toBe('1XPBD49X2LD704829');
  });
});

// ---------------------------------------------------------------------------
// GET /field/cases/:id/card
// ---------------------------------------------------------------------------
describe('GET /field/cases/:id/card', () => {
  it('returns the full card for an assigned case', async () => {
    const res = await app.inject({ method: 'GET', url: '/field/cases/case-1/card', headers: auth(agent1Token) });
    expect(res.statusCode).toBe(200);
    const card = res.json().card;
    expect(card.caseNumber).toBe('CS-FIELD001');
    expect(card.asset.vin).toBe('1XPBD49X2LD704829');
    expect(card.asset.plate).toBe('TX12345');
    expect(card.client.name).toBe('Great Lakes Asset Recovery');
    expect(card.client.contactPhone).toBe('(555) 010-9000');
    expect(card.client.contactCell).toBe('(555) 010-9001');
    expect(card.lender.name).toBe('Demo National Bank');
    expect(card.addresses).toHaveLength(1);
    expect(card.addresses[0].lat).toBe(27.5306);
    expect(card.debtor.name).toBe('Field Debtor One');
    expect(card.debtor.ssn).toBeUndefined(); // PII hidden
  });

  it('returns 404 — not 403 — for a case assigned to someone else', async () => {
    const res = await app.inject({ method: 'GET', url: '/field/cases/case-3/card', headers: auth(agent1Token) });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a missing case', async () => {
    const res = await app.inject({ method: 'GET', url: '/field/cases/nope/card', headers: auth(agent1Token) });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /field/cases/:id/check-in
// ---------------------------------------------------------------------------
describe('POST /field/cases/:id/check-in', () => {
  it('writes a check-in, a timeline entry, and an audit row', async () => {
    const beforeHistory = stores.history.length;
    const beforeAudit = stores.auditLogs.length;
    const res = await app.inject({
      method: 'POST', url: '/field/cases/case-1/check-in', headers: auth(agent1Token),
      payload: { lat: 27.531, lng: -99.487, note: 'Drive-by, no unit visible' },
    });
    expect(res.statusCode).toBe(201);
    expect(stores.checkIns).toHaveLength(1);
    expect(stores.checkIns[0].caseId).toBe('case-1');
    expect(stores.checkIns[0].userId).toBe('u-agent1');
    expect(stores.history.length).toBe(beforeHistory + 1);
    expect(stores.history[stores.history.length - 1].note).toContain('Check-in');
    const audit = stores.auditLogs.slice(beforeAudit);
    expect(audit.some((a) => a.action === 'field.check_in' && a.result === 'success')).toBe(true);
  });

  it('rejects out-of-range coordinates', async () => {
    const res = await app.inject({
      method: 'POST', url: '/field/cases/case-1/check-in', headers: auth(agent1Token),
      payload: { lat: 95, lng: -99.4 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s for a case the agent is not assigned to', async () => {
    const res = await app.inject({
      method: 'POST', url: '/field/cases/case-3/check-in', headers: auth(agent1Token),
      payload: { lat: 27.5, lng: -99.4 },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /field/cases/:id/notes
// ---------------------------------------------------------------------------
describe('POST /field/cases/:id/notes', () => {
  it('appends a field note to the timeline', async () => {
    const before = stores.history.length;
    const res = await app.inject({
      method: 'POST', url: '/field/cases/case-1/notes', headers: auth(agent1Token),
      payload: { text: 'Neighbor says truck moved last Tuesday' },
    });
    expect(res.statusCode).toBe(201);
    expect(stores.history.length).toBe(before + 1);
    expect(stores.history[stores.history.length - 1].note).toContain('Neighbor says truck');
  });
});

// ---------------------------------------------------------------------------
// POST /field/cases/:id/possession
// ---------------------------------------------------------------------------
describe('POST /field/cases/:id/possession', () => {
  it('advances verify -> possession and creates the transport-handoff task', async () => {
    const beforeTasks = stores.tasks.length;
    const beforeCheckIns = stores.checkIns.length;
    const res = await app.inject({
      method: 'POST', url: '/field/cases/case-4/possession', headers: auth(agent1Token),
      payload: { lat: 29.761, lng: -95.37 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().case.status).toBe('possession');
    expect(stores.tasks.length).toBe(beforeTasks + 1);
    const task = stores.tasks[stores.tasks.length - 1];
    expect(task.caseId).toBe('case-4');
    expect(task.title).toContain('CS-FIELD004');
    expect(task.title).toContain('Transport handoff');
    expect(stores.checkIns.length).toBe(beforeCheckIns + 1);
    expect(res.json().handoffTask.id).toBe(task.id);
  });

  it('rejects an illegal possession move (intake -> possession)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/field/cases/case-5/possession', headers: auth(agent1Token),
      payload: { lat: 27.5, lng: -99.4 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('404s for a case assigned to someone else', async () => {
    const res = await app.inject({
      method: 'POST', url: '/field/cases/case-3/possession', headers: auth(agent1Token),
      payload: { lat: 27.5, lng: -99.4 },
    });
    expect(res.statusCode).toBe(404);
  });
});
