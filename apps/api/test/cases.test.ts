import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../src/lib/password.js';
import { canTransition } from '../src/lib/case-status.js';
import { extractVinCandidates, isCheckDigitValid } from '../src/lib/vin.js';
import { buildApp } from '../src/app.js';
import type { DbClient } from '../src/db.js';

/**
 * Phase 1 case-operations tests against an in-memory stub DB.
 * Proves: the state machine rejects illegal jumps, cancellation is
 * manager-only, the invoice gate blocks until documents complete, VIN
 * verification catches mismatches, agents only see their own cases, and
 * clerks cannot approve documents.
 */

// ---------------------------------------------------------------------------
// Stub DB
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
}

function makeStub(stores: Stores): DbClient {
  let seq = 5000;
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
      const role = stores.roles.find((r) => r.id === u.roleId);
      return { id: u.id, name: u.name, email: u.email, role: role ? { name: role.name } : null };
    })(),
    addresses: stores.addresses.filter((a) => a.caseId === c.id),
    documents: stores.documents.filter((d) => d.caseId === c.id),
  });

  const caseModel = {
    ...crud(stores.cases),
    findUnique: async (args: unknown) => {
      const { where } = args as Row;
      const row = stores.cases.find((r) => matchesWhere(r, where as Row));
      return row ? withCaseRelations(row) : null;
    },
    findMany: async (args: unknown) => {
      const { where, orderBy } = (args as Row) ?? {};
      let out = stores.cases.filter((r) => matchesWhere(r, where as Row | undefined));
      if (orderBy) {
        const [key, dir] = Object.entries(orderBy as Row)[0] as [string, string];
        out = [...out].sort((a, b) =>
          String(a[key]) < String(b[key]) ? (dir === 'desc' ? 1 : -1) : dir === 'desc' ? -1 : 1,
        );
      }
      return out.map(withCaseRelations);
    },
  };

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
        const { where } = (args as Row) ?? {};
        return stores.users
          .filter((r) => matchesWhere(r, where as Row | undefined))
          .map(userWithRole);
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
    case: caseModel as unknown as DbClient['case'],
    caseStatusHistory: crud(stores.history),
    requiredDocument: crud(stores.documents),
    task: crud(stores.tasks),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const stores: Stores = {
  users: [], roles: [], fieldPermissions: [], refreshTokens: [], auditLogs: [],
  clients: [], lenders: [], debtors: [], addresses: [], assets: [],
  cases: [], history: [], documents: [], tasks: [],
};

let app: FastifyInstance;
let managerToken: string;
let clerkToken: string;
let agent1Token: string;
let agent2Token: string;

const PASSWORD = 'correct-horse-battery';
const TEST_VIN = '1XPBD49X2LD704829'; // check-digit valid

beforeAll(async () => {
  stores.roles.push(
    { id: 'role-manager', name: 'manager', canCaptureLotPhotos: true },
    { id: 'role-clerk', name: 'office_clerk', canCaptureLotPhotos: true },
    { id: 'role-agent', name: 'agent', canCaptureLotPhotos: true },
  );
  // Manager: full debtor PII. Agent: name only. Clerk: name + write.
  const fp = (roleId: string, field: string, access: string, i: number) => ({
    id: `fp-${i}`, roleId, entity: 'debtor', field, access,
  });
  let i = 0;
  for (const f of ['name', 'ssn', 'dob', 'homeAddress', 'personalPhone', 'email', 'skipResults']) {
    stores.fieldPermissions.push(fp('role-manager', f, 'read', i++));
  }
  stores.fieldPermissions.push(fp('role-agent', 'name', 'read', i++));
  stores.fieldPermissions.push(fp('role-clerk', 'name', 'write', i++));

  const passwordHash = await hashPassword(PASSWORD);
  const mkUser = (id: string, email: string, roleId: string): Row => ({
    id, name: email, email, phone: null, passwordHash, roleId,
    status: 'active', photoUrl: null, createdAt: new Date(), updatedAt: new Date(),
  });
  stores.users.push(
    mkUser('u-manager', 'manager@repo-system.local', 'role-manager'),
    mkUser('u-clerk', 'clerk@repo-system.local', 'role-clerk'),
    mkUser('u-agent1', 'agent1@repo-system.local', 'role-agent'),
    mkUser('u-agent2', 'agent2@repo-system.local', 'role-agent'),
  );

  app = await buildApp({
    config: {
      DATABASE_URL: 'postgresql://stub/stub',
      JWT_SECRET: 'test-secret-that-is-long-enough-0123456789',
      JWT_ACCESS_TTL_SECONDS: 900,
      PORT: 3002,
      NODE_ENV: 'test',
    },
    db: makeStub(stores),
  });

  const sign = (sub: string, role: string) => app.jwt.sign({ role }, { sub });
  managerToken = sign('u-manager', 'manager');
  clerkToken = sign('u-clerk', 'office_clerk');
  agent1Token = sign('u-agent1', 'agent');
  agent2Token = sign('u-agent2', 'agent');
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const INTAKE_PAYLOAD = (over: Record<string, unknown> = {}) => ({
  source: 'email',
  priority: 'normal',
  debtor: { name: 'Test Debtor', ssn: '123-45-6789', personalPhone: '(555) 000-1111' },
  client: { name: 'Test Client Inc', contactPhone: '(555) 000-2222' },
  lender: { name: 'Test Bank' },
  asset: { vin: TEST_VIN, year: 2020, make: 'TestMake', model: 'TestModel' },
  addresses: [{ label: 'given', street: '1 Test St', city: 'Testville', state: 'TX', zip: '78000' }],
  ...over,
});

async function intakeCase(token: string, over: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST', url: '/cases/intake', headers: auth(token),
    payload: INTAKE_PAYLOAD(over),
  });
  expect(res.statusCode).toBe(201);
  return res.json().case as { id: string; status: string };
}

// ---------------------------------------------------------------------------
// State machine (pure unit tests)
// ---------------------------------------------------------------------------
describe('case lifecycle state machine', () => {
  it('allows the happy-path forward moves', () => {
    expect(canTransition('intake', 'assigned', false)).toBe(true);
    expect(canTransition('verify', 'possession', false)).toBe(true);
    expect(canTransition('invoicing', 'closed', false)).toBe(true);
  });

  it('rejects illegal jumps for non-managers', () => {
    expect(canTransition('intake', 'possession', false)).toBe(false);
    expect(canTransition('intake', 'closed', false)).toBe(false);
    expect(canTransition('field_work', 'delivery', false)).toBe(false);
  });

  it('allows explicit hold/send-back moves in the map', () => {
    expect(canTransition('verify', 'field_work', false)).toBe(true);
    expect(canTransition('assigned', 'intake', false)).toBe(true);
  });

  it('requires a manager to cancel, and cancelling is terminal', () => {
    expect(canTransition('field_work', 'cancelled', false)).toBe(false);
    expect(canTransition('field_work', 'cancelled', true)).toBe(true);
    expect(canTransition('cancelled', 'intake', true)).toBe(false);
    expect(canTransition('closed', 'intake', true)).toBe(false);
  });

  it('lets managers override to any non-terminal status', () => {
    expect(canTransition('assigned', 'delivery', true)).toBe(true);
    expect(canTransition('intake', 'lot_storage', true)).toBe(true);
  });

  it('rejects unknown statuses and no-op moves', () => {
    expect(canTransition('intake', 'intake', false)).toBe(false);
    expect(canTransition('intake', 'nope' as never, true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VIN helpers (pure unit tests)
// ---------------------------------------------------------------------------
describe('VIN extraction and check digits', () => {
  it('extracts VIN candidates from order text', () => {
    const cands = extractVinCandidates(
      `Order 384732\nVIN: ${TEST_VIN}\nTrailer: 1UYVS2530L3870964`,
    );
    expect(cands.map((c) => c.vin)).toContain(TEST_VIN);
    expect(cands.map((c) => c.vin)).toContain('1UYVS2530L3870964');
  });

  it('flags check-digit validity', () => {
    expect(isCheckDigitValid(TEST_VIN)).toBe(true);
    expect(isCheckDigitValid('1XPBD49X2LD704820')).toBe(false); // tampered
    expect(isCheckDigitValid('TOOSHORT')).toBe(false);
  });

  it('returns no candidates for text without VINs', () => {
    expect(extractVinCandidates('no vins here, just words')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Intake API
// ---------------------------------------------------------------------------
describe('POST /cases/intake', () => {
  it('lets a clerk create a case with documents and history', async () => {
    const c = await intakeCase(clerkToken);
    expect(c.status).toBe('intake');

    const detail = await app.inject({ method: 'GET', url: `/cases/${c.id}`, headers: auth(clerkToken) });
    expect(detail.statusCode).toBe(200);
    const body = detail.json().case;
    expect(body.documents).toHaveLength(5);
    expect(body.documents.every((d: { status: string }) => d.status === 'pending')).toBe(true);
    expect(body.addresses).toHaveLength(1);
    expect(body.asset.vin).toBe(TEST_VIN);
  });

  it('rejects intake from an agent (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/cases/intake', headers: auth(agent1Token),
      payload: INTAKE_PAYLOAD(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a malformed VIN', async () => {
    const res = await app.inject({
      method: 'POST', url: '/cases/intake', headers: auth(clerkToken),
      payload: INTAKE_PAYLOAD({ asset: { vin: 'SHORT' } }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('reuses an existing asset when the VIN already exists', async () => {
    const a = await intakeCase(clerkToken);
    const b = await intakeCase(clerkToken);
    const da = await app.inject({ method: 'GET', url: `/cases/${a.id}`, headers: auth(managerToken) });
    const db = await app.inject({ method: 'GET', url: `/cases/${b.id}`, headers: auth(managerToken) });
    expect(da.json().case.asset.id).toBe(db.json().case.asset.id);
  });
});

describe('POST /cases/extract-vins', () => {
  it('returns candidates for confirmation without creating anything', async () => {
    const before = stores.assets.length;
    const res = await app.inject({
      method: 'POST', url: '/cases/extract-vins', headers: auth(clerkToken),
      payload: { text: `recovery order\nvin ${TEST_VIN}\nplate ABC123` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().candidates[0]).toMatchObject({ vin: TEST_VIN, checkDigitValid: true });
    expect(stores.assets.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Assignment + role-scoped listing
// ---------------------------------------------------------------------------
describe('assignment and listing scope', () => {
  it('assigns a case to an agent and moves intake -> assigned', async () => {
    const c = await intakeCase(clerkToken);
    const res = await app.inject({
      method: 'POST', url: `/cases/${c.id}/assign`, headers: auth(clerkToken),
      payload: { agentId: 'u-agent1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().case.status).toBe('assigned');
    expect(res.json().case.assignedAgentId).toBe('u-agent1');
  });

  it('refuses to assign to a non-agent user', async () => {
    const c = await intakeCase(clerkToken);
    const res = await app.inject({
      method: 'POST', url: `/cases/${c.id}/assign`, headers: auth(managerToken),
      payload: { agentId: 'u-clerk' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('shows an agent only their assigned cases', async () => {
    const a = await intakeCase(clerkToken);
    const b = await intakeCase(clerkToken);
    await app.inject({ method: 'POST', url: `/cases/${a.id}/assign`, headers: auth(clerkToken), payload: { agentId: 'u-agent1' } });
    await app.inject({ method: 'POST', url: `/cases/${b.id}/assign`, headers: auth(clerkToken), payload: { agentId: 'u-agent2' } });

    const list = await app.inject({ method: 'GET', url: '/cases', headers: auth(agent1Token) });
    expect(list.statusCode).toBe(200);
    const cases = list.json().cases as Array<{ assignedAgentId: string }>;
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((x) => x.assignedAgentId === 'u-agent1')).toBe(true);
  });

  it('hides a case from an agent it is not assigned to (404, not 403)', async () => {
    const c = await intakeCase(clerkToken);
    await app.inject({ method: 'POST', url: `/cases/${c.id}/assign`, headers: auth(clerkToken), payload: { agentId: 'u-agent2' } });
    const res = await app.inject({ method: 'GET', url: `/cases/${c.id}`, headers: auth(agent1Token) });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Status transitions through the API
// ---------------------------------------------------------------------------
describe('POST /cases/:id/status', () => {
  it('rejects an illegal jump for an agent (422)', async () => {
    const c = await intakeCase(clerkToken);
    await app.inject({ method: 'POST', url: `/cases/${c.id}/assign`, headers: auth(clerkToken), payload: { agentId: 'u-agent1' } });
    const res = await app.inject({
      method: 'POST', url: `/cases/${c.id}/status`, headers: auth(agent1Token),
      payload: { to: 'possession' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('advances along the mapped path and records history', async () => {
    const c = await intakeCase(clerkToken);
    await app.inject({ method: 'POST', url: `/cases/${c.id}/assign`, headers: auth(clerkToken), payload: { agentId: 'u-agent1' } });
    const res = await app.inject({
      method: 'POST', url: `/cases/${c.id}/status`, headers: auth(agent1Token),
      payload: { to: 'field_work', note: 'On site' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().case.status).toBe('field_work');
    const hist = stores.history.filter((h) => h.caseId === c.id);
    expect(hist.some((h) => h.from === 'assigned' && h.to === 'field_work')).toBe(true);
  });

  it('requires a manager to cancel (agent gets 403, manager succeeds)', async () => {
    const c = await intakeCase(clerkToken);
    await app.inject({ method: 'POST', url: `/cases/${c.id}/assign`, headers: auth(clerkToken), payload: { agentId: 'u-agent1' } });

    const denied = await app.inject({
      method: 'POST', url: `/cases/${c.id}/status`, headers: auth(agent1Token),
      payload: { to: 'cancelled' },
    });
    expect(denied.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'POST', url: `/cases/${c.id}/status`, headers: auth(managerToken),
      payload: { to: 'cancelled', note: 'Client recalled' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().case.status).toBe('cancelled');
  });

  it('lets a manager override to a non-mapped status', async () => {
    const c = await intakeCase(clerkToken);
    const res = await app.inject({
      method: 'POST', url: `/cases/${c.id}/status`, headers: auth(managerToken),
      payload: { to: 'delivery' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().case.status).toBe('delivery');
  });
});

// ---------------------------------------------------------------------------
// Solo-agent double-check: VIN verification
// ---------------------------------------------------------------------------
describe('POST /cases/:id/verify-vin', () => {
  it('matches when both scans agree with each other and the asset VIN', async () => {
    const c = await intakeCase(clerkToken);
    await app.inject({ method: 'POST', url: `/cases/${c.id}/assign`, headers: auth(clerkToken), payload: { agentId: 'u-agent1' } });
    const res = await app.inject({
      method: 'POST', url: `/cases/${c.id}/verify-vin`, headers: auth(agent1Token),
      payload: { scanA: '1xpbd49x2ld704829', scanB: '1XPBD49X2LD704829' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verification).toMatchObject({
      match: true, aMatchesAsset: true, bMatchesAsset: true, aMatchesB: true,
    });
  });

  it('detects a mismatch between the two scans', async () => {
    const c = await intakeCase(clerkToken);
    await app.inject({ method: 'POST', url: `/cases/${c.id}/assign`, headers: auth(clerkToken), payload: { agentId: 'u-agent1' } });
    const res = await app.inject({
      method: 'POST', url: `/cases/${c.id}/verify-vin`, headers: auth(agent1Token),
      payload: { scanA: TEST_VIN, scanB: '1XPBD49X2LD704820' },
    });
    expect(res.statusCode).toBe(200);
    const v = res.json().verification;
    expect(v.match).toBe(false);
    expect(v.aMatchesB).toBe(false);
    expect(v.bMatchesAsset).toBe(false);
  });

  it('writes the verification to the case timeline and audit log', async () => {
    const c = await intakeCase(clerkToken);
    await app.inject({ method: 'POST', url: `/cases/${c.id}/assign`, headers: auth(clerkToken), payload: { agentId: 'u-agent1' } });
    const beforeHistory = stores.history.length;
    const beforeAudit = stores.auditLogs.length;
    await app.inject({
      method: 'POST', url: `/cases/${c.id}/verify-vin`, headers: auth(agent1Token),
      payload: { scanA: TEST_VIN, scanB: TEST_VIN },
    });
    expect(stores.history.length).toBe(beforeHistory + 1);
    const audits = stores.auditLogs.slice(beforeAudit);
    expect(audits.some((a) => a.action === 'case.vin_verified')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invoice gate + document approval
// ---------------------------------------------------------------------------
describe('invoice gate', () => {
  async function readyCase(): Promise<string> {
    const c = await intakeCase(clerkToken);
    await app.inject({ method: 'POST', url: `/cases/${c.id}/assign`, headers: auth(clerkToken), payload: { agentId: 'u-agent1' } });
    return c.id;
  }

  async function approve(token: string, id: string, kind: string) {
    return app.inject({ method: 'POST', url: `/cases/${id}/documents/${kind}/approve`, headers: auth(token) });
  }

  it('blocks the invoice until photos, delivery sheet, and condition report are approved', async () => {
    const id = await readyCase();

    const blocked = await approve(managerToken, id, 'invoice');
    expect(blocked.statusCode).toBe(409);

    const elig = await app.inject({ method: 'GET', url: `/cases/${id}/billing-eligibility`, headers: auth(managerToken) });
    expect(elig.json().unlocked).toBe(false);
    expect(elig.json().missing).toHaveLength(3);

    for (const kind of ['post_recovery_photos', 'delivery_sheet', 'condition_report']) {
      const r = await approve(managerToken, id, kind);
      expect(r.statusCode).toBe(200);
    }
    const elig2 = await app.inject({ method: 'GET', url: `/cases/${id}/billing-eligibility`, headers: auth(managerToken) });
    expect(elig2.json().unlocked).toBe(true);

    const ok = await approve(managerToken, id, 'invoice');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().document.status).toBe('approved');
  });

  it('forbids a clerk from approving documents (manager-only)', async () => {
    const id = await readyCase();
    const res = await approve(clerkToken, id, 'post_recovery_photos');
    expect(res.statusCode).toBe(403);
  });

  it('lets staff submit documents for review', async () => {
    const id = await readyCase();
    const res = await app.inject({
      method: 'POST', url: `/cases/${id}/documents/post_recovery_photos/submit`, headers: auth(agent1Token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().document.status).toBe('submitted');
  });
});

// ---------------------------------------------------------------------------
// Debtor PII filtering through the permission matrix
// ---------------------------------------------------------------------------
describe('debtor PII filtering', () => {
  it('hides SSN from agents but shows it to managers', async () => {
    const c = await intakeCase(clerkToken);
    await app.inject({ method: 'POST', url: `/cases/${c.id}/assign`, headers: auth(clerkToken), payload: { agentId: 'u-agent1' } });

    const asAgent = await app.inject({ method: 'GET', url: `/cases/${c.id}`, headers: auth(agent1Token) });
    expect(asAgent.json().case.debtor.name).toBe('Test Debtor');
    expect(asAgent.json().case.debtor.ssn).toBeUndefined();

    const asManager = await app.inject({ method: 'GET', url: `/cases/${c.id}`, headers: auth(managerToken) });
    expect(asManager.json().case.debtor.ssn).toBe('123-45-6789');
  });
});

// ---------------------------------------------------------------------------
// Tasks (minimal)
// ---------------------------------------------------------------------------
describe('case tasks', () => {
  it('creates, lists, and completes a task', async () => {
    const c = await intakeCase(clerkToken);
    await app.inject({ method: 'POST', url: `/cases/${c.id}/assign`, headers: auth(clerkToken), payload: { agentId: 'u-agent1' } });
    const created = await app.inject({
      method: 'POST', url: `/cases/${c.id}/tasks`, headers: auth(clerkToken),
      payload: { title: 'Call the reference', assigneeId: 'u-agent1' },
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().task.id as string;

    const done = await app.inject({
      method: 'PATCH', url: `/cases/${c.id}/tasks/${taskId}`, headers: auth(agent1Token),
      payload: { done: true },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().task.done).toBe(true);
  });
});
