import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../src/lib/password.js';
import { buildApp } from '../src/app.js';
import type { DbClient } from '../src/db.js';

/**
 * Phase 3 recovery-to-invoice tests against an in-memory stub DB.
 * Proves: photo intake requires lot-capture-capable roles and rejects bad
 * mime types; document scans submit + raise an office review task; the
 * review queue is office-only and PII-free; rejections require a note and
 * notify the submitter; lot assignment is audited; delivery requires an
 * approved delivery sheet and moves the case; the invoice gate blocks
 * until evidence is complete; condition reports and inspections persist.
 */

// ---------------------------------------------------------------------------
// Stub DB (mirrors field.test.ts, extended with Phase 3 stores)
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
};

let app: FastifyInstance;
let agentToken: string;
let managerToken: string;
let clerkToken: string;
let driverToken: string;
let courierToken: string;

const PASSWORD = 'correct-horse-battery';
const UPLOADS = mkdtempSync(join(tmpdir(), 'repo-uploads-'));

/** Build a multipart/form-data body for one file + text fields. */
function multipart(
  filename: string,
  mime: string,
  content: Buffer,
  fields: Record<string, string> = {},
): { payload: Buffer; contentType: string } {
  const boundary = `----testboundary${Date.now()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
  );
  parts.push(content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

const DOC_KINDS = ['post_recovery_photos', 'condition_report', 'delivery_sheet', 'delivery_confirmation', 'invoice'];

function mkDocs(caseId: string, approved: string[] = []): void {
  for (const kind of DOC_KINDS) {
    stores.documents.push({
      id: `doc-${caseId}-${kind}`,
      caseId,
      kind,
      status: approved.includes(kind) ? 'approved' : 'pending',
      submittedById: approved.includes(kind) ? 'u-manager' : null,
      submittedAt: approved.includes(kind) ? new Date() : null,
      approvedById: approved.includes(kind) ? 'u-manager' : null,
      approvedAt: approved.includes(kind) ? new Date() : null,
      rejectionNote: null,
    });
  }
}

beforeAll(async () => {
  stores.roles.push(
    { id: 'role-agent', name: 'agent', canCaptureLotPhotos: true },
    { id: 'role-manager', name: 'manager', canCaptureLotPhotos: true },
    { id: 'role-clerk', name: 'office_clerk', canCaptureLotPhotos: true },
    { id: 'role-driver', name: 'transport_driver', canCaptureLotPhotos: true },
    // Courier: a role with no lot-capture duty and no document roles.
    { id: 'role-courier', name: 'courier', canCaptureLotPhotos: false },
  );
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
    mkUser('u-manager', 'manager@repo-system.local', 'role-manager'),
    mkUser('u-clerk', 'clerk@repo-system.local', 'role-clerk'),
    mkUser('u-driver', 'driver@repo-system.local', 'role-driver'),
    mkUser('u-courier', 'courier@repo-system.local', 'role-courier'),
  );

  stores.clients.push({ id: 'client-1', name: 'Great Lakes Asset Recovery', contactName: 'Michael Laspada' });
  stores.lenders.push({ id: 'lender-1', name: 'Demo National Bank' });
  stores.debtors.push({ id: 'debtor-1', name: 'Recovery Debtor', ssn: '111-22-3333', personalPhone: '(555) 010-1111' });
  stores.assets.push({ id: 'asset-1', vin: '1XPBD49X2LD704829', year: 2020, make: 'Peterbilt', model: '579', color: 'Red', plate: 'TX12345' });

  // case-1: lot_storage, gate documents approved → invoice should succeed.
  stores.cases.push({
    id: 'case-1', caseNumber: 'CS-REC001', status: 'transport', priority: 'normal',
    clientId: 'client-1', lenderId: 'lender-1', debtorId: 'debtor-1', assetId: 'asset-1',
    assignedAgentId: 'u-agent1',
  });
  mkDocs('case-1', ['post_recovery_photos', 'condition_report', 'delivery_sheet']);

  // case-2: delivery, delivery_sheet NOT approved → deliver must 422.
  stores.cases.push({
    id: 'case-2', caseNumber: 'CS-REC002', status: 'delivery', priority: 'normal',
    clientId: 'client-1', lenderId: 'lender-1', debtorId: 'debtor-1', assetId: 'asset-1',
    assignedAgentId: 'u-agent1',
  });
  mkDocs('case-2', ['post_recovery_photos', 'condition_report']);

  // case-3: lot_storage, gate docs pending → invoice must 409.
  stores.cases.push({
    id: 'case-3', caseNumber: 'CS-REC003', status: 'lot_storage', priority: 'normal',
    clientId: 'client-1', lenderId: 'lender-1', debtorId: 'debtor-1', assetId: 'asset-1',
    assignedAgentId: 'u-agent1',
  });
  mkDocs('case-3', []);

  stores.lots.push({ id: 'lot-1', name: 'Main Lot — Laredo', address: '110 Coal Mines Rd, Laredo, TX 78045' });

  app = await buildApp({
    config: {
      DATABASE_URL: 'postgresql://localhost:5432/test',
      JWT_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
      JWT_ACCESS_TTL_SECONDS: 900,
      PORT: 3004,
      NODE_ENV: 'test',
      UPLOADS_DIR: UPLOADS,
      MAX_UPLOAD_MB: 25,
    },
    db: makeStub(stores),
  });

  const sign = (sub: string, role: string) => app.jwt.sign({ role }, { sub });
  agentToken = sign('u-agent1', 'agent');
  managerToken = sign('u-manager', 'manager');
  clerkToken = sign('u-clerk', 'office_clerk');
  driverToken = sign('u-driver', 'transport_driver');
  courierToken = sign('u-courier', 'courier');
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

// ---------------------------------------------------------------------------
// Photo intake
// ---------------------------------------------------------------------------
describe('photo intake', () => {
  it('accepts a JPEG from a lot-capture-capable role and audits it', async () => {
    const { payload, contentType } = multipart('side.jpg', 'image/jpeg', JPEG, { category: 'four_side', caption: 'driver side' });
    const res = await app.inject({
      method: 'POST',
      url: '/cases/case-1/photos',
      headers: { ...auth(agentToken), 'content-type': contentType },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.photo.category).toBe('four_side');
    expect(stores.photos).toHaveLength(1);
    expect(stores.auditLogs.some((a) => a.action === 'recovery.photo_added')).toBe(true);
  });

  it('denies upload for a role without lot-capture duty (403)', async () => {
    const { payload, contentType } = multipart('side.jpg', 'image/jpeg', JPEG, { category: 'four_side' });
    const res = await app.inject({
      method: 'POST',
      url: '/cases/case-1/photos',
      headers: { ...auth(courierToken), 'content-type': contentType },
      payload,
    });
    expect(res.statusCode).toBe(403);
    expect(stores.auditLogs.some((a) => a.action === 'recovery.photo_denied')).toBe(true);
  });

  it('rejects unsupported mime types (415)', async () => {
    const { payload, contentType } = multipart('note.txt', 'text/plain', Buffer.from('hello'), { category: 'other' });
    const res = await app.inject({
      method: 'POST',
      url: '/cases/case-1/photos',
      headers: { ...auth(agentToken), 'content-type': contentType },
      payload,
    });
    expect(res.statusCode).toBe(415);
  });

  it('lists photos without leaking PII or storage paths', async () => {
    const res = await app.inject({ method: 'GET', url: '/cases/case-1/photos', headers: auth(agentToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.photos).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('storagePath');
    expect(JSON.stringify(body)).not.toContain('111-22-3333');
  });
});

// ---------------------------------------------------------------------------
// Document scan → review queue → reject
// ---------------------------------------------------------------------------
describe('document scan and review queue', () => {
  it('scan submission marks the document submitted and raises a review task', async () => {
    const pdf = Buffer.from('%PDF-1.4 fake');
    const { payload, contentType } = multipart('sheet.pdf', 'application/pdf', pdf, {});
    const res = await app.inject({
      method: 'POST',
      url: '/cases/case-3/documents/delivery_sheet/scan',
      headers: { ...auth(agentToken), 'content-type': contentType },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const doc = stores.documents.find((d) => d.caseId === 'case-3' && d.kind === 'delivery_sheet');
    expect(doc?.status).toBe('submitted');
    expect(stores.tasks.some((t) => String(t.title).startsWith('REVIEW NEEDED'))).toBe(true);
    expect(stores.photos.some((p) => p.category === 'document_scan')).toBe(true);
  });

  it('review queue is office-only and contains no debtor PII', async () => {
    const denied = await app.inject({ method: 'GET', url: '/review-queue', headers: auth(agentToken) });
    expect(denied.statusCode).toBe(403);
    const res = await app.inject({ method: 'GET', url: '/review-queue', headers: auth(clerkToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.queue.length).toBeGreaterThan(0);
    const item = body.queue.find((q: Row) => q.kind === 'delivery_sheet');
    expect(item.caseNumber).toBe('CS-REC003');
    expect(item.clientName).toBe('Great Lakes Asset Recovery');
    expect(JSON.stringify(body)).not.toContain('111-22-3333');
    expect(JSON.stringify(body)).not.toContain('debtor');
  });

  it('reject requires a note; rejection resets to pending and notifies the submitter', async () => {
    const noNote = await app.inject({
      method: 'POST',
      url: '/cases/case-3/documents/delivery_sheet/reject',
      headers: { ...auth(managerToken), 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(noNote.statusCode).toBe(400);

    const res = await app.inject({
      method: 'POST',
      url: '/cases/case-3/documents/delivery_sheet/reject',
      headers: { ...auth(managerToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ note: 'Signature is cut off — rescan please' }),
    });
    expect(res.statusCode).toBe(200);
    const doc = stores.documents.find((d) => d.caseId === 'case-3' && d.kind === 'delivery_sheet');
    expect(doc?.status).toBe('pending');
    expect(doc?.rejectionNote).toContain('cut off');
    expect(
      stores.tasks.some((t) => t.assigneeId === 'u-agent1' && String(t.title).startsWith('Fix & resubmit')),
    ).toBe(true);
    expect(stores.auditLogs.some((a) => a.action === 'case.document_rejected')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lot assignment
// ---------------------------------------------------------------------------
describe('lot assignment', () => {
  it('records the lot with history and audit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cases/case-1/lot',
      headers: { ...auth(driverToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ lotId: 'lot-1' }),
    });
    expect(res.statusCode).toBe(201);
    expect(stores.lotAssignments).toHaveLength(1);
    expect(stores.auditLogs.some((a) => a.action === 'recovery.lot_assigned')).toBe(true);

    const cur = await app.inject({ method: 'GET', url: '/cases/case-1/lot', headers: auth(agentToken) });
    expect(cur.statusCode).toBe(200);
    expect(cur.json().lot.name).toBe('Main Lot — Laredo');
  });

  it('404s on unknown lots', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cases/case-1/lot',
      headers: { ...auth(driverToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ lotId: 'lot-nope' }),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Delivery confirmation
// ---------------------------------------------------------------------------
describe('delivery confirmation', () => {
  it('422s when the delivery sheet is not approved', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cases/case-2/deliver',
      headers: { ...auth(driverToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ signedByName: 'Jane Receiver' }),
    });
    expect(res.statusCode).toBe(422);
    expect(stores.auditLogs.some((a) => a.action === 'recovery.deliver_denied')).toBe(true);
  });

  it('confirms delivery once the sheet is approved and moves the case', async () => {
    const approve = await app.inject({
      method: 'POST',
      url: '/cases/case-2/documents/delivery_sheet/approve',
      headers: auth(managerToken),
    });
    expect(approve.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: '/cases/case-2/deliver',
      headers: { ...auth(driverToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ signedByName: 'Jane Receiver', lat: 27.5, lng: -99.4 }),
    });
    expect(res.statusCode).toBe(201);
    const kase = stores.cases.find((c) => c.id === 'case-2');
    expect(kase?.status).toBe('invoicing');
    expect(stores.deliveryConfirmations).toHaveLength(1);
    const doc = stores.documents.find((d) => d.caseId === 'case-2' && d.kind === 'delivery_confirmation');
    expect(doc?.status).toBe('submitted');
  });
});

// ---------------------------------------------------------------------------
// Condition report + inspection
// ---------------------------------------------------------------------------
describe('condition report and inspection', () => {
  it('files a condition report and submits the document', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cases/case-3/condition-report',
      headers: { ...auth(agentToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ sections: { exterior: 'Clean', notes: 'Minor scratch on door' } }),
    });
    expect(res.statusCode).toBe(201);
    expect(stores.conditionReports).toHaveLength(1);
    const doc = stores.documents.find((d) => d.caseId === 'case-3' && d.kind === 'condition_report');
    expect(doc?.status).toBe('submitted');
  });

  it('files and returns the latest inspection checklist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cases/case-3/inspection',
      headers: { ...auth(agentToken), 'content-type': 'application/json' },
      payload: JSON.stringify({
        assetType: 'tractor',
        items: [
          { key: 'tires', label: 'Tires', result: 'pass' },
          { key: 'brakes', label: 'Brakes', result: 'fail', notes: 'Rear pads worn' },
          { key: 'airlines', label: 'Airlines', result: 'na' },
        ],
      }),
    });
    expect(res.statusCode).toBe(201);
    const get = await app.inject({ method: 'GET', url: '/cases/case-3/inspection', headers: auth(agentToken) });
    expect(get.statusCode).toBe(200);
    const checklist = get.json().checklist;
    expect(checklist.assetType).toBe('tractor');
    expect(checklist.items).toHaveLength(3);
  });

  it('rejects invalid inspection results', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cases/case-3/inspection',
      headers: { ...auth(agentToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ assetType: 'tractor', items: [{ key: 'tires', label: 'Tires', result: 'maybe' }] }),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Invoice gate
// ---------------------------------------------------------------------------
describe('invoice gate', () => {
  it('409s while required evidence is missing, listing what is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cases/case-3/invoice',
      headers: { ...auth(clerkToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 450 }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('post_recovery_photos');
    expect(stores.invoices).toHaveLength(0);
  });

  it('creates the invoice once the gate passes and the doc submits', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cases/case-1/invoice',
      headers: { ...auth(clerkToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 450 }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.invoice.status).toBe('pending');
    expect(body.invoice.invoiceNumber).toMatch(/^INV-/);
    const doc = stores.documents.find((d) => d.caseId === 'case-1' && d.kind === 'invoice');
    expect(doc?.status).toBe('submitted');
    expect(stores.auditLogs.some((a) => a.action === 'recovery.invoice_created')).toBe(true);
  });

  it('manager can approve the invoice after the gate passes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cases/case-1/documents/invoice/approve',
      headers: auth(managerToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().document.status).toBe('approved');
  });
});
