import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CONVERSATION_KINDS,
  type AuthenticatedUser,
  type AvailabilityRecord,
  type ConversationRecord,
  type DirectoryContactRecord,
  type MessageRecord,
  type TimeOffRecord,
  type WeeklyReport,
} from '@repo/shared';
import type { DbClient } from '../db.js';
import { logAudit } from '../lib/audit.js';
import { requireRole } from '../middleware/guards.js';
import { StorageNotFoundError } from '../lib/storage.js';
import { ErrorCodes, apiError } from '../errors.js';

/**
 * Phase 5 — company operations.
 *
 * In-app messaging (direct + company-wide), a shared contact directory, and
 * the time-off calendar feeding dispatch availability. Access rides on the
 * global auth hook: suspended/revoked users 401 on every request, so they
 * lose messaging, directory, and dispatch access immediately.
 */

const CONVERSATION_KIND_DIRECT = 'direct';
const CONVERSATION_KIND_WIDE = 'company_wide';
const COMPANY_CHANNEL_TITLE = 'Company wide';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const conversationSchema = z.object({
  kind: z.enum(CONVERSATION_KINDS as unknown as [string, ...string[]]),
  title: z.string().max(120).optional(),
  memberIds: z.array(z.string().min(1)).max(50).optional(),
});

const messageSchema = z.object({
  body: z.string().min(1).max(4000),
  attachmentRefs: z
    .array(
      z.object({
        ref: z.string().min(1).max(80),
        name: z.string().max(160).optional(),
        mimeType: z.string().max(80).optional(),
      }),
    )
    .max(10)
    .optional(),
});

const directorySchema = z.object({
  name: z.string().min(1).max(160),
  company: z.string().max(160).optional(),
  role: z.string().max(80).optional(),
  phone: z.string().max(32).optional(),
  email: z.string().email().max(254).optional(),
  notes: z.string().max(1000).optional(),
});

const timeOffSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be YYYY-MM-DD'),
  reason: z.string().max(1000).optional(),
});

const decisionSchema = z.object({
  note: z.string().max(1000).optional(),
});

/** Upload allowlist for message attachments (photos + short video clips). */
const UPLOAD_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

const isManager = (request: FastifyRequest) => request.authUser!.role === 'manager';

/**
 * Can this user read/post in this conversation?
 * - company_wide: every active user (the auth hook already guarantees the
 *   caller is active, so suspended staff are excluded automatically).
 * - direct: must hold a ConversationMember row.
 */
async function canAccessConversation(
  db: DbClient,
  conversationId: string,
  user: AuthenticatedUser,
): Promise<Row | null> {
  const conv = (await db.conversation.findUnique({
    where: { id: conversationId },
  })) as Row | null;
  if (!conv) return null;
  if (conv.kind === CONVERSATION_KIND_WIDE) return conv;
  // findMany + [0]: equivalent to the compound unique lookup, and it works
  // against the in-memory test stub as well as Prisma.
  const members = (await db.conversationMember.findMany({
    where: { conversationId, userId: user.id },
  })) as Array<Row>;
  return members[0] ? conv : null;
}

/** Sender display info for messages (best effort against the stub DB too). */
async function senderInfo(
  db: DbClient,
  senderIds: string[],
): Promise<Map<string, { name: string; role: string | null }>> {
  const map = new Map<string, { name: string; role: string | null }>();
  if (senderIds.length === 0) return map;
  const roleNames = await roleNameMap(db);
  const users = (await db.user.findMany({
    where: { id: { in: senderIds } },
  })) as Array<Row>;
  for (const u of users) {
    map.set(String(u.id), { name: String(u.name ?? 'Unknown'), role: userRoleName(u, roleNames) });
  }
  return map;
}

/**
 * Resolve a user's role NAME. Routes intentionally avoid `include: { role }`
 * so they work identically against real Prisma and the test stub: the role
 * name always comes from the Role table via roleId.
 */
async function roleNameMap(db: DbClient): Promise<Map<string, string>> {
  const roles = (await db.role.findMany({})) as Array<Row>;
  return new Map(roles.map((r) => [String(r.id), String(r.name)]));
}

function userRoleName(u: Row, roleNames: Map<string, string>): string {
  return roleNames.get(String(u.roleId)) ?? '';
}

function serializeMessage(row: Row, senders: Map<string, { name: string; role: string | null }>): MessageRecord {
  const s = senders.get(String(row.senderId));
  return {
    id: String(row.id),
    conversationId: String(row.conversationId),
    senderId: String(row.senderId),
    senderName: s?.name ?? 'Unknown',
    senderRole: s?.role ?? null,
    body: String(row.body),
    attachmentRefs: (row.attachmentRefs as MessageRecord['attachmentRefs']) ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

/** Monday 00:00 UTC of the current week. */
function weekStartUtc(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
  return d;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function companyRoutes(app: FastifyInstance): Promise<void> {
  const db = () => app.db;
  const storage = () => app.storage;

  // ------------------------------------------------------------------
  // Messaging
  // ------------------------------------------------------------------

  /**
   * GET /conversations — mine: direct conversations I'm a member of, plus
   * the company-wide channel (always visible to active users).
   */
  app.get('/conversations', async (request: FastifyRequest) => {
    const actor = request.authUser!;
    const memberships = (await db().conversationMember.findMany({
      where: { userId: actor.id },
    })) as Array<Row>;
    const memberIds = new Set(memberships.map((m) => String(m.conversationId)));
    const convs = (await db().conversation.findMany({
      orderBy: { createdAt: 'desc' },
    })) as Array<Row>;
    const mine = convs.filter(
      (c) => c.kind === CONVERSATION_KIND_WIDE || memberIds.has(String(c.id)),
    );
    const out: ConversationRecord[] = [];
    for (const c of mine) {
      const msgs = (await db().message.findMany({
        where: { conversationId: c.id },
        orderBy: { createdAt: 'desc' },
      })) as Array<Row>;
      const last = msgs[0] ?? null;
      let memberCount = 0;
      if (c.kind === CONVERSATION_KIND_WIDE) {
        memberCount = (await db().user.findMany({ where: { status: 'active' } })).length;
      } else {
        memberCount = (
          (await db().conversationMember.findMany({ where: { conversationId: c.id } })) as Array<Row>
        ).length;
      }
      out.push({
        id: String(c.id),
        kind: c.kind as ConversationRecord['kind'],
        title: (c.title as string | null) ?? null,
        memberCount,
        lastMessageAt: last
          ? last.createdAt instanceof Date
            ? last.createdAt.toISOString()
            : String(last.createdAt)
          : null,
        lastMessagePreview: last ? String(last.body).slice(0, 80) : null,
      });
    }
    return { conversations: out };
  });

  /**
   * POST /conversations — create a direct conversation, or ensure the
   * single company-wide channel exists (idempotent singleton).
   */
  app.post('/conversations', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const body = conversationSchema.parse(request.body);

    if (body.kind === CONVERSATION_KIND_WIDE) {
      const existing = (await db().conversation.findMany({
        where: { kind: CONVERSATION_KIND_WIDE },
      })) as Array<Row>;
      if (existing[0]) {
        return {
          conversation: {
            id: String(existing[0].id),
            kind: CONVERSATION_KIND_WIDE,
            title: (existing[0].title as string | null) ?? null,
          },
        };
      }
      const created = (await db().conversation.create({
        data: { kind: CONVERSATION_KIND_WIDE, title: COMPANY_CHANNEL_TITLE, createdById: actor.id },
      })) as Row;
      await logAudit(db(), {
        actorId: actor.id, action: 'company.channel_created', entityType: 'conversation',
        entityId: created.id, ipAddress: request.ip, result: 'success', details: {},
      });
      reply.status(201);
      return {
        conversation: { id: String(created.id), kind: CONVERSATION_KIND_WIDE, title: COMPANY_CHANNEL_TITLE },
      };
    }

    // Direct: memberIds required, must be active users, creator auto-joined.
    const memberIds = [...new Set((body.memberIds ?? []).filter((id) => id !== actor.id))];
    if (memberIds.length === 0) {
      return reply
        .status(400)
        .send(apiError(ErrorCodes.VALIDATION, 'memberIds is required for a direct conversation'));
    }
    const users = (await db().user.findMany({ where: { id: { in: memberIds } } })) as Array<Row>;
    const activeIds = new Set(
      users.filter((u) => u.status === 'active').map((u) => String(u.id)),
    );
    const bad = memberIds.filter((id) => !activeIds.has(id));
    if (bad.length > 0) {
      return reply
        .status(400)
        .send(apiError(ErrorCodes.VALIDATION, 'Every member must be an active user'));
    }
    const created = (await db().conversation.create({
      data: { kind: CONVERSATION_KIND_DIRECT, title: body.title ?? null, createdById: actor.id },
    })) as Row;
    for (const id of [actor.id, ...memberIds]) {
      await db().conversationMember.create({
        data: { conversationId: created.id, userId: id },
      });
    }
    await logAudit(db(), {
      actorId: actor.id, action: 'company.conversation_created', entityType: 'conversation',
      entityId: created.id, ipAddress: request.ip, result: 'success',
      details: { kind: CONVERSATION_KIND_DIRECT, memberCount: memberIds.length + 1 },
    });
    reply.status(201);
    return {
      conversation: {
        id: String(created.id),
        kind: CONVERSATION_KIND_DIRECT,
        title: (created.title as string | null) ?? null,
        memberCount: memberIds.length + 1,
      },
    };
  });

  /**
   * GET /conversations/:id/messages — latest first, ?limit=&before=.
   * Non-members get 404 (never 403) on direct conversations.
   */
  app.get('/conversations/:id/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const { id } = request.params as { id: string };
    const conv = await canAccessConversation(db(), id, actor);
    if (!conv) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Conversation not found'));
    }
    const query = request.query as { limit?: string; before?: string };
    const limit = Math.min(Math.max(parseInt(query.limit ?? '50', 10) || 50, 1), 200);
    let cursor: Date | null = null;
    if (query.before) {
      const beforeMsg = (await db().message.findUnique({ where: { id: query.before } })) as Row | null;
      if (!beforeMsg || String(beforeMsg.conversationId) !== id) {
        return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'Unknown message cursor'));
      }
      cursor = beforeMsg.createdAt instanceof Date ? beforeMsg.createdAt : new Date(beforeMsg.createdAt);
    }
    const all = (await db().message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'desc' },
    })) as Array<Row>;
    const page = all
      .filter((m) => {
        if (!cursor) return true;
        const t = m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt);
        return t < cursor;
      })
      .slice(0, limit);
    const senders = await senderInfo(db(), [...new Set(page.map((m) => String(m.senderId)))]);
    return {
      messages: page.map((m) => serializeMessage(m, senders)),
      nextBefore: page.length === limit ? String(page[page.length - 1].id) : null,
    };
  });

  /**
   * POST /conversations/:id/messages — send. The audit row records the
   * send EVENT (message id), never the body.
   */
  app.post('/conversations/:id/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const { id } = request.params as { id: string };
    const conv = await canAccessConversation(db(), id, actor);
    if (!conv) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Conversation not found'));
    }
    const body = messageSchema.parse(request.body);
    // Attachment refs must look like stored upload refs (uuid.ext).
    if (body.attachmentRefs) {
      for (const a of body.attachmentRefs) {
        if (!/^[0-9a-f-]{8,}\.[a-z0-9]{2,4}$/i.test(a.ref)) {
          return reply
            .status(400)
            .send(apiError(ErrorCodes.VALIDATION, 'attachmentRefs must come from POST /uploads'));
        }
      }
    }
    const created = (await db().message.create({
      data: {
        conversationId: id,
        senderId: actor.id,
        body: body.body.trim(),
        attachmentRefs: body.attachmentRefs ?? undefined,
      },
    })) as Row;
    await logAudit(db(), {
      actorId: actor.id, action: 'company.message_sent', entityType: 'conversation',
      entityId: id, ipAddress: request.ip, result: 'success',
      details: { messageId: created.id }, // never the body
    });
    const senders = await senderInfo(db(), [actor.id]);
    reply.status(201);
    return { message: serializeMessage(created, senders) };
  });

  // ------------------------------------------------------------------
  // Uploads (message attachments — photos / short video clips)
  // ------------------------------------------------------------------

  /**
   * POST /uploads — one file per request; returns a ref to pass as a
   * message attachmentRef. Extension comes from the validated mime type,
   * never the client filename. Files live under the `msg/` key prefix in
   * the configured storage backend (local disk or S3/R2).
   */
  app.post('/uploads', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const data = await (request as any).file();
    if (!data) {
      return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'No file uploaded'));
    }
    const ext = UPLOAD_MIME_EXT[data.mimetype as string];
    if (!ext) {
      return reply
        .status(415)
        .send(apiError(ErrorCodes.VALIDATION, 'Only JPEG, PNG, WebP, HEIC, PDF, MP4, and MOV uploads are accepted'));
    }
    const fileName = `${randomUUID()}.${ext}`;
    const key = `msg/${fileName}`;
    try {
      await storage().put(key, data.file, data.mimetype);
    } catch {
      return reply.status(500).send(apiError(ErrorCodes.INTERNAL, 'Could not store the upload'));
    }
    await logAudit(db(), {
      actorId: actor.id, action: 'company.upload_added', entityType: 'upload',
      entityId: fileName, ipAddress: request.ip, result: 'success',
      details: { mimeType: data.mimetype },
    });
    reply.status(201);
    return { upload: { ref: fileName, mimeType: data.mimetype } };
  });

  /**
   * GET /uploads/:ref — serve a stored attachment (any active user).
   * Bytes are read back through the storage backend; the key never
   * leaves the server and no public URL is ever minted.
   */
  app.get('/uploads/:ref', async (request: FastifyRequest, reply: FastifyReply) => {
    const { ref } = request.params as { ref: string };
    if (!/^[0-9a-f-]{8,}\.[a-z0-9]{2,4}$/i.test(ref)) {
      return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'Unknown upload'));
    }
    const ext = ref.split('.').pop()!.toLowerCase();
    const mime = Object.entries(UPLOAD_MIME_EXT).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
    try {
      const bytes = await storage().get(`msg/${ref}`);
      return reply.header('Content-Type', mime).send(bytes);
    } catch (err) {
      if (err instanceof StorageNotFoundError) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Upload not found'));
      }
      throw err;
    }
  });

  // ------------------------------------------------------------------
  // Shared contact directory
  // ------------------------------------------------------------------

  /**
   * GET /directory?q= — the shared company directory. Every active user can
   * read it (that's what makes it a company directory). If per-field
   * gating is ever needed, add a 'directory' entity to the permission
   * matrix and filter through it here.
   */
  app.get('/directory', async (request: FastifyRequest) => {
    const query = request.query as { q?: string };
    const q = (query.q ?? '').trim().toLowerCase();
    const all = (await db().directoryContact.findMany({
      orderBy: { name: 'asc' },
    })) as Array<Row>;
    const users = (await db().user.findMany({})) as Array<Row>;
    const names = new Map(users.map((u) => [String(u.id), String(u.name)]));
    const hits = (q
      ? all.filter((c) =>
          [c.name, c.company, c.role].some((v) =>
            String(v ?? '').toLowerCase().includes(q),
          ),
        )
      : all
    ).slice(0, 200);
    const contacts: DirectoryContactRecord[] = hits.map((c) => ({
      id: String(c.id),
      name: String(c.name),
      company: (c.company as string | null) ?? null,
      role: (c.role as string | null) ?? null,
      phone: (c.phone as string | null) ?? null,
      email: (c.email as string | null) ?? null,
      notes: (c.notes as string | null) ?? null,
      addedByName: names.get(String(c.addedById)) ?? null,
    }));
    return { contacts };
  });

  /** POST /directory — anyone in the company can add a contact. */
  app.post('/directory', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const body = directorySchema.parse(request.body);
    const created = (await db().directoryContact.create({
      data: {
        name: body.name.trim(),
        company: body.company?.trim() || null,
        role: body.role?.trim() || null,
        phone: body.phone?.trim() || null,
        email: body.email?.trim() || null,
        notes: body.notes?.trim() || null,
        addedById: actor.id,
      },
    })) as Row;
    await logAudit(db(), {
      actorId: actor.id, action: 'company.directory_added', entityType: 'directoryContact',
      entityId: created.id, ipAddress: request.ip, result: 'success',
      details: { name: created.name },
    });
    reply.status(201);
    return { contact: { id: String(created.id), name: String(created.name) } };
  });

  /**
   * PATCH /directory/:id — the adder or a manager may edit.
   * DELETE /directory/:id — the adder or a manager may remove.
   */
  async function loadOwnedContact(
    dbClient: DbClient,
    id: string,
    user: AuthenticatedUser,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Row | null> {
    const contact = (await dbClient.directoryContact.findUnique({
      where: { id },
    })) as Row | null;
    if (!contact) {
      reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Contact not found'));
      return null;
    }
    if (String(contact.addedById) !== user.id && user.role !== 'manager') {
      await logAudit(dbClient, {
        actorId: user.id, action: 'company.directory_denied', entityType: 'directoryContact',
        entityId: id, ipAddress: request.ip, result: 'denied', details: {},
      });
      reply.status(403).send(apiError(ErrorCodes.FORBIDDEN, 'Only the adder or a manager can change this contact'));
      return null;
    }
    return contact;
  }

  app.patch('/directory/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const { id } = request.params as { id: string };
    const contact = await loadOwnedContact(db(), id, actor, request, reply);
    if (!contact) return;
    const body = directorySchema.partial().parse(request.body);
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      data[k] = typeof v === 'string' ? v.trim() || null : v;
    }
    const updated = (await db().directoryContact.update({ where: { id }, data })) as Row;
    await logAudit(db(), {
      actorId: actor.id, action: 'company.directory_updated', entityType: 'directoryContact',
      entityId: id, ipAddress: request.ip, result: 'success', details: {},
    });
    return { contact: { id: String(updated.id), name: String(updated.name) } };
  });

  app.delete('/directory/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const { id } = request.params as { id: string };
    const contact = await loadOwnedContact(db(), id, actor, request, reply);
    if (!contact) return;
    await db().directoryContact.delete({ where: { id } });
    await logAudit(db(), {
      actorId: actor.id, action: 'company.directory_deleted', entityType: 'directoryContact',
      entityId: id, ipAddress: request.ip, result: 'success',
      details: { name: contact.name },
    });
    return { deleted: true };
  });

  // ------------------------------------------------------------------
  // Time off
  // ------------------------------------------------------------------

  /** POST /time-off — request time off (for yourself). */
  app.post('/time-off', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser!;
    const body = timeOffSchema.parse(request.body);
    const start = new Date(`${body.startDate}T00:00:00Z`);
    const end = new Date(`${body.endDate}T23:59:59Z`);
    if (start > end) {
      return reply
        .status(400)
        .send(apiError(ErrorCodes.VALIDATION, 'startDate must be on or before endDate'));
    }
    const created = (await db().timeOffRequest.create({
      data: {
        userId: actor.id,
        startDate: start,
        endDate: end,
        reason: body.reason?.trim() || null,
        status: 'pending',
      },
    })) as Row;
    await logAudit(db(), {
      actorId: actor.id, action: 'company.timeoff_requested', entityType: 'timeOffRequest',
      entityId: created.id, ipAddress: request.ip, result: 'success',
      details: { startDate: body.startDate, endDate: body.endDate },
    });
    reply.status(201);
    return { request: { id: String(created.id), status: 'pending' } };
  });

  /**
   * GET /time-off — your own requests; managers see everyone's
   * (?status=pending|approved|denied, ?userId=).
   */
  app.get('/time-off', async (request: FastifyRequest) => {
    const actor = request.authUser!;
    const query = request.query as { status?: string; userId?: string };
    const where: Record<string, unknown> = isManager(request) ? {} : { userId: actor.id };
    if (query.status) {
      if (!['pending', 'approved', 'denied'].includes(query.status)) {
        throw Object.assign(new Error('Unknown status filter'), { statusCode: 400 });
      }
      where.status = query.status;
    }
    if (query.userId && isManager(request)) where.userId = query.userId;
    const rows = (await db().timeOffRequest.findMany({
      where,
      orderBy: { startDate: 'asc' },
    })) as Array<Row>;
    const users = (await db().user.findMany({})) as Array<Row>;
    const names = new Map(users.map((u) => [String(u.id), String(u.name)]));
    const requests: TimeOffRecord[] = rows.map((r) => ({
      id: String(r.id),
      userId: String(r.userId),
      userName: names.get(String(r.userId)) ?? null,
      startDate: (r.startDate as Date).toISOString().slice(0, 10),
      endDate: (r.endDate as Date).toISOString().slice(0, 10),
      reason: (r.reason as string | null) ?? null,
      status: r.status as TimeOffRecord['status'],
      decidedByName: r.decidedById ? names.get(String(r.decidedById)) ?? null : null,
      decidedAt: r.decidedAt ? (r.decidedAt as Date).toISOString() : null,
      decisionNote: (r.decisionNote as string | null) ?? null,
    }));
    return { requests };
  });

  /** Manager decides a pending request. */
  async function decideTimeOff(
    request: FastifyRequest,
    reply: FastifyReply,
    approve: boolean,
  ) {
    const actor = request.authUser!;
    const { id } = request.params as { id: string };
    const { note } = decisionSchema.parse(request.body ?? {});
    const row = (await db().timeOffRequest.findUnique({ where: { id } })) as Row | null;
    if (!row) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Time-off request not found'));
    }
    if (row.status !== 'pending') {
      return reply
        .status(409)
        .send(apiError(ErrorCodes.CONFLICT, `Request is already ${row.status}`));
    }
    const updated = (await db().timeOffRequest.update({
      where: { id },
      data: {
        status: approve ? 'approved' : 'denied',
        decidedById: actor.id,
        decidedAt: new Date(),
        decisionNote: note?.trim() || null,
      },
    })) as Row;
    await logAudit(db(), {
      actorId: actor.id, action: approve ? 'company.timeoff_approved' : 'company.timeoff_denied',
      entityType: 'timeOffRequest', entityId: id, ipAddress: request.ip, result: 'success',
      details: { userId: row.userId },
    });
    return { request: { id: String(updated.id), status: String(updated.status) } };
  }

  app.post(
    '/time-off/:id/approve',
    { onRequest: requireRole('manager') },
    async (request: FastifyRequest, reply: FastifyReply) => decideTimeOff(request, reply, true),
  );
  app.post(
    '/time-off/:id/deny',
    { onRequest: requireRole('manager') },
    async (request: FastifyRequest, reply: FastifyReply) => decideTimeOff(request, reply, false),
  );

  // ------------------------------------------------------------------
  // Dispatch availability
  // ------------------------------------------------------------------

  /**
   * GET /dispatch/availability?date=YYYY-MM-DD — active agents and drivers
   * who are NOT on approved time off that day. Feeds the assignment UI.
   */
  app.get(
    '/dispatch/availability',
    { onRequest: requireRole('office_clerk', 'manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { date?: string };
      if (!query.date || !/^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
        return reply
          .status(400)
          .send(apiError(ErrorCodes.VALIDATION, 'date is required as YYYY-MM-DD'));
      }
      const dayStart = new Date(`${query.date}T00:00:00Z`);
      const dayEnd = new Date(`${query.date}T23:59:59Z`);
      const staff = (await db().user.findMany({
        where: { status: 'active' },
      })) as Array<Row>;
      const roleNames = await roleNameMap(db());
      const field = staff.filter((u) => {
        const roleName = userRoleName(u, roleNames);
        return roleName === 'agent' || roleName === 'transport_driver';
      });
      const off = (await db().timeOffRequest.findMany({
        where: { status: 'approved' },
      })) as Array<Row>;
      const offIds = new Set(
        off
          .filter((r) => {
            const s = r.startDate as Date;
            const e = r.endDate as Date;
            return s <= dayEnd && e >= dayStart;
          })
          .map((r) => String(r.userId)),
      );
      const available: AvailabilityRecord[] = field
        .filter((u) => !offIds.has(String(u.id)))
        .map((u) => ({
          userId: String(u.id),
          name: String(u.name),
          role: userRoleName(u, roleNames),
          phone: (u.phone as string | null) ?? null,
        }));
      return { date: query.date, available };
    },
  );

  // ------------------------------------------------------------------
  // Weekly report (manager only)
  // ------------------------------------------------------------------

  /**
   * GET /reports/week — this week's numbers: cases by status, possessions,
   * deliveries, invoices created/approved, average intake→possession days,
   * and per-agent counts. Computed from existing tables; no new models.
   */
  app.get(
    '/reports/week',
    { onRequest: requireRole('manager') },
    async (request: FastifyRequest) => {
      const now = new Date();
      const start = weekStartUtc(now);

      const cases = (await db().case.findMany({})) as Array<Row>;
      const casesByStatus: Record<string, number> = {};
      for (const c of cases) {
        const s = String(c.status);
        casesByStatus[s] = (casesByStatus[s] ?? 0) + 1;
      }

      const history = (await db().caseStatusHistory.findMany({})) as Array<Row>;
      const inWeek = (r: Row) => {
        const t = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
        return t >= start;
      };
      const weekHistory = history.filter(inWeek);
      const possessions = weekHistory.filter((r) => r.to === 'possession').length;
      const deliveries = weekHistory.filter((r) => r.to === 'delivery').length;

      const invoices = (await db().invoice.findMany({})) as Array<Row>;
      const invCreatedAt = (r: Row) =>
        r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
      const invoicesCreated = invoices.filter((r) => invCreatedAt(r) >= start).length;
      // No approvedAt column; an approved invoice updated this week counts.
      const invoicesApproved = invoices.filter((r) => {
        const u = r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt);
        return r.status === 'approved' && u >= start;
      }).length;

      const caseById = new Map(cases.map((c) => [String(c.id), c]));
      const possessionRows = weekHistory.filter((r) => r.to === 'possession');
      const dayDiffs: number[] = [];
      for (const r of possessionRows) {
        const c = caseById.get(String(r.caseId));
        if (!c) continue;
        const created = c.createdAt instanceof Date ? c.createdAt : new Date(c.createdAt);
        const took = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
        dayDiffs.push((took.getTime() - created.getTime()) / 86_400_000);
      }
      const avgDaysIntakeToPossession =
        dayDiffs.length > 0
          ? Math.round((dayDiffs.reduce((a, b) => a + b, 0) / dayDiffs.length) * 10) / 10
          : null;

      const users = (await db().user.findMany({ where: { status: 'active' } })) as Array<Row>;
      const roleNames = await roleNameMap(db());
      const agents = users.filter((u) => userRoleName(u, roleNames) === 'agent');
      const perAgent = agents.map((a) => {
        const aid = String(a.id);
        const assignedCases = cases.filter(
          (c) => String(c.assignedAgentId) === aid && !['closed', 'cancelled'].includes(String(c.status)),
        ).length;
        const agentPossessions = weekHistory.filter(
          (r) => r.to === 'possession' && String(r.actorId) === aid,
        ).length;
        return { agentId: aid, agentName: String(a.name), assignedCases, possessions: agentPossessions };
      });

      const report: WeeklyReport = {
        weekStart: start.toISOString().slice(0, 10),
        casesByStatus,
        possessions,
        deliveries,
        invoicesCreated,
        invoicesApproved,
        avgDaysIntakeToPossession,
        perAgent,
      };
      return { report };
    },
  );
}
