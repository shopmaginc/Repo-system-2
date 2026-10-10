import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import {
  CASE_STATUSES,
  DOCUMENT_KINDS,
  type AuthenticatedUser,
  type BillingEligibility,
  type CaseStatus,
  type DocumentKind,
  type VinVerifyResult,
  type IntakeRequest,
} from '@repo/shared';
import type { DbClient } from '../db.js';
import { logAudit } from '../lib/audit.js';
import { filterFields } from '../lib/permissions.js';
import { requireRole } from '../middleware/guards.js';
import {
  canTransition,
  isCaseStatus,
  transitionError,
} from '../lib/case-status.js';
import { extractVinCandidates, normalizeVin } from '../lib/vin.js';
import { ErrorCodes, apiError } from '../errors.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const idRef = z.object({ id: z.string().min(1) });

const debtorInput = z.union([
  idRef,
  z.object({
    name: z.string().min(1).max(160),
    ssn: z.string().max(32).optional(),
    dob: z.string().max(32).optional(), // ISO date string; parsed on write
    homeAddress: z.string().max(240).optional(),
    personalPhone: z.string().max(32).optional(),
    email: z.string().email().max(254).optional(),
  }),
]);

const clientInput = z
  .union([
    idRef,
    z.object({
      name: z.string().min(1).max(160),
      contactName: z.string().max(160).optional(),
      contactPhone: z.string().max(32).optional(),
      contactEmail: z.string().email().max(254).optional(),
      contactCell: z.string().max(32).optional(),
    }),
  ])
  .optional();

const lenderInput = z
  .union([idRef, z.object({ name: z.string().min(1).max(160) })])
  .optional();

const assetInput = z
  .union([
    idRef,
    z.object({
      vin: z.string().min(17).max(24),
      year: z.number().int().min(1900).max(2100).optional(),
      make: z.string().max(80).optional(),
      model: z.string().max(80).optional(),
      color: z.string().max(40).optional(),
      plate: z.string().max(24).optional(),
      type: z.string().max(24).optional(),
    }),
  ])
  .optional();

const addressInput = z.object({
  label: z.string().max(32).optional(),
  street: z.string().min(1).max(240),
  city: z.string().max(120).optional(),
  state: z.string().max(40).optional(),
  zip: z.string().max(20).optional(),
});

const intakeSchema = z.object({
  caseNumber: z.string().min(1).max(40).optional(),
  source: z.enum(['rdn', 'email', 'manual']).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  notes: z.string().max(4000).optional(),
  debtor: debtorInput,
  client: clientInput,
  lender: lenderInput,
  asset: assetInput,
  addresses: z.array(addressInput).max(25).optional(),
});

const statusSchema = z.object({
  to: z.string().min(1).max(32),
  note: z.string().max(1000).optional(),
});

const assignSchema = z.object({
  agentId: z.string().min(1),
});

const verifyVinSchema = z.object({
  scanA: z.string().min(1).max(64),
  scanB: z.string().min(1).max(64),
});

const taskCreateSchema = z.object({
  title: z.string().min(1).max(240),
  assigneeId: z.string().min(1).optional(),
  dueAt: z.string().datetime().optional(),
});

const taskDoneSchema = z.object({
  done: z.boolean(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CASE_INCLUDE = {
  debtor: true,
  asset: true,
  client: true,
  lender: true,
  assignedAgent: { select: { id: true, name: true, email: true, role: { select: { name: true } } } },
  addresses: true,
  documents: true,
} as const;

type CaseRow = Record<string, any>;

/** Load a case with its relations. Returns null when missing. */
async function loadCase(db: DbClient, id: string): Promise<CaseRow | null> {
  return (await db.case.findUnique({
    where: { id },
    include: CASE_INCLUDE,
  })) as CaseRow | null;
}

/**
 * Role-scoped visibility: which cases may this user see at all?
 * - manager / office_clerk: everything (intake desk needs the full board)
 * - agent: only cases assigned to them
 * - transport_driver: cases in transport/delivery (their working set)
 * - lot_attendant: cases sitting in lot_storage
 */
export function caseInScope(user: AuthenticatedUser, c: CaseRow): boolean {
  switch (user.role) {
    case 'manager':
    case 'office_clerk':
      return true;
    case 'agent':
      return c.assignedAgentId === user.id;
    case 'transport_driver':
      return c.status === 'transport' || c.status === 'delivery';
    case 'lot_attendant':
      return c.status === 'lot_storage';
    default:
      return false;
  }
}

/** Prisma `where` fragment expressing the same scope for list queries. */
function scopeWhere(user: AuthenticatedUser): Record<string, unknown> {
  switch (user.role) {
    case 'manager':
    case 'office_clerk':
      return {};
    case 'agent':
      return { assignedAgentId: user.id };
    case 'transport_driver':
      return { status: { in: ['transport', 'delivery'] } };
    case 'lot_attendant':
      return { status: 'lot_storage' };
    default:
      return { id: '__none__' };
  }
}

/**
 * Serialize a case for the requesting user. Debtor PII is filtered through
 * the manager-editable matrix — default-deny drops anything ungranted.
 */
function serializeCase(user: AuthenticatedUser, c: CaseRow): Record<string, unknown> {
  const { ...rest } = c;
  const debtor = c.debtor
    ? filterFields(user.grants, 'debtor', 'read', c.debtor as Record<string, unknown>)
    : null;
  return { ...rest, debtor };
}

function generateCaseNumber(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, O, L, 0, 1
  const bytes = randomBytes(8);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `CS-${s}`;
}

/** The documents every case starts with; the invoice gate reads these. */
const GATE_DOCUMENTS: DocumentKind[] = [
  'post_recovery_photos',
  'delivery_sheet',
  'condition_report',
];

export async function billingEligibility(db: DbClient, caseId: string): Promise<BillingEligibility> {
  const docs = (await db.requiredDocument.findMany({
    where: { caseId },
  })) as Array<{ kind: string; status: string }>;
  const byKind = new Map(docs.map((d) => [d.kind, d.status]));
  const documents = (DOCUMENT_KINDS as readonly string[]).map((kind) => ({
    kind: kind as DocumentKind,
    status: (byKind.get(kind) ?? 'pending') as BillingEligibility['documents'][number]['status'],
  }));
  const missing = GATE_DOCUMENTS.filter(
    (k) => byKind.get(k) !== 'approved',
  );
  return { unlocked: missing.length === 0, documents, missing };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function casesRoutes(app: FastifyInstance): Promise<void> {
  const db = () => app.db;
  const isManager = (request: FastifyRequest) => request.authUser!.role === 'manager';

  /**
   * POST /cases/extract-vins — pull VIN candidates from pasted order text.
   * Candidates are returned for human confirmation; nothing is auto-created.
   */
  app.post(
    '/extract-vins',
    { onRequest: requireRole('office_clerk', 'manager') },
    async (request) => {
      const body = z.object({ text: z.string().min(1).max(20000) }).parse(request.body);
      return { candidates: extractVinCandidates(body.text) };
    },
  );

  /**
   * POST /cases/intake — clerk/manager enters an order (RDN or email).
   * Accepts debtor/client/lender/asset/addresses in one payload; `{ id }`
   * links an existing record, `{ name, ... }` creates one. Every case is
   * born with its five required-document rows in `pending`.
   */
  app.post(
    '/intake',
    { onRequest: requireRole('office_clerk', 'manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = intakeSchema.parse(request.body) as IntakeRequest & {
        debtor: any; client?: any; lender?: any; asset?: any;
        addresses?: any[];
      };
      const actor = request.authUser!;

      // --- Debtor: link or create ---
      let debtorId: string;
      if (body.debtor.id) {
        const existing = (await db().debtor.findUnique({ where: { id: body.debtor.id } })) as { id: string } | null;
        if (!existing) return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Debtor not found'));
        debtorId = existing.id;
      } else {
        const created = (await db().debtor.create({
          data: {
            name: body.debtor.name.trim(),
            ssn: body.debtor.ssn,
            dob: body.debtor.dob ? new Date(body.debtor.dob) : undefined,
            homeAddress: body.debtor.homeAddress,
            personalPhone: body.debtor.personalPhone,
            email: body.debtor.email,
          },
        })) as { id: string };
        debtorId = created.id;
      }

      // --- Client / lender: optional, link or create ---
      let clientId: string | undefined;
      if (body.client) {
        if (body.client.id) {
          const existing = (await db().client.findUnique({ where: { id: body.client.id } })) as { id: string } | null;
          if (!existing) return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Client not found'));
          clientId = existing.id;
        } else {
          const created = (await db().client.create({ data: { name: body.client.name.trim(), contactName: body.client.contactName, contactPhone: body.client.contactPhone, contactEmail: body.client.contactEmail, contactCell: body.client.contactCell } })) as { id: string };
          clientId = created.id;
        }
      }
      let lenderId: string | undefined;
      if (body.lender) {
        if (body.lender.id) {
          const existing = (await db().lender.findUnique({ where: { id: body.lender.id } })) as { id: string } | null;
          if (!existing) return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Lender not found'));
          lenderId = existing.id;
        } else {
          const created = (await db().lender.create({ data: { name: body.lender.name.trim() } })) as { id: string };
          lenderId = created.id;
        }
      }

      // --- Asset: link by VIN when it already exists, else create ---
      let assetId: string | undefined;
      if (body.asset) {
        if (body.asset.id) {
          const existing = (await db().asset.findUnique({ where: { id: body.asset.id } })) as { id: string } | null;
          if (!existing) return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Asset not found'));
          assetId = existing.id;
        } else {
          const vin = normalizeVin(body.asset.vin);
          if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
            return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'Asset VIN must be 17 characters (no I, O, Q)'));
          }
          const existing = (await db().asset.findUnique({ where: { vin } })) as { id: string } | null;
          if (existing) {
            assetId = existing.id;
          } else {
            const created = (await db().asset.create({
              data: { vin, year: body.asset.year, make: body.asset.make, model: body.asset.model, color: body.asset.color, plate: body.asset.plate, type: body.asset.type },
            })) as { id: string };
            assetId = created.id;
          }
        }
      }

      // --- Case number: provided or generated (retry on collision) ---
      let caseNumber = body.caseNumber?.trim();
      if (caseNumber) {
        const clash = await db().case.findUnique({ where: { caseNumber } });
        if (clash) return reply.status(409).send(apiError(ErrorCodes.CONFLICT, 'Case number already exists'));
      } else {
        for (let i = 0; i < 5; i++) {
          caseNumber = generateCaseNumber();
          const clash = await db().case.findUnique({ where: { caseNumber } });
          if (!clash) break;
          caseNumber = undefined as unknown as string;
        }
        if (!caseNumber) return reply.status(500).send(apiError(ErrorCodes.INTERNAL, 'Could not generate a case number'));
      }

      const created = (await db().case.create({
        data: {
          caseNumber,
          status: 'intake',
          priority: body.priority ?? 'normal',
          notes: body.notes,
          source: body.source,
          clientId,
          lenderId,
          debtorId,
          assetId,
        },
      })) as { id: string };

      // Addresses linked to the case.
      for (const a of body.addresses ?? []) {
        await db().address.create({
          data: { caseId: created.id, label: a.label ?? 'given', street: a.street.trim(), city: a.city, state: a.state, zip: a.zip },
        });
      }

      // Every case starts with its required-document rows in `pending`.
      for (const kind of DOCUMENT_KINDS) {
        await db().requiredDocument.create({ data: { caseId: created.id, kind, status: 'pending' } });
      }

      await db().caseStatusHistory.create({
        data: { caseId: created.id, from: null, to: 'intake', actorId: actor.id, note: body.source ? `Order received via ${body.source}` : 'Order received' },
      });

      await logAudit(db(), {
        actorId: actor.id, action: 'case.intake', entityType: 'case', entityId: created.id,
        ipAddress: request.ip, result: 'success',
        details: { caseNumber, source: body.source ?? null },
      });

      const full = await loadCase(db(), created.id);
      reply.status(201);
      return { case: serializeCase(actor, full!) };
    },
  );

  /** GET /cases — role-scoped listing (agents see only their assignments). */
  app.get('/', async (request) => {
    const actor = request.authUser!;
    const query = request.query as { status?: string };
    const where: Record<string, unknown> = scopeWhere(actor);
    if (query.status) {
      if (!isCaseStatus(query.status)) {
        throw Object.assign(new Error('Unknown status filter'), { statusCode: 400 });
      }
      where.status = query.status;
    }
    const rows = (await db().case.findMany({
      where,
      include: CASE_INCLUDE,
      orderBy: { createdAt: 'desc' },
    })) as CaseRow[];
    return { cases: rows.filter((c) => caseInScope(actor, c)).map((c) => serializeCase(actor, c)) };
  });

  /** GET /cases/:id — detail, debtor PII filtered through the matrix. */
  app.get('/:id', async (request, reply) => {
    const actor = request.authUser!;
    const { id } = request.params as { id: string };
    const c = await loadCase(db(), id);
    if (!c || !caseInScope(actor, c)) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
    }
    return { case: serializeCase(actor, c) };
  });

  /**
   * POST /cases/:id/assign — manager/clerk assigns (or transfers) a case to
   * an agent. Assigning from `intake` also moves the case to `assigned`.
   */
  app.post(
    '/:id/assign',
    { onRequest: requireRole('manager', 'office_clerk') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const body = assignSchema.parse(request.body);

      const c = await loadCase(db(), id);
      if (!c) return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      if (isCaseStatus(c.status) && ['closed', 'cancelled'].includes(c.status)) {
        return reply.status(409).send(apiError(ErrorCodes.CONFLICT, `Cannot assign a ${c.status} case`));
      }

      const target = (await db().user.findUnique({
        where: { id: body.agentId },
        include: { role: true },
      })) as { id: string; status: string; role: { name: string }; name: string } | null;
      if (!target || target.status !== 'active') {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Agent not found or not active'));
      }
      if (target.role.name !== 'agent') {
        return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'Cases can only be assigned to users with the agent role'));
      }

      await db().case.update({ where: { id }, data: { assignedAgentId: target.id } });

      // Intake -> assigned moves with the assignment.
      if (c.status === 'intake') {
        await db().case.update({ where: { id }, data: { status: 'assigned' } });
        await db().caseStatusHistory.create({
          data: { caseId: id, from: 'intake', to: 'assigned', actorId: actor.id, note: `Assigned to ${target.name}` },
        });
      }

      await logAudit(db(), {
        actorId: actor.id, action: 'case.assigned', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: 'success',
        details: { agentId: target.id, agentName: target.name },
      });

      const full = await loadCase(db(), id);
      return { case: serializeCase(actor, full!) };
    },
  );

  /**
   * POST /cases/:id/status — advance (or hold) a case. The state machine
   * validates the move; non-managers are limited to mapped transitions,
   * managers may override to any non-terminal status. Every move writes
   * history + an audit row.
   */
  app.post('/:id/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const { id } = request.params as { id: string };
    const body = statusSchema.parse(request.body);

    const c = await loadCase(db(), id);
    if (!c || !caseInScope(actor, c)) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
    }
    if (!isCaseStatus(c.status) || !isCaseStatus(body.to)) {
      return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'Unknown status'));
    }

    const manager = isManager(request);
    if (!canTransition(c.status as CaseStatus, body.to as CaseStatus, manager)) {
      const denied = body.to === 'cancelled' && !manager;
      await logAudit(db(), {
        actorId: actor.id, action: denied ? 'case.cancel_denied' : 'case.transition_denied',
        entityType: 'case', entityId: id, ipAddress: request.ip, result: 'denied',
        details: { from: c.status, to: body.to },
      });
      return reply
        .status(denied ? 403 : 422)
        .send(apiError(denied ? ErrorCodes.FORBIDDEN : ErrorCodes.VALIDATION, transitionError(c.status as CaseStatus, body.to as CaseStatus, manager)));
    }

    await db().case.update({ where: { id }, data: { status: body.to } });
    await db().caseStatusHistory.create({
      data: { caseId: id, from: c.status, to: body.to, actorId: actor.id, note: body.note ?? null },
    });
    await logAudit(db(), {
      actorId: actor.id, action: 'case.status_changed', entityType: 'case', entityId: id,
      ipAddress: request.ip, result: 'success',
      details: { from: c.status, to: body.to, note: body.note ?? null },
    });

    const full = await loadCase(db(), id);
    return { case: serializeCase(actor, full!) };
  });

  /**
   * POST /cases/:id/verify-vin — the solo-agent double-check. Two scanned
   * values (e.g. plate OCR + door-jamb barcode) must agree with each other
   * AND with the case asset's VIN. The result is audit-logged and written
   * to the case timeline.
   */
  app.post(
    '/:id/verify-vin',
    { onRequest: requireRole('agent', 'manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const body = verifyVinSchema.parse(request.body);

      const c = await loadCase(db(), id);
      if (!c || !caseInScope(actor, c)) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      if (!c.asset) {
        return reply.status(409).send(apiError(ErrorCodes.CONFLICT, 'Case has no asset VIN on file to verify against'));
      }

      const scanA = normalizeVin(body.scanA);
      const scanB = normalizeVin(body.scanB);
      const assetVin = normalizeVin((c.asset as { vin: string }).vin);

      const aMatchesAsset = scanA.length === 17 && scanA === assetVin;
      const bMatchesAsset = scanB.length === 17 && scanB === assetVin;
      const aMatchesB = scanA.length > 0 && scanA === scanB;
      const result: VinVerifyResult = {
        match: aMatchesAsset && bMatchesAsset && aMatchesB,
        scanA, scanB, assetVin, aMatchesAsset, bMatchesAsset, aMatchesB,
      };

      await db().caseStatusHistory.create({
        data: {
          caseId: id, from: c.status, to: c.status, actorId: actor.id,
          note: `VIN verification ${result.match ? 'MATCH' : 'MISMATCH'} — scans ${scanA || '?'} / ${scanB || '?'}`,
        },
      });
      await logAudit(db(), {
        actorId: actor.id, action: 'case.vin_verified', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: result.match ? 'success' : 'failure',
        details: { match: result.match, aMatchesAsset, bMatchesAsset, aMatchesB },
      });

      return { verification: result };
    },
  );

  /** GET /cases/:id/billing-eligibility — the invoice gate. */
  app.get(
    '/:id/billing-eligibility',
    { onRequest: requireRole('manager', 'office_clerk') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const exists = await db().case.findUnique({ where: { id } });
      if (!exists) return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      return await billingEligibility(db(), id);
    },
  );

  /**
   * POST /cases/:id/documents/:kind/submit — field/office staff submit a
   * required document for review.
   */
  app.post('/:id/documents/:kind/submit', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const { id, kind } = request.params as { id: string; kind: string };
    if (!(DOCUMENT_KINDS as readonly string[]).includes(kind)) {
      return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'Unknown document kind'));
    }
    const c = await loadCase(db(), id);
    if (!c || !caseInScope(actor, c)) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
    }
    const doc = (await db().requiredDocument.findFirst({ where: { caseId: id, kind } })) as { id: string; status: string } | null;
    if (!doc) return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Document not found'));
    if (doc.status === 'approved') {
      return reply.status(409).send(apiError(ErrorCodes.CONFLICT, 'Document is already approved'));
    }
    const updated = await db().requiredDocument.update({
      where: { id: doc.id },
      data: { status: 'submitted', submittedById: actor.id, submittedAt: new Date() },
    });
    await logAudit(db(), {
      actorId: actor.id, action: 'case.document_submitted', entityType: 'case', entityId: id,
      ipAddress: request.ip, result: 'success', details: { kind },
    });
    return { document: updated };
  });

  /**
   * POST /cases/:id/documents/:kind/approve — manager-only. The invoice
   * cannot be approved until the gate passes (photos + delivery sheet +
   * condition report approved).
   */
  app.post(
    '/:id/documents/:kind/approve',
    { onRequest: requireRole('manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id, kind } = request.params as { id: string; kind: string };
      if (!(DOCUMENT_KINDS as readonly string[]).includes(kind)) {
        return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'Unknown document kind'));
      }
      const c = await loadCase(db(), id);
      if (!c) return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));

      if (kind === 'invoice') {
        const gate = await billingEligibility(db(), id);
        if (!gate.unlocked) {
          await logAudit(db(), {
            actorId: actor.id, action: 'case.invoice_gate_blocked', entityType: 'case', entityId: id,
            ipAddress: request.ip, result: 'denied', details: { missing: gate.missing },
          });
          return reply.status(409).send(
            apiError(ErrorCodes.CONFLICT, `Invoice blocked: still missing ${gate.missing.join(', ')}`),
          );
        }
      }

      const doc = (await db().requiredDocument.findFirst({ where: { caseId: id, kind } })) as { id: string } | null;
      if (!doc) return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Document not found'));
      const updated = await db().requiredDocument.update({
        where: { id: doc.id },
        data: { status: 'approved', approvedById: actor.id, approvedAt: new Date() },
      });
      await logAudit(db(), {
        actorId: actor.id, action: 'case.document_approved', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: 'success', details: { kind },
      });
      return { document: updated };
    },
  );

  /** POST /cases/:id/tasks — manager/clerk creates a task on a case. */
  app.post(
    '/:id/tasks',
    { onRequest: requireRole('manager', 'office_clerk') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const body = taskCreateSchema.parse(request.body);
      const c = await db().case.findUnique({ where: { id } });
      if (!c) return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));

      let assigneeId: string | undefined;
      if (body.assigneeId) {
        const assignee = (await db().user.findUnique({ where: { id: body.assigneeId } })) as { id: string; status: string } | null;
        if (!assignee || assignee.status !== 'active') {
          return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Assignee not found or not active'));
        }
        assigneeId = assignee.id;
      }
      const task = await db().task.create({
        data: { caseId: id, title: body.title.trim(), assigneeId, dueAt: body.dueAt ? new Date(body.dueAt) : undefined },
      });
      await logAudit(db(), {
        actorId: actor.id, action: 'case.task_created', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: 'success', details: { title: body.title, assigneeId: assigneeId ?? null },
      });
      reply.status(201);
      return { task };
    },
  );

  /** GET /cases/:id/tasks — tasks on a case (role-scoped like the case). */
  app.get('/:id/tasks', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const { id } = request.params as { id: string };
    const c = await loadCase(db(), id);
    if (!c || !caseInScope(actor, c)) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
    }
    const tasks = await db().task.findMany({ where: { caseId: id }, orderBy: { createdAt: 'asc' } });
    return { tasks };
  });

  /** PATCH /cases/:id/tasks/:taskId — mark done; assignee, clerk, or manager. */
  app.patch('/:id/tasks/:taskId', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const { id, taskId } = request.params as { id: string; taskId: string };
    const body = taskDoneSchema.parse(request.body);
    const c = await loadCase(db(), id);
    if (!c || !caseInScope(actor, c)) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
    }
    const task = (await db().task.findUnique({ where: { id: taskId } })) as { id: string; caseId: string; assigneeId: string | null } | null;
    if (!task || task.caseId !== id) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Task not found'));
    }
    const allowed =
      actor.role === 'manager' ||
      actor.role === 'office_clerk' ||
      task.assigneeId === actor.id;
    if (!allowed) {
      await logAudit(db(), {
        actorId: actor.id, action: 'case.task_denied', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: 'denied', details: { taskId },
      });
      return reply.status(403).send(apiError(ErrorCodes.FORBIDDEN, 'Only the assignee, a clerk, or a manager can update this task'));
    }
    const updated = await db().task.update({ where: { id: taskId }, data: { done: body.done } });
    await logAudit(db(), {
      actorId: actor.id, action: 'case.task_updated', entityType: 'case', entityId: id,
      ipAddress: request.ip, result: 'success', details: { taskId, done: body.done },
    });
    return { task: updated };
  });
}
