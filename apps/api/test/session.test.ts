import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../src/lib/password.js';
import { generateRefreshToken, refreshTokenExpiry } from '../src/lib/tokens.js';
import { requireFieldAccess } from '../src/middleware/guards.js';
import { buildApp } from '../src/app.js';
import type { DbClient } from '../src/db.js';

/**
 * Auth + session-invalidation tests against an in-memory stub DB.
 * Proves: suspend/revoke kills sessions immediately (access token rejected
 * on the next request, refresh chain revoked), role guards hold, field
 * guards deny + audit, and refresh rotation is single-use.
 */

// ---------------------------------------------------------------------------
// Minimal in-memory stub implementing the DbClient surface used by the app.
// ---------------------------------------------------------------------------
interface Row {
  [k: string]: unknown;
}

function matchesWhere(row: Row, where: Row): boolean {
  return Object.entries(where ?? {}).every(([k, v]) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // Composite unique inputs, e.g. { roleId_entity_field: {...} }
      return matchesWhere(row, v as Row);
    }
    return row[k] === v;
  });
}

function applySelect(row: Row, select: Row | undefined, store: StubStore): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, sel] of Object.entries(select)) {
    if (key === 'role' && sel && typeof sel === 'object') {
      const role = store.roles.find((r) => r.id === row.roleId);
      out.role = role ? applySelect(role, (sel as Row).select as Row, store) : null;
    } else if (sel) {
      out[key] = row[key];
    }
  }
  return out;
}

interface StubStore {
  users: Row[];
  roles: Row[];
  fieldPermissions: Row[];
  refreshTokens: Row[];
  auditLogs: Row[];
}

function makeStub(store: StubStore): DbClient {
  let seq = 1000;
  const nid = () => `stub-${seq++}`;
  return {
    user: {
      findUnique: async (args: unknown) => {
        const { where, include, select } = args as Row;
        const row = store.users.find((u) => matchesWhere(u, where as Row)) ?? null;
        if (!row) return null;
        const withRole = include
          ? { ...row, role: store.roles.find((r) => r.id === row.roleId) ?? null }
          : { ...row };
        return select ? applySelect(withRole, select as Row, store) : withRole;
      },
      findMany: async (args: unknown) => {
        const { select, orderBy } = (args as Row) ?? {};
        let rows = store.users.map((u) => ({
          ...u,
          role: store.roles.find((r) => r.id === u.roleId) ?? null,
        }));
        if (orderBy) {
          const [key] = Object.keys(orderBy as Row);
          rows = [...rows].sort((a, b) => String(a[key]) < String(b[key]) ? -1 : 1);
        }
        return select ? rows.map((r) => applySelect(r, select as Row, store)) : rows;
      },
      create: async (args: unknown) => {
        const { data, select } = args as Row;
        const row: Row = { id: nid(), createdAt: new Date(), updatedAt: new Date(), ...(data as Row) };
        store.users.push(row);
        const withRole = { ...row, role: store.roles.find((r) => r.id === row.roleId) ?? null };
        return select ? applySelect(withRole, select as Row, store) : withRole;
      },
      update: async (args: unknown) => {
        const { where, data, select } = args as Row;
        const row = store.users.find((u) => matchesWhere(u, where as Row));
        if (!row) throw new Error('not found');
        Object.assign(row, data, { updatedAt: new Date() });
        const withRole = { ...row, role: store.roles.find((r) => r.id === row.roleId) ?? null };
        return select ? applySelect(withRole, select as Row, store) : withRole;
      },
    },
    role: {
      findUnique: async (args: unknown) => {
        const { where } = args as Row;
        return store.roles.find((r) => matchesWhere(r, where as Row)) ?? null;
      },
      findMany: async (args: unknown) => {
        const { include } = (args as Row) ?? {};
        return store.roles.map((r) => ({
          ...r,
          ...(include && (include as Row).fieldPermissions
            ? { fieldPermissions: store.fieldPermissions.filter((p) => p.roleId === r.id) }
            : {}),
        }));
      },
    },
    fieldPermission: {
      findMany: async (args: unknown) => {
        const { where } = (args as Row) ?? {};
        if (!where) return [...store.fieldPermissions];
        return store.fieldPermissions.filter((p) => matchesWhere(p, where as Row));
      },
      upsert: async (args: unknown) => {
        const { where, create, update } = args as Row;
        const found = store.fieldPermissions.find((p) => matchesWhere(p, where as Row));
        if (found) {
          Object.assign(found, update, { updatedAt: new Date() });
          return found;
        }
        const row: Row = { id: nid(), createdAt: new Date(), updatedAt: new Date(), ...(create as Row) };
        store.fieldPermissions.push(row);
        return row;
      },
    },
    refreshToken: {
      findUnique: async (args: unknown) => {
        const { where } = args as Row;
        return store.refreshTokens.find((t) => matchesWhere(t, where as Row)) ?? null;
      },
      create: async (args: unknown) => {
        const { data } = args as Row;
        const row: Row = { id: nid(), createdAt: new Date(), revokedAt: null, ...(data as Row) };
        store.refreshTokens.push(row);
        return row;
      },
      update: async (args: unknown) => {
        const { where, data } = args as Row;
        const row = store.refreshTokens.find((t) => matchesWhere(t, where as Row));
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
      updateMany: async (args: unknown) => {
        const { where, data } = args as Row;
        let count = 0;
        for (const t of store.refreshTokens) {
          const w = where as Row;
          const userMatch = w.userId === undefined || t.userId === w.userId;
          const revokedMatch = w.revokedAt === undefined || t.revokedAt === w.revokedAt;
          if (userMatch && revokedMatch) {
            Object.assign(t, data as Row);
            count++;
          }
        }
        return { count };
      },
    },
    auditLog: {
      create: async (args: unknown) => {
        const { data } = args as Row;
        const row: Row = { id: nid(), createdAt: new Date(), ...(data as Row) };
        store.auditLogs.push(row);
        return row;
      },
    },
    // Phase 1 models: generic in-memory stubs (unused by Phase 0 tests,
    // present so the extended DbClient interface stays satisfied).
    ...phase1Stubs(() => nid()),
  };
}

/** Generic stubs for Phase 1 models, sharing the matchesWhere helper. */
function phase1Stubs(nid: () => string) {
  const tables: Record<string, Row[]> = {
    clients: [], lenders: [], debtors: [], addresses: [], assets: [],
    cases: [], caseStatusHistory: [], requiredDocuments: [], tasks: [],
  };
  const model = (key: keyof typeof tables) => {
    const rows = tables[key];
    const matches = (where: Row | undefined) =>
      rows.filter((r) => matchesWhere(r, where ?? {}));
    return {
      findUnique: async (args: unknown) => {
        const { where } = args as Row;
        return matches(where as Row)[0] ?? null;
      },
      findFirst: async (args: unknown) => {
        const { where } = args as Row;
        return matches(where as Row)[0] ?? null;
      },
      findMany: async (args: unknown) => {
        const { where } = (args as Row) ?? {};
        return matches(where as Row);
      },
      create: async (args: unknown) => {
        const { data } = args as Row;
        const row: Row = { id: nid(), createdAt: new Date(), updatedAt: new Date(), ...(data as Row) };
        rows.push(row);
        return row;
      },
      update: async (args: unknown) => {
        const { where, data } = args as Row;
        const row = matches(where as Row)[0];
        if (!row) throw new Error('not found');
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      updateMany: async () => ({ count: 0 }),
    };
  };
  return {
    client: model('clients'),
    lender: model('lenders'),
    debtor: model('debtors'),
    address: model('addresses'),
    asset: model('assets'),
    case: model('cases'),
    caseStatusHistory: model('caseStatusHistory'),
    requiredDocument: model('requiredDocuments'),
    task: model('tasks'),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const store: StubStore = { users: [], roles: [], fieldPermissions: [], refreshTokens: [], auditLogs: [] };

let app: FastifyInstance;
let managerToken: string;
let agentToken: string;
let suspendedToken: string;
let revokedToken: string;

const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  store.roles.push(
    { id: 'role-manager', name: 'manager', description: 'managers', canCaptureLotPhotos: true },
    { id: 'role-agent', name: 'agent', description: 'agents', canCaptureLotPhotos: true },
  );
  // Manager: write on debtor.ssn. Agent: read on debtor.name only.
  store.fieldPermissions.push(
    { id: 'fp-1', roleId: 'role-manager', entity: 'debtor', field: 'ssn', access: 'write' },
    { id: 'fp-2', roleId: 'role-manager', entity: 'debtor', field: 'name', access: 'write' },
    { id: 'fp-3', roleId: 'role-agent', entity: 'debtor', field: 'name', access: 'read' },
  );

  const passwordHash = await hashPassword(PASSWORD);
  const mkUser = (id: string, email: string, roleId: string, status: string): Row => ({
    id, name: email, email, phone: null, passwordHash, roleId, status,
    photoUrl: null, createdAt: new Date(), updatedAt: new Date(),
  });
  store.users.push(
    mkUser('u-manager', 'manager@repo-system.local', 'role-manager', 'active'),
    mkUser('u-agent', 'agent@repo-system.local', 'role-agent', 'active'),
    mkUser('u-suspended', 'suspended@repo-system.local', 'role-agent', 'suspended'),
    mkUser('u-revoked', 'revoked@repo-system.local', 'role-agent', 'revoked'),
  );

  app = await buildApp({
    config: {
      DATABASE_URL: 'postgresql://stub/stub',
      JWT_SECRET: 'test-secret-that-is-long-enough-0123456789',
      JWT_ACCESS_TTL_SECONDS: 900,
      PORT: 3001,
      NODE_ENV: 'test',
    },
    db: makeStub(store),
  });

  // A route exercising the field-level guard, for denial tests.
  app.get(
    '/test/debtor-ssn',
    { preHandler: requireFieldAccess('debtor', 'ssn', 'read') },
    async () => ({ ssn: 'REDACTED-FOR-TEST' }),
  );

  const sign = (sub: string, role: string) => app.jwt.sign({ role }, { sub });
  managerToken = sign('u-manager', 'manager');
  agentToken = sign('u-agent', 'agent');
  suspendedToken = sign('u-suspended', 'agent');
  revokedToken = sign('u-revoked', 'agent');
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('session invalidation on suspend/revoke', () => {
  it('rejects an access token for a suspended user (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/users', headers: auth(suspendedToken) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('rejects an access token for a revoked user (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/users', headers: auth(revokedToken) });
    expect(res.statusCode).toBe(401);
  });

  it('refuses login for suspended accounts without revealing the reason', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'suspended@repo-system.local', password: PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Invalid email or password');
  });

  it('refuses refresh for a suspended user and revokes the presented token', async () => {
    const { token, tokenHash } = generateRefreshToken();
    store.refreshTokens.push({
      id: 'rt-suspended', tokenHash, userId: 'u-suspended',
      expiresAt: refreshTokenExpiry(), revokedAt: null, createdAt: new Date(),
    });
    const res = await app.inject({
      method: 'POST', url: '/auth/refresh', payload: { refreshToken: token },
    });
    expect(res.statusCode).toBe(401);
    const stored = store.refreshTokens.find((t) => t.id === 'rt-suspended');
    expect(stored?.revokedAt).not.toBeNull();
  });

  it('rotates refresh tokens single-use: replay of the old token is rejected', async () => {
    // Mint a pair via login for the active agent.
    const login = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'agent@repo-system.local', password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const firstRefresh = login.json().refreshToken as string;

    const rotated = await app.inject({
      method: 'POST', url: '/auth/refresh', payload: { refreshToken: firstRefresh },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().refreshToken).not.toBe(firstRefresh);

    const replay = await app.inject({
      method: 'POST', url: '/auth/refresh', payload: { refreshToken: firstRefresh },
    });
    expect(replay.statusCode).toBe(401);
  });
});

describe('role and field guards', () => {
  it('lets a manager list users', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/users', headers: auth(managerToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().users.length).toBe(4);
  });

  it('never exposes password hashes in the user list', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/users', headers: auth(managerToken) });
    for (const u of res.json().users) {
      expect(u).not.toHaveProperty('passwordHash');
    }
  });

  it('blocks a non-manager from admin routes (403)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/users', headers: auth(agentToken) });
    expect(res.statusCode).toBe(403);
  });

  it('denies field access the matrix hides, and audit-logs the denial', async () => {
    const before = store.auditLogs.length;
    const res = await app.inject({ method: 'GET', url: '/test/debtor-ssn', headers: auth(agentToken) });
    expect(res.statusCode).toBe(403);
    const denials = store.auditLogs.slice(before).filter((l) => l.action === 'permission.denied');
    expect(denials.length).toBe(1);
    expect(denials[0].actorId).toBe('u-agent');
  });

  it('grants field access the matrix allows', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/debtor-ssn', headers: auth(managerToken) });
    expect(res.statusCode).toBe(200);
  });
});

describe('manager suspend/revoke flow', () => {
  it('suspending a user kills their live session and refresh chain', async () => {
    // Agent logs in to get a working pair.
    const login = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'agent@repo-system.local', password: PASSWORD },
    });
    const { accessToken, refreshToken } = login.json();

    // Sanity: the token works before suspension.
    const ok = await app.inject({ method: 'GET', url: '/test/debtor-ssn', headers: auth(agentToken) });
    expect([200, 403]).toContain(ok.statusCode); // 403 = alive but field-denied

    // Manager suspends the agent.
    const sus = await app.inject({
      method: 'POST', url: '/admin/users/u-agent/suspend', headers: auth(managerToken),
    });
    expect(sus.statusCode).toBe(200);

    // The previously valid access token is now dead.
    const dead = await app.inject({
      method: 'GET', url: '/test/debtor-ssn', headers: auth(accessToken),
    });
    expect(dead.statusCode).toBe(401);

    // And the refresh token cannot mint a new one.
    const noRefresh = await app.inject({
      method: 'POST', url: '/auth/refresh', payload: { refreshToken },
    });
    expect(noRefresh.statusCode).toBe(401);

    // Reinstate for other tests.
    await app.inject({
      method: 'POST', url: '/admin/users/u-agent/reinstate', headers: auth(managerToken),
    });
  });
});
