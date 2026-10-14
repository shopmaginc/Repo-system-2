import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  PlateHitRecord,
  PlateListRecord,
} from '@repo/shared';
import type { DbClient } from '../db.js';
import { logAudit } from '../lib/audit.js';
import { normalizePlate } from '../lib/plates.js';
import { requireRole } from '../middleware/guards.js';
import { ErrorCodes, apiError } from '../errors.js';

/**
 * ALPR — license plate reader subsystem.
 *
 * Field phones (one or many per car) sync PlateLists down for on-device
 * matching and upload PlateHits back up. Plates are stored NORMALIZED
 * (uppercase, no spaces/dashes — see src/lib/plates.ts) on every write, and
 * every match lookup normalizes first, so "abc-123" and "ABC 123" are the
 * same plate everywhere.
 *
 * Roles: list management is manager + office_clerk; list sync and hit
 * submission are open to every active user (field agents' phones); hit
 * review is manager + office_clerk. Access rides on the global auth hook.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const plateEntryInput = z.object({
  plate: z.string().min(1).max(12),
  state: z.string().trim().length(2).optional(),
  notes: z.string().max(1000).optional(),
});

const listCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  client: z.string().trim().min(1).max(160).optional(),
  plates: z.array(plateEntryInput).max(5000),
});

const listUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  client: z.string().trim().min(1).max(160).nullable().optional(),
  // Full replacement of the entry set.
  plates: z.array(plateEntryInput).max(5000),
});

const hitSchema = z.object({
  plate: z.string().min(1).max(12),
  state: z.string().trim().length(2).optional(),
  confidence: z.number().min(0).max(1).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  scannedAt: z.string().datetime(),
  photoRef: z.string().min(1).max(160).optional(),
  deviceId: z.string().min(1).max(80).optional(),
});

const hitQuerySchema = z.object({
  plate: z.string().min(1).max(12).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  listId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

/** Normalize + dedupe a plates payload. First occurrence wins on duplicates. */
function normalizeEntries(input: Array<{ plate: string; state?: string; notes?: string }>): Array<{
  plate: string;
  state: string | null;
  notes: string | null;
}> {
  const seen = new Set<string>();
  const out: Array<{ plate: string; state: string | null; notes: string | null }> = [];
  for (const entry of input) {
    const plate = normalizePlate(entry.plate);
    if (!plate) {
      throw new Error(`Plate "${entry.plate}" is empty after normalization`);
    }
    if (seen.has(plate)) continue;
    seen.add(plate);
    out.push({
      plate,
      state: entry.state ? entry.state.toUpperCase() : null,
      notes: entry.notes ?? null,
    });
  }
  return out;
}

function toListRecord(list: Row, plateCount: number): PlateListRecord {
  return {
    id: String(list.id),
    name: String(list.name),
    client: (list.clientId as string | null) ?? null,
    plateCount,
    createdById: String(list.createdById),
    createdAt: new Date(list.createdAt).toISOString(),
    updatedAt: new Date(list.updatedAt).toISOString(),
  };
}

async function plateCountFor(db: DbClient, listIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (listIds.length === 0) return counts;
  const rows = (await db.plateEntry.findMany({
    where: { listId: { in: listIds } },
    select: { listId: true },
  })) as Array<Row>;
  for (const row of rows) {
    const id = String(row.listId);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export async function alprRoutes(app: FastifyInstance): Promise<void> {
  const db = () => app.db;

  // ------------------------------------------------------------------
  // Plate lists
  // ------------------------------------------------------------------

  /**
   * POST /alpr/lists — create a watch list with its plate entries.
   * Manager + office only. Plates are normalized and deduped; the whole
   * batch is written together.
   */
  app.post('/lists', { onRequest: requireRole('manager', 'office_clerk') }, async (request: FastifyRequest, reply) => {
    const actor = request.authUser!;
    const body = listCreateSchema.parse(request.body);
    let entries: Array<{ plate: string; state: string | null; notes: string | null }>;
    try {
      entries = normalizeEntries(body.plates);
    } catch (err) {
      return reply.status(400).send(apiError(ErrorCodes.VALIDATION, (err as Error).message));
    }

    const list = (await db().plateList.create({
      data: {
        name: body.name,
        clientId: body.client ?? null,
        createdById: actor.id,
      },
    })) as Row;

    if (entries.length > 0) {
      await db().plateEntry.createMany({
        data: entries.map((e) => ({ listId: String(list.id), ...e })),
      });
    }

    await logAudit(db(), {
      actorId: actor.id,
      action: 'alpr.list_created',
      entityType: 'PlateList',
      entityId: String(list.id),
      ipAddress: request.ip,
      result: 'success',
      details: { name: body.name, plateCount: entries.length },
    });

    return reply.status(201).send({ list: toListRecord(list, entries.length) });
  });

  /**
   * GET /alpr/lists — lightweight inventory for phone sync checks.
   * Every active user (field phones poll this to decide what to download).
   */
  app.get('/lists', async (request: FastifyRequest) => {
    const lists = (await db().plateList.findMany({
      orderBy: { updatedAt: 'desc' },
    })) as Array<Row>;
    const counts = await plateCountFor(db(), lists.map((l) => String(l.id)));
    return { lists: lists.map((l) => toListRecord(l, counts.get(String(l.id)) ?? 0)) };
  });

  /**
   * GET /alpr/lists/:id — full list with entries, for phone download.
   * Every active user.
   */
  app.get('/lists/:id', async (request: FastifyRequest, reply) => {
    const { id } = request.params as { id: string };
    const list = (await db().plateList.findUnique({ where: { id } })) as Row | null;
    if (!list) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Plate list not found'));
    }
    const entries = (await db().plateEntry.findMany({
      where: { listId: id },
      orderBy: { plate: 'asc' },
    })) as Array<Row>;
    return {
      list: toListRecord(list, entries.length),
      entries: entries.map((e) => ({
        id: String(e.id),
        plate: String(e.plate),
        state: (e.state as string | null) ?? null,
        notes: (e.notes as string | null) ?? null,
        addedAt: new Date(e.addedAt).toISOString(),
      })),
    };
  });

  /**
   * PUT /alpr/lists/:id — rename and/or fully replace the entry set.
   * Manager + office only. Replacement is delete-then-insert.
   */
  app.put('/lists/:id', { onRequest: requireRole('manager', 'office_clerk') }, async (request: FastifyRequest, reply) => {
    const actor = request.authUser!;
    const { id } = request.params as { id: string };
    const body = listUpdateSchema.parse(request.body);

    const existing = (await db().plateList.findUnique({ where: { id } })) as Row | null;
    if (!existing) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Plate list not found'));
    }

    let entries: Array<{ plate: string; state: string | null; notes: string | null }>;
    try {
      entries = normalizeEntries(body.plates);
    } catch (err) {
      return reply.status(400).send(apiError(ErrorCodes.VALIDATION, (err as Error).message));
    }

    const data: Row = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.client !== undefined) data.clientId = body.client;

    const list = (await db().plateList.update({ where: { id }, data })) as Row;
    await db().plateEntry.deleteMany({ where: { listId: id } });
    if (entries.length > 0) {
      await db().plateEntry.createMany({
        data: entries.map((e) => ({ listId: id, ...e })),
      });
    }

    await logAudit(db(), {
      actorId: actor.id,
      action: 'alpr.list_updated',
      entityType: 'PlateList',
      entityId: id,
      ipAddress: request.ip,
      result: 'success',
      details: { name: String(list.name), plateCount: entries.length },
    });

    return { list: toListRecord(list, entries.length) };
  });

  /**
   * DELETE /alpr/lists/:id — manager only. Entries cascade in the DB.
   */
  app.delete('/lists/:id', { onRequest: requireRole('manager') }, async (request: FastifyRequest, reply) => {
    const actor = request.authUser!;
    const { id } = request.params as { id: string };

    const existing = (await db().plateList.findUnique({ where: { id } })) as Row | null;
    if (!existing) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Plate list not found'));
    }

    // Belt and suspenders: the FK cascades entries, but the stub DB has no
    // FK enforcement, so delete entries explicitly too.
    await db().plateEntry.deleteMany({ where: { listId: id } });
    await db().plateList.delete({ where: { id } });

    await logAudit(db(), {
      actorId: actor.id,
      action: 'alpr.list_deleted',
      entityType: 'PlateList',
      entityId: id,
      ipAddress: request.ip,
      result: 'success',
      details: { name: String(existing.name) },
    });

    return { deleted: true };
  });

  // ------------------------------------------------------------------
  // Hits
  // ------------------------------------------------------------------

  /**
   * POST /alpr/hits — report a plate scan from a field phone.
   * Every active user. The server normalizes the plate and matches it
   * against ALL lists with a single indexed lookup; the response carries
   * server-side hit confirmation. The hit is stored regardless of match.
   */
  app.post('/hits', async (request: FastifyRequest, reply) => {
    const actor = request.authUser!;
    const body = hitSchema.parse(request.body);
    const plate = normalizePlate(body.plate);
    if (!plate) {
      return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'Plate is empty after normalization'));
    }

    // One indexed lookup for the server-side match.
    const matchedEntries = (await db().plateEntry.findMany({
      where: { plate },
      select: { listId: true },
    })) as Array<Row>;
    const matchedListIds = [...new Set(matchedEntries.map((e) => String(e.listId)))];
    let matches: Array<{ listId: string; listName: string }> = [];
    if (matchedListIds.length > 0) {
      const lists = (await db().plateList.findMany({
        where: { id: { in: matchedListIds } },
        select: { id: true, name: true },
      })) as Array<Row>;
      matches = lists.map((l) => ({ listId: String(l.id), listName: String(l.name) }));
    }

    const hit = (await db().plateHit.create({
      data: {
        plate,
        state: body.state ? body.state.toUpperCase() : null,
        confidence: body.confidence ?? null,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        scannedAt: new Date(body.scannedAt),
        photoRef: body.photoRef ?? null,
        deviceId: body.deviceId ?? null,
        reportedById: actor.id,
      },
    })) as Row;

    await logAudit(db(), {
      actorId: actor.id,
      action: 'alpr.hit_reported',
      entityType: 'PlateHit',
      entityId: String(hit.id),
      ipAddress: request.ip,
      result: 'success',
      details: { plate, matchCount: matches.length, deviceId: body.deviceId ?? null },
    });

    const record: PlateHitRecord = {
      id: String(hit.id),
      plate,
      state: (hit.state as string | null) ?? null,
      confidence: (hit.confidence as number | null) ?? null,
      latitude: (hit.latitude as number | null) ?? null,
      longitude: (hit.longitude as number | null) ?? null,
      scannedAt: new Date(hit.scannedAt).toISOString(),
      photoRef: (hit.photoRef as string | null) ?? null,
      deviceId: (hit.deviceId as string | null) ?? null,
      reportedById: String(hit.reportedById),
      reporterName: actor.name,
      createdAt: new Date(hit.createdAt).toISOString(),
    };

    return reply.status(201).send({ hit: record, matches });
  });

  /**
   * GET /alpr/hits — review hit reports, newest first, with reporter names.
   * Manager + office only. Optional filters: plate, since, until, listId.
   */
  app.get('/hits', { onRequest: requireRole('manager', 'office_clerk') }, async (request: FastifyRequest) => {
    const query = hitQuerySchema.parse(request.query);
    const where: Row = {};
    if (query.plate) where.plate = normalizePlate(query.plate);
    if (query.listId) where.listId = query.listId;
    if (query.since || query.until) {
      where.scannedAt = {};
      if (query.since) where.scannedAt.gte = new Date(query.since);
      if (query.until) where.scannedAt.lte = new Date(query.until);
    }

    const hits = (await db().plateHit.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    })) as Array<Row>;

    const reporterIds = [...new Set(hits.map((h) => String(h.reportedById)))];
    const reporters = (await db().user.findMany({
      where: { id: { in: reporterIds } },
      select: { id: true, name: true },
    })) as Array<Row>;
    const names = new Map(reporters.map((u) => [String(u.id), String(u.name)]));

    return {
      hits: hits.map((h): PlateHitRecord => ({
        id: String(h.id),
        plate: String(h.plate),
        state: (h.state as string | null) ?? null,
        confidence: (h.confidence as number | null) ?? null,
        latitude: (h.latitude as number | null) ?? null,
        longitude: (h.longitude as number | null) ?? null,
        scannedAt: new Date(h.scannedAt).toISOString(),
        photoRef: (h.photoRef as string | null) ?? null,
        deviceId: (h.deviceId as string | null) ?? null,
        reportedById: String(h.reportedById),
        reporterName: names.get(String(h.reportedById)) ?? null,
        createdAt: new Date(h.createdAt).toISOString(),
      })),
    };
  });
}
