import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DOCUMENT_KINDS,
  PHOTO_CATEGORIES,
  type AuthenticatedUser,
  type CaseStatus,
  type DeliverRequest,
  type DocumentKind,
  type InspectionRequest,
  type InvoiceRequest,
  type LotAssignRequest,
} from '@repo/shared';
import type { DbClient } from '../db.js';
import { logAudit } from '../lib/audit.js';
import { requireRole } from '../middleware/guards.js';
import { StorageNotFoundError, type Storage, type StorageBody } from '../lib/storage.js';
import { billingEligibility, caseInScope } from './cases.js';
import {
  canTransition,
  isCaseStatus,
  transitionError,
} from '../lib/case-status.js';
import { ErrorCodes, apiError } from '../errors.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const categorySchema = z.enum(PHOTO_CATEGORIES as unknown as [string, ...string[]]);

const lotAssignSchema = z.object({
  lotId: z.string().min(1).max(64),
});

const deliverSchema = z.object({
  signedByName: z.string().min(1).max(160),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

const conditionReportSchema = z.object({
  sections: z.record(z.string().min(1).max(80), z.string().max(8000)),
});

const inspectionItemSchema = z.object({
  key: z.string().min(1).max(80),
  label: z.string().min(1).max(160),
  result: z.enum(['pass', 'fail', 'na']),
  notes: z.string().max(2000).optional(),
});

const inspectionSchema = z.object({
  assetType: z.enum(['tractor', 'trailer']),
  items: z.array(inspectionItemSchema).min(1).max(60),
});

const invoiceSchema = z.object({
  invoiceNumber: z.string().min(1).max(40).optional(),
  amount: z.number().positive().max(100000000).optional(),
});

const rejectSchema = z.object({
  note: z.string().min(1).max(2000),
});

// ---------------------------------------------------------------------------
// File storage helpers
// ---------------------------------------------------------------------------

/** Strict mime → extension mapping. Anything not listed is rejected. */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
};

type CaseRow = Record<string, any>;

/** Minimal case load + role-scope check. 404 unless in scope — never 403. */
async function loadScopedCase(
  db: DbClient,
  id: string,
  user: AuthenticatedUser,
): Promise<CaseRow | null> {
  const c = (await db.case.findUnique({ where: { id } })) as CaseRow | null;
  if (!c || !caseInScope(user, c)) return null;
  return c;
}

/**
 * Persist one uploaded file under the key `<caseId>/<uuid>.<ext>`.
 * The extension comes from the validated mime type — never from the
 * client-supplied filename — so nothing executable can be planted.
 * Storage backend (local disk or S3/R2) comes from app config.
 */
async function storeUpload(
  db: DbClient,
  opts: {
    storage: Storage;
    caseId: string;
    file: StorageBody;
    mimeType: string;
    category: string;
    caption: string | undefined;
    uploaderId: string;
  },
): Promise<Record<string, unknown>> {
  const ext = MIME_EXT[opts.mimeType];
  if (!ext) throw new Error(`Unsupported file type: ${opts.mimeType}`);
  const key = `${opts.caseId}/${randomUUID()}.${ext}`;
  await opts.storage.put(key, opts.file, opts.mimeType);
  return (await db.photo.create({
    data: {
      caseId: opts.caseId,
      uploaderId: opts.uploaderId,
      category: opts.category,
      storagePath: key,
      mimeType: opts.mimeType,
      caption: opts.caption ?? null,
    },
  })) as Record<string, unknown>;
}

/** Anyone who may capture lot photos (universal duty) plus office roles. */
function canCapture(user: AuthenticatedUser): boolean {
  return (
    user.canCaptureLotPhotos ||
    user.role === 'manager' ||
    user.role === 'office_clerk'
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function recoveryRoutes(app: FastifyInstance): Promise<void> {
  const db = () => app.db;
  const storage = () => app.storage;

  /**
   * POST /cases/:id/photos — photo intake. Multipart, one file per request.
   * Category drives the lot-intake flow (four sides, VIN plate, odometer,
   * damage) and document scans. Any role with lot-capture duty.
   */
  app.post('/:id/photos', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const { id } = request.params as { id: string };

    if (!canCapture(actor)) {
      await logAudit(db(), {
        actorId: actor.id, action: 'recovery.photo_denied', entityType: 'case',
        entityId: id, ipAddress: request.ip, result: 'denied', details: {},
      });
      return reply
        .status(403)
        .send(apiError(ErrorCodes.FORBIDDEN, 'Your role cannot capture photos'));
    }
    const c = await loadScopedCase(db(), id, actor);
    if (!c) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
    }

    const data = await (request as any).file();
    if (!data) {
      return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'No file uploaded'));
    }
    const category = categorySchema.safeParse(
      (data.fields?.category as any)?.value ?? (request.query as Record<string, string>)?.category,
    );
    if (!category.success) {
      return reply
        .status(400)
        .send(apiError(ErrorCodes.VALIDATION, 'category is required: four_side | vin_plate | odometer | damage | document_scan | other'));
    }
    const caption = (data.fields?.caption as any)?.value as string | undefined;
    if (!MIME_EXT[data.mimetype]) {
      return reply
        .status(415)
        .send(apiError(ErrorCodes.VALIDATION, 'Only JPEG, PNG, WebP, HEIC, and PDF uploads are accepted'));
    }

    let photo: Record<string, unknown>;
    try {
      photo = await storeUpload(db(), {
        storage: storage(),
        caseId: id,
        file: data.file,
        mimeType: data.mimetype,
        category: category.data,
        caption: typeof caption === 'string' ? caption.slice(0, 500) : undefined,
        uploaderId: actor.id,
      });
    } catch (err) {
      request.log?.error?.(err);
      return reply.status(500).send(apiError(ErrorCodes.INTERNAL, 'Could not store the upload'));
    }
    await logAudit(db(), {
      actorId: actor.id, action: 'recovery.photo_added', entityType: 'case',
      entityId: id, ipAddress: request.ip, result: 'success',
      details: { category: category.data, photoId: photo.id },
    });
    reply.status(201);
    return { photo: { id: photo.id, category: photo.category, caption: photo.caption, mimeType: photo.mimeType, createdAt: photo.createdAt } };
  });

  /** GET /cases/:id/photos — list a case's photos (no file bytes, no PII). */
  app.get('/:id/photos', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const { id } = request.params as { id: string };
    const c = await loadScopedCase(db(), id, actor);
    if (!c) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
    }
    const photos = (await db().photo.findMany({
      where: { caseId: id },
      orderBy: { createdAt: 'asc' },
    })) as Array<Record<string, unknown>>;
    return {
      photos: photos.map((p) => ({
        id: p.id,
        category: p.category,
        caption: p.caption ?? null,
        mimeType: p.mimeType,
        uploaderId: p.uploaderId,
        createdAt: p.createdAt,
      })),
    };
  });

  /**
   * GET /cases/:id/photos/:photoId/file — download one photo/scan.
   * Same scope as the case; the storage key never leaves the server —
   * bytes are read back through the storage backend (local disk or
   * S3/R2) and streamed to the authorized requester.
   */
  app.get('/:id/photos/:photoId/file', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const { id, photoId } = request.params as { id: string; photoId: string };
    const c = await loadScopedCase(db(), id, actor);
    if (!c) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
    }
    const photo = (await db().photo.findUnique({ where: { id: photoId } })) as Record<string, unknown> | null;
    if (!photo || photo.caseId !== id) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Photo not found'));
    }
    let bytes: Buffer;
    try {
      bytes = await storage().get(String(photo.storagePath));
    } catch (err) {
      if (err instanceof StorageNotFoundError) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'File not found'));
      }
      throw err;
    }
    await logAudit(db(), {
      actorId: actor.id, action: 'recovery.photo_downloaded', entityType: 'case',
      entityId: id, ipAddress: request.ip, result: 'success',
      details: { photoId },
    });
    return reply
      .header('Content-Type', String(photo.mimeType))
      .header('Content-Disposition', 'inline')
      .send(bytes);
  });

  /**
   * POST /cases/:id/documents/:kind/scan — the office review flow: capture
   * a signed document / receipt (PDF or image), mark the required document
   * `submitted`, and raise a review task so office staff review it before
   * anything goes to the client.
   */
  app.post('/:id/documents/:kind/scan', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const { id, kind } = request.params as { id: string; kind: string };
    if (!(DOCUMENT_KINDS as readonly string[]).includes(kind)) {
      return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'Unknown document kind'));
    }
    if (!canCapture(actor)) {
      await logAudit(db(), {
        actorId: actor.id, action: 'recovery.scan_denied', entityType: 'case',
        entityId: id, ipAddress: request.ip, result: 'denied', details: { kind },
      });
      return reply
        .status(403)
        .send(apiError(ErrorCodes.FORBIDDEN, 'Your role cannot scan documents'));
    }
    const c = await loadScopedCase(db(), id, actor);
    if (!c) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
    }
    const data = await (request as any).file();
    if (!data) {
      return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'No file uploaded'));
    }
    if (!MIME_EXT[data.mimetype]) {
      return reply
        .status(415)
        .send(apiError(ErrorCodes.VALIDATION, 'Only JPEG, PNG, WebP, HEIC, and PDF scans are accepted'));
    }
    const doc = (await db().requiredDocument.findFirst({ where: { caseId: id, kind } })) as { id: string; status: string } | null;
    if (!doc) return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Document not found'));
    if (doc.status === 'approved') {
      return reply.status(409).send(apiError(ErrorCodes.CONFLICT, 'Document is already approved'));
    }

    let photo: Record<string, unknown>;
    try {
      photo = await storeUpload(db(), {
        storage: storage(),
        caseId: id,
        file: data.file,
        mimeType: data.mimetype,
        category: 'document_scan',
        caption: `Scan: ${kind}`,
        uploaderId: actor.id,
      });
    } catch (err) {
      request.log?.error?.(err);
      return reply.status(500).send(apiError(ErrorCodes.INTERNAL, 'Could not store the scan'));
    }

    const updated = await db().requiredDocument.update({
      where: { id: doc.id },
      data: { status: 'submitted', submittedById: actor.id, submittedAt: new Date(), rejectionNote: null },
    });
    // Office review queue alert: an unassigned review task on the case.
    const task = await db().task.create({
      data: {
        caseId: id,
        title: `REVIEW NEEDED — ${kind.replace(/_/g, ' ')} for ${c.caseNumber}`,
      },
    });
    await logAudit(db(), {
      actorId: actor.id, action: 'recovery.scan_submitted', entityType: 'case',
      entityId: id, ipAddress: request.ip, result: 'success',
      details: { kind, photoId: photo.id, reviewTaskId: (task as { id: string }).id },
    });
    reply.status(201);
    return { document: updated, photoId: photo.id };
  });
  /**
   * POST /cases/:id/documents/:kind/reject — manager sends a document back.
   * A note is required; the submitter gets a fix-and-resubmit task.
   */
  app.post(
    '/:id/documents/:kind/reject',
    { onRequest: requireRole('manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id, kind } = request.params as { id: string; kind: string };
      const body = rejectSchema.parse(request.body);
      if (!(DOCUMENT_KINDS as readonly string[]).includes(kind)) {
        return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'Unknown document kind'));
      }
      const c = (await db().case.findUnique({ where: { id } })) as Record<string, unknown> | null;
      if (!c) return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      const doc = (await db().requiredDocument.findFirst({ where: { caseId: id, kind } })) as { id: string; status: string; submittedById: string | null } | null;
      if (!doc) return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Document not found'));
      if (doc.status !== 'submitted') {
        return reply.status(409).send(apiError(ErrorCodes.CONFLICT, 'Only submitted documents can be rejected'));
      }
      const updated = await db().requiredDocument.update({
        where: { id: doc.id },
        data: { status: 'pending', rejectionNote: body.note.trim() },
      });
      // Notify the submitter: fix-and-resubmit task on the case.
      if (doc.submittedById) {
        await db().task.create({
          data: {
            caseId: id,
            assigneeId: doc.submittedById,
            title: `Fix & resubmit: ${kind.replace(/_/g, ' ')} (${c.caseNumber}) — ${body.note.trim().slice(0, 120)}`,
          },
        });
      }
      await logAudit(db(), {
        actorId: actor.id, action: 'case.document_rejected', entityType: 'case',
        entityId: id, ipAddress: request.ip, result: 'success',
        details: { kind, note: body.note.trim().slice(0, 200) },
      });
      return { document: updated };
    },
  );

  /**
   * POST /cases/:id/lot — record which storage lot the unit is in.
   * History is kept (rows are never overwritten).
   */
  app.post(
    '/:id/lot',
    { onRequest: requireRole('agent', 'transport_driver', 'manager', 'office_clerk') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const body = lotAssignSchema.parse(request.body) as LotAssignRequest;
      const c = await loadScopedCase(db(), id, actor);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      const lot = (await db().lot.findUnique({ where: { id: body.lotId } })) as { id: string; name: string } | null;
      if (!lot) return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Lot not found'));
      const assignment = await db().caseLotAssignment.create({
        data: { caseId: id, lotId: lot.id, assignedById: actor.id },
      });
      await db().caseStatusHistory.create({
        data: {
          caseId: id, from: c.status, to: c.status, actorId: actor.id,
          note: `Unit assigned to lot: ${lot.name}`,
        },
      });
      await logAudit(db(), {
        actorId: actor.id, action: 'recovery.lot_assigned', entityType: 'case',
        entityId: id, ipAddress: request.ip, result: 'success',
        details: { lotId: lot.id, lotName: lot.name },
      });
      reply.status(201);
      return { assignment };
    },
  );

  /** GET /cases/:id/lot — the unit's current lot (latest assignment). */
  app.get('/:id/lot', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const { id } = request.params as { id: string };
    const c = await loadScopedCase(db(), id, actor);
    if (!c) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
    }
    const rows = (await db().caseLotAssignment.findMany({
      where: { caseId: id },
      orderBy: { createdAt: 'desc' },
    })) as Array<Record<string, unknown>>;
    const latest = rows[0] ?? null;
    const lot = latest
      ? ((await db().lot.findUnique({ where: { id: latest.lotId } })) as Record<string, unknown> | null)
      : null;
    return {
      lot: lot ? { id: lot.id, name: lot.name, address: lot.address ?? null } : null,
      assignedAt: latest?.createdAt ?? null,
      history: rows.length,
    };
  });

  /**
   * POST /cases/:id/deliver — delivery confirmation. The delivery sheet
   * must already be approved (422 otherwise). Moves delivery -> invoicing
   * through the state machine and submits the delivery_confirmation
   * document, which unblocks the condition report send.
   */
  app.post(
    '/:id/deliver',
    { onRequest: requireRole('agent', 'transport_driver', 'manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const body = deliverSchema.parse(request.body) as DeliverRequest;
      const c = await loadScopedCase(db(), id, actor);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      const sheet = (await db().requiredDocument.findFirst({
        where: { caseId: id, kind: 'delivery_sheet' },
      })) as { status: string } | null;
      if (!sheet || sheet.status !== 'approved') {
        await logAudit(db(), {
          actorId: actor.id, action: 'recovery.deliver_denied', entityType: 'case',
          entityId: id, ipAddress: request.ip, result: 'denied',
          details: { reason: 'delivery_sheet not approved' },
        });
        return reply
          .status(422)
          .send(apiError(ErrorCodes.VALIDATION, 'Delivery sheet must be approved before confirming delivery'));
      }
      if (!isCaseStatus(c.status)) {
        return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'Unknown case status'));
      }
      const manager = actor.role === 'manager';
      if (!canTransition(c.status as CaseStatus, 'invoicing', manager)) {
        return reply
          .status(422)
          .send(apiError(ErrorCodes.VALIDATION, transitionError(c.status as CaseStatus, 'invoicing', manager)));
      }

      const confirmation = await db().deliveryConfirmation.create({
        data: {
          caseId: id,
          signedByName: body.signedByName.trim(),
          lat: body.lat ?? null,
          lng: body.lng ?? null,
        },
      });
      const doc = (await db().requiredDocument.findFirst({
        where: { caseId: id, kind: 'delivery_confirmation' },
      })) as { id: string } | null;
      if (doc) {
        await db().requiredDocument.update({
          where: { id: doc.id },
          data: { status: 'submitted', submittedById: actor.id, submittedAt: new Date(), rejectionNote: null },
        });
      }
      await db().case.update({ where: { id }, data: { status: 'invoicing' } });
      await db().caseStatusHistory.create({
        data: {
          caseId: id, from: c.status, to: 'invoicing', actorId: actor.id,
          note: `Delivered — signed by ${body.signedByName.trim()}`,
        },
      });
      await logAudit(db(), {
        actorId: actor.id, action: 'recovery.delivered', entityType: 'case',
        entityId: id, ipAddress: request.ip, result: 'success',
        details: { signedByName: body.signedByName.trim() },
      });
      reply.status(201);
      return { confirmation };
    },
  );

  /**
   * POST /cases/:id/condition-report — file the condition report body.
   * Marks the condition_report required document submitted.
   */
  app.post(
    '/:id/condition-report',
    { onRequest: requireRole('agent', 'manager', 'office_clerk') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const body = conditionReportSchema.parse(request.body);
      const c = await loadScopedCase(db(), id, actor);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      const report = await db().conditionReport.create({
        data: { caseId: id, sections: body.sections, submittedById: actor.id },
      });
      const doc = (await db().requiredDocument.findFirst({
        where: { caseId: id, kind: 'condition_report' },
      })) as { id: string; status: string } | null;
      if (doc && doc.status !== 'approved') {
        await db().requiredDocument.update({
          where: { id: doc.id },
          data: { status: 'submitted', submittedById: actor.id, submittedAt: new Date(), rejectionNote: null },
        });
      }
      await db().caseStatusHistory.create({
        data: { caseId: id, from: c.status, to: c.status, actorId: actor.id, note: 'Condition report filed' },
      });
      await logAudit(db(), {
        actorId: actor.id, action: 'recovery.condition_report_filed', entityType: 'case',
        entityId: id, ipAddress: request.ip, result: 'success', details: {},
      });
      reply.status(201);
      return { report };
    },
  );

  /** GET /cases/:id/condition-report — latest filed condition report. */
  app.get('/:id/condition-report', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const { id } = request.params as { id: string };
    const c = await loadScopedCase(db(), id, actor);
    if (!c) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
    }
    const rows = (await db().conditionReport.findMany({
      where: { caseId: id },
      orderBy: { createdAt: 'desc' },
    })) as Array<Record<string, unknown>>;
    return { report: rows[0] ?? null };
  });

  /**
   * POST /cases/:id/inspection — structured in-depth inspection checklist
   * (tires, brakes, airlines, reefer unit, custom upfits, ...).
   */
  app.post('/:id/inspection', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const { id } = request.params as { id: string };
    const body = inspectionSchema.parse(request.body);
    if (!canCapture(actor)) {
      await logAudit(db(), {
        actorId: actor.id, action: 'recovery.inspection_denied', entityType: 'case',
        entityId: id, ipAddress: request.ip, result: 'denied', details: {},
      });
      return reply
        .status(403)
        .send(apiError(ErrorCodes.FORBIDDEN, 'Your role cannot file inspections'));
    }
    const c = await loadScopedCase(db(), id, actor);
    if (!c) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
    }
    const checklist = await db().inspectionChecklist.create({
      data: { caseId: id, assetType: body.assetType, items: body.items, inspectorId: actor.id },
    });
    await db().caseStatusHistory.create({
      data: {
        caseId: id, from: c.status, to: c.status, actorId: actor.id,
        note: `Inspection filed (${body.assetType}, ${body.items.length} items)`,
      },
    });
    await logAudit(db(), {
      actorId: actor.id, action: 'recovery.inspection_filed', entityType: 'case',
      entityId: id, ipAddress: request.ip, result: 'success',
      details: { assetType: body.assetType, itemCount: body.items.length },
    });
    reply.status(201);
    return { checklist };
  });

  /** GET /cases/:id/inspection — latest inspection checklist. */
  app.get('/:id/inspection', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const { id } = request.params as { id: string };
    const c = await loadScopedCase(db(), id, actor);
    if (!c) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
    }
    const rows = (await db().inspectionChecklist.findMany({
      where: { caseId: id },
      orderBy: { createdAt: 'desc' },
    })) as Array<Record<string, unknown>>;
    return { checklist: rows[0] ?? null };
  });

  /**
   * POST /cases/:id/invoice — create the invoice, but ONLY when the billing
   * gate passes (photos + delivery sheet + condition report approved).
   * Approval itself stays on the manager-only document approval endpoint.
   */
  app.post(
    '/:id/invoice',
    { onRequest: requireRole('manager', 'office_clerk') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const body = invoiceSchema.parse(request.body) as InvoiceRequest;
      const c = await loadScopedCase(db(), id, actor);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      const gate = await billingEligibility(db(), id);
      if (!gate.unlocked) {
        await logAudit(db(), {
          actorId: actor.id, action: 'recovery.invoice_gate_blocked', entityType: 'case',
          entityId: id, ipAddress: request.ip, result: 'denied', details: { missing: gate.missing },
        });
        return reply.status(409).send(
          apiError(ErrorCodes.CONFLICT, `Invoice blocked: still missing ${gate.missing.join(', ')}`),
        );
      }
      let invoiceNumber = body.invoiceNumber?.trim();
      if (invoiceNumber) {
        const clash = (await db().invoice.findUnique({ where: { invoiceNumber } })) as unknown;
        if (clash) return reply.status(409).send(apiError(ErrorCodes.CONFLICT, 'Invoice number already exists'));
      } else {
        invoiceNumber = `INV-${String(c.caseNumber).replace(/[^A-Z0-9]/gi, '').slice(0, 12)}-${Date.now().toString(36).toUpperCase()}`;
      }
      const invoice = await db().invoice.create({
        data: { caseId: id, invoiceNumber, amount: body.amount ?? null, status: 'pending', createdById: actor.id },
      });
      const doc = (await db().requiredDocument.findFirst({
        where: { caseId: id, kind: 'invoice' },
      })) as { id: string; status: string } | null;
      if (doc && doc.status !== 'approved') {
        await db().requiredDocument.update({
          where: { id: doc.id },
          data: { status: 'submitted', submittedById: actor.id, submittedAt: new Date(), rejectionNote: null },
        });
      }
      await db().caseStatusHistory.create({
        data: {
          caseId: id, from: c.status, to: c.status, actorId: actor.id,
          note: `Invoice ${invoiceNumber} created (pending approval)`,
        },
      });
      await logAudit(db(), {
        actorId: actor.id, action: 'recovery.invoice_created', entityType: 'case',
        entityId: id, ipAddress: request.ip, result: 'success',
        details: { invoiceNumber },
      });
      reply.status(201);
      return { invoice };
    },
  );

  /** GET /cases/:id/invoices — invoices on a case. */
  app.get('/:id/invoices', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const { id } = request.params as { id: string };
    const c = await loadScopedCase(db(), id, actor);
    if (!c) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
    }
    const invoices = (await db().invoice.findMany({
      where: { caseId: id },
      orderBy: { createdAt: 'desc' },
    })) as Array<Record<string, unknown>>;
    return { invoices };
  });
}


// ---------------------------------------------------------------------------
// Review queue — mounted at the API root (GET /review-queue), not /cases.
// ---------------------------------------------------------------------------

export async function reviewQueueRoutes(app: FastifyInstance): Promise<void> {
  const db = () => app.db;


  /**
   * GET /review-queue — office view of every submitted-but-unapproved
   * document across cases. Manager + office clerk only. No debtor PII.
   */
  app.get(
    '/review-queue',
    { onRequest: requireRole('manager', 'office_clerk') },
    async (request: FastifyRequest) => {
      const docs = (await db().requiredDocument.findMany({
        where: { status: 'submitted' },
        orderBy: { submittedAt: 'asc' },
      })) as Array<Record<string, unknown>>;
      const items = [];
      for (const d of docs) {
        const c = (await db().case.findUnique({ where: { id: d.caseId } })) as Record<string, unknown> | null;
        if (!c) continue;
        const client = c.clientId
          ? ((await db().client.findUnique({ where: { id: c.clientId } })) as Record<string, unknown> | null)
          : null;
        const submitter = d.submittedById
          ? ((await db().user.findUnique({ where: { id: d.submittedById } })) as Record<string, unknown> | null)
          : null;
        items.push({
          documentId: d.id,
          kind: d.kind,
          caseId: c.id,
          caseNumber: c.caseNumber,
          caseStatus: c.status,
          clientName: client?.name ?? null,
          submittedByName: submitter?.name ?? null,
          submittedAt: d.submittedAt ?? null,
        });
      }
      return { queue: items };
    },
  );

}