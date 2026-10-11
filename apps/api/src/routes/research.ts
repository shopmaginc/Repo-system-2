import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  EMAIL_TEMPLATE_KEYS,
  SKIP_PULL_PROVIDERS,
  type AuthenticatedUser,
  type ClientContactRequest,
  type CrossRefHit,
  type EmailDraftRequest,
  type SkipWorksheet,
} from '@repo/shared';
import type { DbClient } from '../db.js';
import { logAudit } from '../lib/audit.js';
import { getEmailConfig, isSmtpConfigured, sendEmail } from '../lib/email.js';
import { filterFields } from '../lib/permissions.js';
import { requireRole } from '../middleware/guards.js';
import { caseInScope } from './cases.js';
import { ErrorCodes, apiError } from '../errors.js';

/** Company name rendered into client emails and reports. */
const COMPANY_NAME = 'Complete Recovery Solutions';

/** Who may do skip research: agents, clerks, managers (in-scope cases). */
const SKIP_ROLES = ['agent', 'office_clerk', 'manager'] as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const addressEntrySchema = z.object({
  street: z.string().min(1).max(240),
  city: z.string().max(120).optional(),
  state: z.string().max(40).optional(),
  zip: z.string().max(20).optional(),
  source: z.string().max(80).optional(),
});

const phoneEntrySchema = z.object({
  number: z.string().min(1).max(32),
  source: z.string().max(80).optional(),
});

const associateEntrySchema = z.object({
  name: z.string().min(1).max(160),
  relation: z.string().max(80).optional(),
  notes: z.string().max(500).optional(),
});

const vehicleEntrySchema = z.object({
  vin: z.string().max(24).optional(),
  plate: z.string().max(24).optional(),
  description: z.string().max(240).optional(),
});

const worksheetSchema = z.object({
  knownAddresses: z.array(addressEntrySchema).max(50).default([]),
  phones: z.array(phoneEntrySchema).max(50).default([]),
  associates: z.array(associateEntrySchema).max(50).default([]),
  vehicles: z.array(vehicleEntrySchema).max(50).default([]),
  notes: z.string().max(8000).default(''),
});

const pullSchema = z.object({
  provider: z.enum(SKIP_PULL_PROVIDERS as unknown as [string, ...string[]]),
});

const pullCompleteSchema = z.object({
  summary: z.string().min(1).max(8000),
  resultRefs: z.unknown().optional(),
});

const contactSchema = z.object({
  name: z.string().min(1).max(160),
  role: z.string().max(80).optional(),
  phone: z.string().max(32).optional(),
  email: z.string().email().max(254).optional(),
  cell: z.string().max(32).optional(),
  notes: z.string().max(1000).optional(),
});

const draftSchema = z.object({
  templateKey: z.enum(EMAIL_TEMPLATE_KEYS as unknown as [string, ...string[]]),
  toContactId: z.string().min(1).optional(),
  to: z.string().email().max(254).optional(),
  cc: z.string().max(500).optional(),
  subjectOverride: z.string().max(200).optional(),
  bodyOverride: z.string().max(20000).optional(),
});

const rejectDraftSchema = z.object({
  note: z.string().min(1).max(2000),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CaseRow = Record<string, any>;

/** Case load + role-scope check. 404 unless in scope — never 403. */
async function loadScopedCase(
  db: DbClient,
  id: string,
  user: AuthenticatedUser,
): Promise<CaseRow | null> {
  const c = (await db.case.findUnique({ where: { id } })) as CaseRow | null;
  if (!c || !caseInScope(user, c)) return null;
  return c;
}

/** Defensive relation loads that work against real Prisma AND the test stub. */
async function caseDebtor(db: DbClient, c: CaseRow): Promise<Record<string, unknown> | null> {
  if (c.debtor) return c.debtor as Record<string, unknown>;
  if (!c.debtorId) return null;
  return ((await db.debtor.findUnique({ where: { id: c.debtorId } })) as Record<string, unknown> | null);
}

async function caseAsset(db: DbClient, c: CaseRow): Promise<Record<string, unknown> | null> {
  if (c.asset) return c.asset as Record<string, unknown>;
  if (!c.assetId) return null;
  return ((await db.asset.findUnique({ where: { id: c.assetId } })) as Record<string, unknown> | null);
}

async function caseAddresses(db: DbClient, c: CaseRow): Promise<Array<Record<string, unknown>>> {
  if (Array.isArray(c.addresses)) return c.addresses as Array<Record<string, unknown>>;
  return ((await db.address.findMany({ where: { caseId: c.id } })) as Array<Record<string, unknown>>) ?? [];
}

// --- Normalizers for cross-reference matching ---
const normName = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const normPhone = (s: unknown) => {
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d; // compare last 10 digits (US numbers)
};
const normAddr = (s: unknown) =>
  String(s ?? '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
const normVin = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normEmail = (s: unknown) => String(s ?? '').toLowerCase().trim();

/** Collect this case's match keys for the internal cross-reference. */
async function ownMatchKeys(db: DbClient, c: CaseRow): Promise<{
  names: string[];
  phones: string[];
  emails: string[];
  streets: string[];
  vins: string[];
}> {
  const debtor = await caseDebtor(db, c);
  const asset = await caseAsset(db, c);
  const addresses = await caseAddresses(db, c);
  const ws = (await db.skipWorksheet.findUnique({ where: { caseId: c.id } })) as
    | { entries: unknown }
    | null;
  const wsPhones: string[] = [];
  try {
    const entries = (ws?.entries as SkipWorksheet | null) ?? null;
    for (const p of entries?.phones ?? []) {
      const n = normPhone((p as { number?: string }).number);
      if (n) wsPhones.push(n);
    }
  } catch {
    /* malformed worksheet entries never break the cross-reference */
  }
  return {
    names: debtor?.name ? [normName(debtor.name)] : [],
    phones: [
      ...(debtor?.personalPhone ? [normPhone(debtor.personalPhone)] : []),
      ...wsPhones,
    ].filter(Boolean),
    emails: debtor?.email ? [normEmail(debtor.email)] : [],
    streets: [
      ...(debtor?.homeAddress ? [normAddr(debtor.homeAddress)] : []),
      ...addresses.map((a) => normAddr(a.street)).filter(Boolean),
    ],
    vins: asset?.vin ? [normVin(asset.vin)] : [],
  };
}

/**
 * Run the internal cross-reference: match this case's debtor/phones/
 * addresses/asset VIN against every other case. Capped for one-tap speed.
 */
export async function crossReference(
  db: DbClient,
  user: AuthenticatedUser,
  c: CaseRow,
): Promise<CrossRefHit[]> {
  const keys = await ownMatchKeys(db, c);
  const hasKeys =
    keys.names.length + keys.phones.length + keys.emails.length + keys.streets.length + keys.vins.length > 0;
  if (!hasKeys) return [];

  const candidates = ((await db.case.findMany({
    include: { debtor: true, asset: true, addresses: true },
    take: 200,
  })) as CaseRow[]) ?? [];

  const hits: CrossRefHit[] = [];
  for (const cand of candidates) {
    if (cand.id === c.id) continue;
    const matchedOn = new Set<string>();
    const debtor = await caseDebtor(db, cand);
    const asset = await caseAsset(db, cand);
    const addresses = await caseAddresses(db, cand);

    if (debtor) {
      const n = normName(debtor.name);
      if (n && keys.names.includes(n)) matchedOn.add('debtor_name');
      const p = normPhone(debtor.personalPhone);
      if (p && keys.phones.includes(p)) matchedOn.add('debtor_phone');
      const e = normEmail(debtor.email);
      if (e && keys.emails.includes(e)) matchedOn.add('debtor_email');
      const h = normAddr(debtor.homeAddress);
      if (h && keys.streets.includes(h)) matchedOn.add('address_street');
    }
    for (const a of addresses) {
      const s = normAddr(a.street);
      if (s && keys.streets.includes(s)) matchedOn.add('address_street');
    }
    const v = normVin(asset?.vin);
    if (v && keys.vins.includes(v)) matchedOn.add('asset_vin');

    if (matchedOn.size > 0) {
      const filteredDebtor = debtor
        ? filterFields(user.grants, 'debtor', 'read', debtor as Record<string, unknown>)
        : null;
      hits.push({
        caseId: String(cand.id),
        caseNumber: String(cand.caseNumber),
        status: String(cand.status),
        matchedOn: [...matchedOn],
        ...(filteredDebtor && Object.keys(filteredDebtor).length
          ? { debtor: filteredDebtor as Record<string, unknown> }
          : {}),
      });
      if (hits.length >= 25) break;
    }
  }
  return hits;
}

/** Placeholder values rendered from case data at draft time. */
async function templateContext(
  db: DbClient,
  user: AuthenticatedUser,
  c: CaseRow,
): Promise<Record<string, string>> {
  const debtor = await caseDebtor(db, c);
  const asset = await caseAsset(db, c);
  const client = c.client as Record<string, unknown> | null;
  const lender = c.lender as Record<string, unknown> | null;
  const delivery = (await db.deliveryConfirmation.findUnique({
    where: { caseId: c.id },
  })) as Record<string, unknown> | null;
  const filteredDebtor = debtor
    ? filterFields(user.grants, 'debtor', 'read', debtor as Record<string, unknown>)
    : {};
  const assetRow = (asset ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return {
    company_name: COMPANY_NAME,
    case_number: str(c.caseNumber),
    debtor_name: str((filteredDebtor as Record<string, unknown>).name ?? ''),
    asset_year: str(assetRow.year),
    asset_make: str(assetRow.make),
    asset_model: str(assetRow.model),
    asset_color: str(assetRow.color),
    asset_vin: str(assetRow.vin),
    client_name: str(client?.name ?? ''),
    lender_name: str(lender?.name ?? ''),
    delivery_signed_by: str(delivery?.signedByName ?? ''),
    delivery_date: delivery?.signedAt ? new Date(String(delivery.signedAt)).toLocaleDateString() : '',
    today: new Date().toLocaleDateString(),
  };
}

/** Replace {{placeholders}}; unknown placeholders are left as-is. */
export function renderTemplate(template: string, ctx: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, key: string) =>
    key in ctx ? ctx[key] : m,
  );
}

/** HTML-escape for the printable skip report. */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function userName(db: DbClient, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const u = (await db.user.findUnique({ where: { id } })) as { name?: string } | null;
  return u?.name ?? null;
}

function serializePull(db: DbClient, p: CaseRow) {
  return (async () => ({
    id: String(p.id),
    provider: String(p.provider),
    status: String(p.status),
    summary: (p.summary as string | null) ?? null,
    resultRefs: (p.resultRefs as unknown) ?? null,
    requestedByName: await userName(db, p.requestedById as string | null),
    requestedAt: p.createdAt ? new Date(String(p.createdAt)).toISOString() : '',
    completedAt: p.completedAt ? new Date(String(p.completedAt)).toISOString() : null,
  }))();
}

function serializeDraft(db: DbClient, d: CaseRow) {
  return (async () => ({
    id: String(d.id),
    templateKey: String(d.templateKey),
    to: String(d.to),
    cc: (d.cc as string | null) ?? null,
    subject: String(d.subject),
    body: String(d.body),
    status: String(d.status),
    rejectionNote: (d.rejectionNote as string | null) ?? null,
    createdByName: await userName(db, d.createdById as string | null),
    approvedByName: await userName(db, d.approvedById as string | null),
    sentAt: d.sentAt ? new Date(String(d.sentAt)).toISOString() : null,
    transport: (d.transport as string | null) ?? null,
    createdAt: d.createdAt ? new Date(String(d.createdAt)).toISOString() : '',
  }))();
}

// ---------------------------------------------------------------------------
// Routes — skip (mounted at /cases)
// ---------------------------------------------------------------------------

export async function skipRoutes(app: FastifyInstance): Promise<void> {
  const db = () => app.db;

  /**
   * GET /cases/:id/skip/crossref — the one-tap internal cross-reference:
   * match this case's debtor, phones, addresses, and asset VIN against
   * every other case in company history. Hits carry filtered debtor data
   * through the permission matrix. The lookup itself is audit-logged —
   * research access is sensitive.
   */
  app.get(
    '/:id/skip/crossref',
    { onRequest: requireRole(...SKIP_ROLES) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const c = await loadScopedCase(db(), id, actor);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      const hits = await crossReference(db(), actor, c);
      await logAudit(db(), {
        actorId: actor.id, action: 'skip.crossref', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: 'success',
        details: { hitCount: hits.length },
      });
      return { hits };
    },
  );

  /** GET /cases/:id/skip/worksheet — the structured skip worksheet. */
  app.get(
    '/:id/skip/worksheet',
    { onRequest: requireRole(...SKIP_ROLES) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const c = await loadScopedCase(db(), id, actor);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      const ws = (await db().skipWorksheet.findUnique({ where: { caseId: id } })) as
        | { entries: unknown }
        | null;
      return {
        worksheet: (ws?.entries as SkipWorksheet | null) ?? {
          knownAddresses: [],
          phones: [],
          associates: [],
          vehicles: [],
          notes: '',
        },
      };
    },
  );

  /** PUT /cases/:id/skip/worksheet — save the worksheet (one per case). */
  app.put(
    '/:id/skip/worksheet',
    { onRequest: requireRole(...SKIP_ROLES) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const body = worksheetSchema.parse(request.body);
      const c = await loadScopedCase(db(), id, actor);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      const ws = await db().skipWorksheet.upsert({
        where: { caseId: id },
        create: { caseId: id, entries: body, updatedById: actor.id },
        update: { entries: body, updatedById: actor.id },
      });
      await logAudit(db(), {
        actorId: actor.id, action: 'skip.worksheet_saved', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: 'success', details: {},
      });
      return { worksheet: (ws as { entries: unknown }).entries };
    },
  );

  /** GET /cases/:id/skip/pulls — deep-pull request history on a case. */
  app.get(
    '/:id/skip/pulls',
    { onRequest: requireRole(...SKIP_ROLES) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const c = await loadScopedCase(db(), id, actor);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      const pulls = ((await db().skipPull.findMany({
        where: { caseId: id },
        orderBy: { createdAt: 'desc' },
      })) as CaseRow[]) ?? [];
      return { pulls: await Promise.all(pulls.map((p) => serializePull(db(), p))) };
    },
  );

  /**
   * POST /cases/:id/skip/pulls — request a deep pull. The request is
   * tracked here and a manager task is raised; the vendor lookup itself
   * happens outside the system (InfoTracer / BeenVerified / OpenCorporates
   * have no APIs) and results are attached on completion.
   */
  app.post(
    '/:id/skip/pulls',
    { onRequest: requireRole(...SKIP_ROLES) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const body = pullSchema.parse(request.body);
      const c = await loadScopedCase(db(), id, actor);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      const pull = (await db().skipPull.create({
        data: { caseId: id, provider: body.provider, requestedById: actor.id, status: 'requested' },
      })) as CaseRow;
      // Notify management: an unassigned pull task on the case.
      await db().task.create({
        data: {
          caseId: id,
          title: `DEEP PULL REQUESTED — ${body.provider} for ${c.caseNumber} (requested by ${actor.name})`,
        },
      });
      await logAudit(db(), {
        actorId: actor.id, action: 'skip.pull_requested', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: 'success',
        details: { provider: body.provider, pullId: pull.id },
      });
      reply.status(201);
      return { pull: await serializePull(db(), pull) };
    },
  );

  /**
   * POST /cases/:id/skip/pulls/:pullId/complete — attach the deep-pull
   * results (summary + result references) once the vendor lookup is done
   * outside the system.
   */
  app.post(
    '/:id/skip/pulls/:pullId/complete',
    { onRequest: requireRole('manager', 'office_clerk') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id, pullId } = request.params as { id: string; pullId: string };
      const body = pullCompleteSchema.parse(request.body);
      const c = await loadScopedCase(db(), id, actor);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      const pull = (await db().skipPull.findUnique({ where: { id: pullId } })) as CaseRow | null;
      if (!pull || pull.caseId !== id) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Pull request not found'));
      }
      if (pull.status === 'complete') {
        return reply.status(409).send(apiError(ErrorCodes.CONFLICT, 'Pull is already complete'));
      }
      const updated = (await db().skipPull.update({
        where: { id: pullId },
        data: {
          status: 'complete',
          summary: body.summary.trim(),
          resultRefs: (body.resultRefs as Record<string, unknown> | undefined) ?? null,
          completedAt: new Date(),
        },
      })) as CaseRow;
      await db().caseStatusHistory.create({
        data: {
          caseId: id, from: c.status, to: c.status, actorId: actor.id,
          note: `Deep pull complete: ${pull.provider}`,
        },
      });
      await logAudit(db(), {
        actorId: actor.id, action: 'skip.pull_completed', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: 'success',
        details: { provider: pull.provider, pullId },
      });
      return { pull: await serializePull(db(), updated) };
    },
  );

  /**
   * GET /cases/:id/skip/report — the compiled skip report as a
   * print-optimized HTML page (browser print → PDF). Cross-reference hits,
   * worksheet, pull summaries, asset info — all PII filtered through the
   * requester's permission matrix.
   */
  app.get(
    '/:id/skip/report',
    { onRequest: requireRole(...SKIP_ROLES) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const c = await loadScopedCase(db(), id, actor);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      const hits = await crossReference(db(), actor, c);
      const ws = (await db().skipWorksheet.findUnique({ where: { caseId: id } })) as
        | { entries: unknown }
        | null;
      const pulls = ((await db().skipPull.findMany({
        where: { caseId: id },
        orderBy: { createdAt: 'desc' },
      })) as CaseRow[]) ?? [];
      const debtor = await caseDebtor(db(), c);
      const asset = await caseAsset(db(), c);
      const filteredDebtor = debtor
        ? (filterFields(actor.grants, 'debtor', 'read', debtor as Record<string, unknown>) as Record<string, unknown>)
        : {};
      const assetRow = (asset ?? {}) as Record<string, unknown>;
      const entries = (ws?.entries as SkipWorksheet | null) ?? {
        knownAddresses: [], phones: [], associates: [], vehicles: [], notes: '',
      };

      const debtorRows = Object.entries(filteredDebtor)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
        .join('');
      const hitRows = hits
        .map(
          (h) => `<tr><td>${esc(h.caseNumber)}</td><td>${esc(h.status.replace(/_/g, ' '))}</td><td>${esc(h.matchedOn.join(', '))}</td></tr>`,
        )
        .join('');
      const addrRows = entries.knownAddresses
        .map(
          (a) => `<tr><td>${esc(a.street)}</td><td>${esc([a.city, a.state, a.zip].filter(Boolean).join(', '))}</td><td>${esc(a.source ?? '')}</td></tr>`,
        )
        .join('');
      const phoneRows = entries.phones
        .map((p) => `<tr><td>${esc(p.number)}</td><td>${esc(p.source ?? '')}</td></tr>`)
        .join('');
      const assocRows = entries.associates
        .map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.relation ?? '')}</td><td>${esc(a.notes ?? '')}</td></tr>`)
        .join('');
      const vehRows = entries.vehicles
        .map((v) => `<tr><td>${esc(v.vin ?? '')}</td><td>${esc(v.plate ?? '')}</td><td>${esc(v.description ?? '')}</td></tr>`)
        .join('');
      const pullRows = pulls
        .map(
          (p) =>
            `<tr><td>${esc(p.provider)}</td><td>${esc(p.status)}</td><td>${esc(p.summary ?? '—')}</td></tr>`,
        )
        .join('');

      const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Skip report — ${esc(c.caseNumber)}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:800px;margin:24px auto;padding:0 16px;color:#111}
  h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:24px 0 8px;border-bottom:1px solid #ccc;padding-bottom:4px}
  .meta{color:#555;font-size:13px;margin-bottom:16px}
  table{width:100%;border-collapse:collapse;font-size:14px;margin:8px 0}
  th,td{text-align:left;padding:6px 8px;border:1px solid #ddd;vertical-align:top}
  th{background:#f4f4f4;white-space:nowrap}
  .notes{white-space:pre-wrap;background:#fafafa;border:1px solid #ddd;padding:10px;border-radius:4px;font-size:14px}
  .empty{color:#777;font-size:14px}
  @media print{body{margin:0;max-width:none}.meta{margin-bottom:8px}}
</style></head><body>
<h1>Skip report — ${esc(c.caseNumber)}</h1>
<div class="meta">${esc(COMPANY_NAME)} · generated ${esc(new Date().toLocaleString())} by ${esc(actor.name)}</div>

<h2>Asset</h2>
<table>
<tr><th>Year / Make / Model</th><td>${esc([assetRow.year, assetRow.make, assetRow.model].filter(Boolean).join(' ') || '—')}</td></tr>
<tr><th>Color</th><td>${esc(assetRow.color ?? '—')}</td></tr>
<tr><th>VIN</th><td>${esc(assetRow.vin ?? '—')}</td></tr>
<tr><th>Plate</th><td>${esc(assetRow.plate ?? '—')}</td></tr>
</table>

<h2>Debtor (as permitted)</h2>
${debtorRows ? `<table>${debtorRows}</table>` : '<div class="empty">No permitted debtor fields.</div>'}

<h2>Internal cross-reference</h2>
${hitRows ? `<table><tr><th>Case</th><th>Status</th><th>Matched on</th></tr>${hitRows}</table>` : '<div class="empty">No other cases match this debtor, addresses, or VIN.</div>'}

<h2>Skip worksheet</h2>
<h2 style="font-size:14px;border:none;margin:12px 0 4px">Known addresses</h2>
${addrRows ? `<table><tr><th>Street</th><th>City/State/ZIP</th><th>Source</th></tr>${addrRows}</table>` : '<div class="empty">None.</div>'}
<h2 style="font-size:14px;border:none;margin:12px 0 4px">Phones</h2>
${phoneRows ? `<table><tr><th>Number</th><th>Source</th></tr>${phoneRows}</table>` : '<div class="empty">None.</div>'}
<h2 style="font-size:14px;border:none;margin:12px 0 4px">Associates</h2>
${assocRows ? `<table><tr><th>Name</th><th>Relation</th><th>Notes</th></tr>${assocRows}</table>` : '<div class="empty">None.</div>'}
<h2 style="font-size:14px;border:none;margin:12px 0 4px">Vehicles</h2>
${vehRows ? `<table><tr><th>VIN</th><th>Plate</th><th>Description</th></tr>${vehRows}</table>` : '<div class="empty">None.</div>'}
<h2 style="font-size:14px;border:none;margin:12px 0 4px">Notes</h2>
${entries.notes ? `<div class="notes">${esc(entries.notes)}</div>` : '<div class="empty">None.</div>'}

<h2>Deep pulls</h2>
${pullRows ? `<table><tr><th>Provider</th><th>Status</th><th>Summary</th></tr>${pullRows}</table>` : '<div class="empty">No deep pulls requested.</div>'}
</body></html>`;

      await logAudit(db(), {
        actorId: actor.id, action: 'skip.report_viewed', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: 'success', details: { hitCount: hits.length },
      });
      return reply.type('text/html').send(html);
    },
  );
}

// ---------------------------------------------------------------------------
// Routes — client contacts + email (mounted at /clients and /email roots)
// ---------------------------------------------------------------------------

export async function clientContactRoutes(app: FastifyInstance): Promise<void> {
  const db = () => app.db;

  /** GET /clients/:id/contacts — contacts on the client record. */
  app.get(
    '/:id/contacts',
    { onRequest: requireRole('manager', 'office_clerk', 'agent') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const client = (await db().client.findUnique({ where: { id } })) as Record<string, unknown> | null;
      if (!client) return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Client not found'));
      const contacts = ((await db().clientContact.findMany({
        where: { clientId: id },
        orderBy: { name: 'asc' },
      })) as CaseRow[]) ?? [];
      return {
        contacts: contacts.map((x) => ({
          id: x.id, clientId: x.clientId, clientName: client.name, name: x.name,
          role: x.role ?? null, phone: x.phone ?? null, email: x.email ?? null,
          cell: x.cell ?? null, notes: x.notes ?? null,
        })),
      };
    },
  );

  /** POST /clients/:id/contacts — add a contact (manager/clerk). */
  app.post(
    '/:id/contacts',
    { onRequest: requireRole('manager', 'office_clerk') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const body = contactSchema.parse(request.body) as ClientContactRequest;
      const client = (await db().client.findUnique({ where: { id } })) as Record<string, unknown> | null;
      if (!client) return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Client not found'));
      const contact = (await db().clientContact.create({
        data: {
          clientId: id,
          name: body.name.trim(),
          role: body.role?.trim() || null,
          phone: body.phone?.trim() || null,
          email: body.email?.trim() || null,
          cell: body.cell?.trim() || null,
          notes: body.notes?.trim() || null,
        },
      })) as CaseRow;
      await logAudit(db(), {
        actorId: actor.id, action: 'client.contact_added', entityType: 'client', entityId: id,
        ipAddress: request.ip, result: 'success', details: { contactId: contact.id, name: contact.name },
      });
      reply.status(201);
      return { contact: { ...contact, clientName: client.name } };
    },
  );

  /** PATCH /clients/:id/contacts/:contactId — update a contact. */
  app.patch(
    '/:id/contacts/:contactId',
    { onRequest: requireRole('manager', 'office_clerk') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id, contactId } = request.params as { id: string; contactId: string };
      const body = contactSchema.partial().parse(request.body);
      const contact = (await db().clientContact.findUnique({ where: { id: contactId } })) as CaseRow | null;
      if (!contact || contact.clientId !== id) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Contact not found'));
      }
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) {
        data[k] = typeof v === 'string' ? v.trim() || null : v;
      }
      const updated = (await db().clientContact.update({ where: { id: contactId }, data })) as CaseRow;
      await logAudit(db(), {
        actorId: actor.id, action: 'client.contact_updated', entityType: 'client', entityId: id,
        ipAddress: request.ip, result: 'success', details: { contactId },
      });
      return { contact: updated };
    },
  );

  /** DELETE /clients/:id/contacts/:contactId — remove a contact. */
  app.delete(
    '/:id/contacts/:contactId',
    { onRequest: requireRole('manager', 'office_clerk') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id, contactId } = request.params as { id: string; contactId: string };
      const contact = (await db().clientContact.findUnique({ where: { id: contactId } })) as CaseRow | null;
      if (!contact || contact.clientId !== id) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Contact not found'));
      }
      await db().clientContact.delete({ where: { id: contactId } });
      await logAudit(db(), {
        actorId: actor.id, action: 'client.contact_deleted', entityType: 'client', entityId: id,
        ipAddress: request.ip, result: 'success',
        details: { contactId, name: contact.name },
      });
      return { ok: true };
    },
  );
}

export async function emailRoutes(app: FastifyInstance): Promise<void> {
  const db = () => app.db;

  /** GET /email/templates — the seeded client-email templates. */
  app.get('/email/templates', async () => {
    const templates = ((await db().emailTemplate.findMany({
      orderBy: { name: 'asc' },
    })) as CaseRow[]) ?? [];
    return {
      templates: templates.map((t) => ({
        id: t.id, key: t.key, name: t.name, subject: t.subject, body: t.body,
      })),
    };
  });

  /** GET /cases/:id/email/drafts — drafts on a case (in-scope roles). */
  app.get(
    '/cases/:id/email/drafts',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const c = await loadScopedCase(db(), id, actor);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      const drafts = ((await db().emailDraft.findMany({
        where: { caseId: id },
        orderBy: { createdAt: 'desc' },
      })) as CaseRow[]) ?? [];
      return { drafts: await Promise.all(drafts.map((d) => serializeDraft(db(), d))) };
    },
  );

  /**
   * POST /cases/:id/email/drafts — create a draft from a template.
   * Placeholders render from case data (debtor fields pass through the
   * permission matrix); the recipient comes from a client contact or a
   * manual address. The draft starts in `draft` status — nothing is sent.
   */
  app.post(
    '/cases/:id/email/drafts',
    { onRequest: requireRole(...SKIP_ROLES) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id } = request.params as { id: string };
      const body = draftSchema.parse(request.body) as EmailDraftRequest;
      const c = await loadScopedCase(db(), id, actor);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      const template = (await db().emailTemplate.findUnique({
        where: { key: body.templateKey },
      })) as CaseRow | null;
      if (!template) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Email template not found'));
      }

      // Resolve the recipient: a contact on the case's client, or manual.
      let to: string | null = null;
      if (body.toContactId) {
        const contact = (await db().clientContact.findUnique({
          where: { id: body.toContactId },
        })) as CaseRow | null;
        if (!contact || contact.clientId !== c.clientId) {
          return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'Contact does not belong to this case\'s client'));
        }
        to = String(contact.email ?? '').trim() || null;
        if (!to) {
          return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'Contact has no email address'));
        }
      } else if (body.to) {
        to = body.to.trim();
      }
      if (!to) {
        return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'Provide toContactId or a manual recipient email'));
      }

      const ctx = await templateContext(db(), actor, c);
      const draft = (await db().emailDraft.create({
        data: {
          caseId: id,
          templateKey: body.templateKey,
          to,
          cc: body.cc?.trim() || null,
          subject: body.subjectOverride?.trim() || renderTemplate(String(template.subject), ctx),
          body: body.bodyOverride ?? renderTemplate(String(template.body), ctx),
          status: 'draft',
          createdById: actor.id,
        },
      })) as CaseRow;
      await logAudit(db(), {
        actorId: actor.id, action: 'email.draft_created', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: 'success',
        details: { draftId: draft.id, templateKey: body.templateKey, to },
      });
      reply.status(201);
      return { draft: await serializeDraft(db(), draft) };
    },
  );

  /**
   * POST /cases/:id/email/drafts/:draftId/submit — request manager
   * approval. A manager task is raised so nothing waits silently.
   */
  app.post(
    '/cases/:id/email/drafts/:draftId/submit',
    { onRequest: requireRole(...SKIP_ROLES) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id, draftId } = request.params as { id: string; draftId: string };
      const c = await loadScopedCase(db(), id, actor);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      const draft = (await db().emailDraft.findUnique({ where: { id: draftId } })) as CaseRow | null;
      if (!draft || draft.caseId !== id) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Draft not found'));
      }
      if (!['draft', 'rejected'].includes(String(draft.status))) {
        return reply.status(409).send(apiError(ErrorCodes.CONFLICT, `Cannot submit a ${draft.status} draft`));
      }
      const updated = (await db().emailDraft.update({
        where: { id: draftId },
        data: { status: 'pending_approval', rejectionNote: null },
      })) as CaseRow;
      await db().task.create({
        data: {
          caseId: id,
          title: `EMAIL NEEDS APPROVAL — "${draft.subject}" to ${draft.to} (${c.caseNumber})`,
        },
      });
      await db().caseStatusHistory.create({
        data: {
          caseId: id, from: c.status, to: c.status, actorId: actor.id,
          note: `Email draft submitted for approval: "${draft.subject}" → ${draft.to}`,
        },
      });
      await logAudit(db(), {
        actorId: actor.id, action: 'email.submitted', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: 'success',
        details: { draftId, to: draft.to, subject: draft.subject },
      });
      return { draft: await serializeDraft(db(), updated) };
    },
  );

  /** POST /cases/:id/email/drafts/:draftId/approve — manager only. */
  app.post(
    '/cases/:id/email/drafts/:draftId/approve',
    { onRequest: requireRole('manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id, draftId } = request.params as { id: string; draftId: string };
      const c = await loadScopedCase(db(), id, actor);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      const draft = (await db().emailDraft.findUnique({ where: { id: draftId } })) as CaseRow | null;
      if (!draft || draft.caseId !== id) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Draft not found'));
      }
      if (draft.status !== 'pending_approval') {
        return reply.status(409).send(apiError(ErrorCodes.CONFLICT, `Cannot approve a ${draft.status} draft`));
      }
      const updated = (await db().emailDraft.update({
        where: { id: draftId },
        data: { status: 'approved', approvedById: actor.id, rejectionNote: null },
      })) as CaseRow;
      await db().caseStatusHistory.create({
        data: {
          caseId: id, from: c.status, to: c.status, actorId: actor.id,
          note: `Email approved: "${draft.subject}" → ${draft.to}`,
        },
      });
      await logAudit(db(), {
        actorId: actor.id, action: 'email.approved', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: 'success',
        details: { draftId, to: draft.to, subject: draft.subject },
      });
      return { draft: await serializeDraft(db(), updated) };
    },
  );

  /** POST /cases/:id/email/drafts/:draftId/reject — manager only, note required. */
  app.post(
    '/cases/:id/email/drafts/:draftId/reject',
    { onRequest: requireRole('manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id, draftId } = request.params as { id: string; draftId: string };
      const body = rejectDraftSchema.parse(request.body);
      const c = await loadScopedCase(db(), id, actor);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      const draft = (await db().emailDraft.findUnique({ where: { id: draftId } })) as CaseRow | null;
      if (!draft || draft.caseId !== id) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Draft not found'));
      }
      if (!['draft', 'pending_approval'].includes(String(draft.status))) {
        return reply.status(409).send(apiError(ErrorCodes.CONFLICT, `Cannot reject a ${draft.status} draft`));
      }
      const updated = (await db().emailDraft.update({
        where: { id: draftId },
        data: { status: 'rejected', rejectionNote: body.note.trim() },
      })) as CaseRow;
      // Notify the drafter: fix-and-resubmit task on the case.
      if (draft.createdById) {
        await db().task.create({
          data: {
            caseId: id,
            assigneeId: String(draft.createdById),
            title: `Fix & resubmit email: "${draft.subject}" (${c.caseNumber}) — ${body.note.trim().slice(0, 120)}`,
          },
        });
      }
      await db().caseStatusHistory.create({
        data: {
          caseId: id, from: c.status, to: c.status, actorId: actor.id,
          note: `Email draft rejected: "${draft.subject}" — ${body.note.trim().slice(0, 200)}`,
        },
      });
      await logAudit(db(), {
        actorId: actor.id, action: 'email.rejected', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: 'success',
        details: { draftId, note: body.note.trim().slice(0, 200) },
      });
      return { draft: await serializeDraft(db(), updated) };
    },
  );

  /**
   * POST /cases/:id/email/drafts/:draftId/send — manager only, approved
   * drafts only.
   *
   * When SMTP env config (SMTP_HOST/PORT/USER/PASS) is present, this endpoint
   * actually delivers the email via SMTP and records transport 'smtp'. When
   * SMTP is not configured, it records the send with transport
   * 'pending-smtp-config' without delivering — the transport flag makes the
   * gap impossible to miss.
   */
  app.post(
    '/cases/:id/email/drafts/:draftId/send',
    { onRequest: requireRole('manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.authUser!;
      const { id, draftId } = request.params as { id: string; draftId: string };
      const c = await loadScopedCase(db(), id, actor);
      if (!c) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Case not found'));
      }
      const draft = (await db().emailDraft.findUnique({ where: { id: draftId } })) as CaseRow | null;
      if (!draft || draft.caseId !== id) {
        return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Draft not found'));
      }
      if (draft.status !== 'approved') {
        await logAudit(db(), {
          actorId: actor.id, action: 'email.send_denied', entityType: 'case', entityId: id,
          ipAddress: request.ip, result: 'denied',
          details: { draftId, status: draft.status },
        });
        return reply
          .status(409)
          .send(apiError(ErrorCodes.CONFLICT, `Only approved drafts can be sent (this one is ${draft.status})`));
      }
      // Attempt real SMTP delivery when configured; fall back to recorded-only.
      let transport = 'pending-smtp-config';
      let smtpMessageId: string | null = null;
      let smtpError: string | null = null;
      if (isSmtpConfigured()) {
        try {
          smtpMessageId = await sendEmail({
            to: draft.to as string,
            cc: (draft.cc as string | null) ?? null,
            subject: draft.subject as string,
            body: draft.body as string,
          });
          transport = 'smtp';
        } catch (err) {
          smtpError = err instanceof Error ? err.message : String(err);
          // Delivery failed — still record the attempt, flagged clearly.
          transport = 'smtp-failed';
        }
      }
      const updated = (await db().emailDraft.update({
        where: { id: draftId },
        data: {
          status: transport === 'smtp-failed' ? 'approved' : 'sent',
          sentAt: transport === 'smtp-failed' ? null : new Date(),
          transport,
        },
      })) as CaseRow;
      await db().caseStatusHistory.create({
        data: {
          caseId: id, from: c.status, to: c.status, actorId: actor.id,
          note: `Email sent: "${draft.subject}" → ${draft.to}`,
        },
      });
      await logAudit(db(), {
        actorId: actor.id, action: 'email.sent', entityType: 'case', entityId: id,
        ipAddress: request.ip, result: 'success',
        details: {
          draftId,
          to: draft.to,
          cc: draft.cc ?? null,
          subject: draft.subject,
          body: draft.body,
          transport,
          smtpMessageId,
          smtpError,
        },
      });
      return { draft: await serializeDraft(db(), updated) };
    },
  );
}
