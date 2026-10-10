import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type AuthenticatedUser,
  type CaseStatus,
  type CheckInRequest,
  type FieldAddress,
  type FieldAssignment,
  type FieldNoteRequest,
  type PossessionRequest,
} from '@repo/shared';
import type { DbClient } from '../db.js';
import { logAudit } from '../lib/audit.js';
import { filterFields } from '../lib/permissions.js';
import { requireRole } from '../middleware/guards.js';
import {
  TERMINAL_STATUSES,
  canTransition,
  isCaseStatus,
  transitionError,
} from '../lib/case-status.js';
import { ErrorCodes, apiError } from '../errors.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const coordSchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

const checkInSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  note: z.string().max(500).optional(),
});

const noteSchema = z.object({
  text: z.string().min(1).max(2000),
});

const possessionSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CaseRow = Record<string, any>;

const FIELD_INCLUDE = {
  debtor: true,
  asset: true,
  client: true,
  lender: true,
  assignedAgent: { select: { id: true, name: true } },
  addresses: true,
} as const;

/** Load a case only when it is assigned to this user. Null otherwise (→404). */
async function loadAssignedCase(
  db: DbClient,
  id: string,
  userId: string,
): Promise<CaseRow | null> {
  const c = (await db.case.findUnique({
    where: { id },
    include: FIELD_INCLUDE,
  })) as CaseRow | null;
  if (!c || c.assignedAgentId !== userId) return null;
  return c;
}

/**
 * Serialize a case for the field workspace. Debtor PII is filtered through
 * the manager-editable matrix (default-deny); everything else on the card
 * is operational data the agent needs in the field.
 */
function serializeFieldCase(user: AuthenticatedUser, c: CaseRow): Record<string, unknown> {
  const asset = c.asset
    ? {
        vin: (c.asset as Record<string, unknown>).vin,
        year: (c.asset as Record<string, unknown>).year ?? null,
        make: (c.asset as Record<string, unknown>).make ?? null,
        model: (c.asset as Record<string, unknown>).model ?? null,
        color: (c.asset as Record<string, unknown>).color ?? null,
        plate: (c.asset as Record<string, unknown>).plate ?? null,
      }
    : null;
  const debtor = c.debtor
    ? filterFields(user.grants, 'debtor', 'read', c.debtor as Record<string, unknown>)
    : null;
  const addresses: FieldAddress[] = ((c.addresses ?? []) as Array<Record<string, unknown>>).map(
    (a) => ({
      id: String(a.id),
      label: String(a.label ?? 'given'),
      street: String(a.street),
      city: (a.city as string | null) ?? null,
      state: (a.state as string | null) ?? null,
      zip: (a.zip as string | null) ?? null,
      lat: (a.lat as number | null) ?? null,
      lng: (a.lng as number | null) ?? null,
    }),
  );
  return {
    id: c.id,
    caseNumber: c.caseNumber,
    status: c.status,
    priority: c.priority,
    asset,
    debtor,
    client: c.client ?? null,
    lender: c.lender ? { id: (c.lender as Record<string, unknown>).id, name: (c.lender as Record<string, unknown>).name } : null,
    addresses,
  };
}

/** Great-circle distance in meters. Pure. */
export function haversineMeters(
  latA: number,
  lngA: number,
  latB: number,
  lngB: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(latB - latA);
  const dLng = toRad(lngB - lngA);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Closest geocoded address distance, or null when the case has none. */
function caseDistanceMeters(c: CaseRow, lat: number, lng: number): number | null {
  let best: number | null = null;
  for (const a of (c.addresses ?? []) as Array<Record<string, unknown>>) {
    if (typeof a.lat !== 'number' || typeof a.lng !== 'number') continue;
    const d = haversineMeters(lat, lng, a.lat, a.lng);
    if (best === null || d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function fieldRoutes(app: FastifyInstance): Promise<void> {
  const db = () => app.db;

  /**
   * GET /field/assignments — the agent's active board: non-terminal cases
   * assigned to them. With ?lat=&lng= the stops sort nearest-first
   * (haversine); cases with no geocoded address sort last.
   */
  app.get(
    '/assignments',
    { onRequest: requireRole('agent', 'manager') },
    async (request: FastifyRequest) => {
      const actor = request.authUser!;
      const q = coordSchema.parse(request.query);

      const rows = (await db().case.findMany({
        where: { assignedAgentId: actor.id },
        include: FIELD_INCLUDE,
        orderBy: { createdAt: 'desc' },
      })) as CaseRow[];
      const active = rows.filter(
        (c) => !(TERMINAL_STATUSES as readonly string[]).includes(c.status),
      );

      const out: FieldAssignment[] = active.map((c) => {
        const s = serializeFieldCase(actor, c) as unknown as FieldAssignment;
        const distanceMeters =
          q.lat !== undefined && q.lng !== undefined
            ? caseDistanceMeters(c, q.lat, q.lng)
            : null;
        return { ...s, distanceMeters };
      });

      if (q.lat !== undefined && q.lng !== undefined) {
        out.sort((a, b) => {
          const da = a.distanceMeters ?? null;
          const db = b.distanceMeters ?? null;
          if (da === null && db === null) return 0;
          if (da === null) return 1;
          if (db === null) return -1;
          return da - db;
        });
      }
      return { assignments: out };
    },
  );

  /**
   * GET /field/cases/:id/card — the tap-a-pin case card: VIN, debtor (as
   * permitted), client + rep contact, lender/bank, addresses. 404 when the
   * case is not assigned to this agent — never 403, so assignment can't
   * be probed.
   */
  app.get(
    '/cases/:id/card',
    { onRequest: requireRole('agent', 'manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const c = await loadAssignedCase(db(), id, actor.id);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      return { card: serializeFieldCase(actor, c) };
    },
  );

  /**
   * POST /field/cases/:id/check-in — drop a GPS breadcrumb on the case
   * timeline (arrived at address, drive-by, stakeout, ...).
   */
  app.post(
    '/cases/:id/check-in',
    { onRequest: requireRole('agent', 'manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const body = checkInSchema.parse(request.body) as CheckInRequest;

      const c = await loadAssignedCase(db(), id, actor.id);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }

      await db().checkIn.create({
        data: { caseId: id, userId: actor.id, lat: body.lat, lng: body.lng, note: body.note ?? null },
      });
      await db().caseStatusHistory.create({
        data: {
          caseId: id, from: c.status, to: c.status, actorId: actor.id,
          note: `Check-in @ ${body.lat.toFixed(5)}, ${body.lng.toFixed(5)}${body.note ? ` — ${body.note}` : ''}`,
        },
      });
      await logAudit(db(), {
        actorId: actor.id, action: 'field.check_in', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: 'success',
        details: { lat: body.lat, lng: body.lng, note: body.note ?? null },
      });

      reply.status(201);
      return { ok: true };
    },
  );

  /**
   * POST /field/cases/:id/notes — append a field note to the case timeline.
   */
  app.post(
    '/cases/:id/notes',
    { onRequest: requireRole('agent', 'manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const body = noteSchema.parse(request.body) as FieldNoteRequest;

      const c = await loadAssignedCase(db(), id, actor.id);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }

      await db().caseStatusHistory.create({
        data: {
          caseId: id, from: c.status, to: c.status, actorId: actor.id,
          note: `Field note: ${body.text.trim()}`,
        },
      });
      await logAudit(db(), {
        actorId: actor.id, action: 'field.note_added', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: 'success', details: {},
      });

      reply.status(201);
      return { ok: true };
    },
  );

  /**
   * POST /field/cases/:id/possession — the agent takes physical possession.
   * Moves through the existing state machine (verify -> possession), drops
   * a check-in at the recovery point, and creates the transport-handoff
   * task for dispatch. The double-check itself stays on
   * POST /cases/:id/verify-vin — agents should verify before possessing.
   */
  app.post(
    '/cases/:id/possession',
    { onRequest: requireRole('agent', 'manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const body = possessionSchema.parse(request.body) as PossessionRequest;

      const c = await loadAssignedCase(db(), id, actor.id);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      if (!isCaseStatus(c.status)) {
        return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'Unknown case status'));
      }

      const manager = actor.role === 'manager';
      if (!canTransition(c.status as CaseStatus, 'possession', manager)) {
        await logAudit(db(), {
          actorId: actor.id, action: 'field.possession_denied',
          entityType: 'case', entityId: id, ipAddress: request.ip, result: 'denied',
          details: { from: c.status },
        });
        return reply
          .status(422)
          .send(apiError(ErrorCodes.VALIDATION, transitionError(c.status as CaseStatus, 'possession', manager)));
      }

      await db().case.update({ where: { id }, data: { status: 'possession' } });
      await db().caseStatusHistory.create({
        data: {
          caseId: id, from: c.status, to: 'possession', actorId: actor.id,
          note: `Physical possession taken @ ${body.lat.toFixed(5)}, ${body.lng.toFixed(5)}`,
        },
      });
      await db().checkIn.create({
        data: { caseId: id, userId: actor.id, lat: body.lat, lng: body.lng, note: 'Possession taken' },
      });
      // Transport handoff: unassigned so dispatch (manager/clerk) routes it
      // to a driver; visible on the case task list immediately.
      const task = await db().task.create({
        data: {
          caseId: id,
          title: `Transport handoff: ${c.caseNumber} — unit secured, ready for pickup`,
        },
      });
      await logAudit(db(), {
        actorId: actor.id, action: 'field.possession', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: 'success',
        details: { lat: body.lat, lng: body.lng, handoffTaskId: (task as { id: string }).id },
      });

      const full = await loadAssignedCase(db(), id, actor.id);
      return { case: serializeFieldCase(actor, full!), handoffTask: task };
    },
  );
}
