import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { ROLE_NAMES, type RoleName } from '@repo/shared';
import type { DbUser } from '../db.js';
import { hashPassword } from '../lib/password.js';
import { logAudit } from '../lib/audit.js';
import { requireRole } from '../middleware/guards.js';
import { ErrorCodes, apiError } from '../errors.js';

const inviteSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(254),
  phone: z.string().max(32).optional(),
  role: z.enum(ROLE_NAMES as unknown as [RoleName, ...RoleName[]]),
  password: z.string().min(12).max(128).optional(),
});

const roleAssignSchema = z.object({
  role: z.enum(ROLE_NAMES as unknown as [RoleName, ...RoleName[]]),
});

const permissionUpdateSchema = z.object({
  permissions: z
    .array(
      z.object({
        entity: z.string().min(1).max(64),
        field: z.string().min(1).max(64),
        access: z.enum(['hidden', 'read', 'write']),
      }),
    )
    .max(500),
});

const USER_PUBLIC_SELECT = {
  select: {
    id: true,
    name: true,
    email: true,
    phone: true,
    status: true,
    photoUrl: true,
    roleId: true,
    role: { select: { id: true, name: true, canCaptureLotPhotos: true } },
    createdAt: true,
    updatedAt: true,
  },
} as const;

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Everything under /admin requires the manager role.
  app.addHook('onRequest', requireRole('manager'));

  /** GET /admin/users — list all users (no password hashes, ever). */
  app.get('/users', async () => {
    const users = await app.db.user.findMany({
      ...USER_PUBLIC_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return { users };
  });

  /**
   * POST /admin/users — invite/create a user. Generates a random initial
   * password when none is supplied; the plaintext is returned ONCE so the
   * manager can hand it to the new user out-of-band.
   */
  app.post('/users', async (request, reply) => {
    const body = inviteSchema.parse(request.body);
    const email = body.email.toLowerCase().trim();

    const existing = await app.db.user.findUnique({ where: { email } });
    if (existing) {
      return reply
        .status(409)
        .send(apiError(ErrorCodes.CONFLICT, 'A user with this email already exists'));
    }

    const role = (await app.db.role.findUnique({ where: { name: body.role } })) as {
      id: string;
    } | null;
    if (!role) {
      return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'Unknown role'));
    }

    // Manager-supplied or generated; never logged, never stored in plaintext.
    const initialPassword = body.password ?? randomBytes(16).toString('base64url');
    const passwordHash = await hashPassword(initialPassword);

    const created = (await app.db.user.create({
      data: {
        name: body.name.trim(),
        email,
        phone: body.phone,
        roleId: role.id,
        passwordHash,
        status: 'active',
      },
      ...USER_PUBLIC_SELECT,
    })) as unknown;

    await logAudit(app.db, {
      actorId: request.authUser!.id,
      action: 'user.invite',
      entityType: 'user',
      entityId: (created as { id: string }).id,
      ipAddress: request.ip,
      result: 'success',
      details: { email, role: body.role },
    });

    reply.status(201);
    return { user: created, initialPassword };
  });

  /** PATCH /admin/users/:id/role — reassign a user's role. */
  app.patch('/users/:id/role', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = roleAssignSchema.parse(request.body);

    const target = (await app.db.user.findUnique({ where: { id } })) as DbUser | null;
    if (!target) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'User not found'));
    }
    // A manager cannot demote themselves out of the manager role.
    if (target.id === request.authUser!.id && body.role !== 'manager') {
      return reply
        .status(400)
        .send(apiError(ErrorCodes.VALIDATION, 'You cannot remove your own manager role'));
    }

    const role = (await app.db.role.findUnique({ where: { name: body.role } })) as {
      id: string;
    } | null;
    if (!role) {
      return reply.status(400).send(apiError(ErrorCodes.VALIDATION, 'Unknown role'));
    }

    const updated = await app.db.user.update({
      where: { id },
      data: { roleId: role.id },
      ...USER_PUBLIC_SELECT,
    });

    await logAudit(app.db, {
      actorId: request.authUser!.id,
      action: 'user.role_changed',
      entityType: 'user',
      entityId: id,
      ipAddress: request.ip,
      result: 'success',
      details: { newRole: body.role },
    });
    return { user: updated };
  });

  /**
   * POST /admin/users/:id/suspend and /revoke — immediately invalidate the
   * account. The per-request status check in the auth hook means the user's
   * access token stops working on the very next request, and all refresh
   * tokens are revoked so no new access tokens can be minted.
   */
  async function setStatus(
    request: FastifyRequest,
    reply: FastifyReply,
    status: 'suspended' | 'revoked' | 'active',
    action: string,
  ) {
    const { id } = request.params as { id: string };
    const target = (await request.server.db.user.findUnique({ where: { id } })) as DbUser | null;
    if (!target) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'User not found'));
    }
    if (target.id === request.authUser!.id) {
      return reply
        .status(400)
        .send(apiError(ErrorCodes.VALIDATION, 'You cannot change your own status'));
    }

    const updated = await request.server.db.user.update({
      where: { id },
      data: { status },
      ...USER_PUBLIC_SELECT,
    });
    // Kill every refresh token so the user cannot mint new access tokens.
    await request.server.db.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await logAudit(request.server.db, {
      actorId: request.authUser!.id,
      action,
      entityType: 'user',
      entityId: id,
      ipAddress: request.ip,
      result: 'success',
      details: { newStatus: status },
    });
    return { user: updated };
  }

  app.post('/users/:id/suspend', async (request, reply) =>
    setStatus(request, reply, 'suspended', 'user.suspended'),
  );
  app.post('/users/:id/revoke', async (request, reply) =>
    setStatus(request, reply, 'revoked', 'user.revoked'),
  );
  app.post('/users/:id/reinstate', async (request, reply) =>
    setStatus(request, reply, 'active', 'user.reinstated'),
  );

  /** GET /admin/roles — roles with their permission grants. */
  app.get('/roles', async () => {
    const roles = await app.db.role.findMany({
      include: { fieldPermissions: true },
      orderBy: { name: 'asc' },
    });
    return { roles };
  });

  /**
   * PUT /admin/roles/:name/permissions — replace the field-permission matrix
   * for one role. This is the manager dashboard's save endpoint.
   */
  app.put('/roles/:name/permissions', async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = permissionUpdateSchema.parse(request.body);

    const role = (await app.db.role.findUnique({ where: { name } })) as {
      id: string;
    } | null;
    if (!role) {
      return reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Role not found'));
    }

    for (const p of body.permissions) {
      await app.db.fieldPermission.upsert({
        where: {
          roleId_entity_field: { roleId: role.id, entity: p.entity, field: p.field },
        },
        create: { roleId: role.id, entity: p.entity, field: p.field, access: p.access },
        update: { access: p.access },
      });
    }

    await logAudit(app.db, {
      actorId: request.authUser!.id,
      action: 'role.permissions_updated',
      entityType: 'role',
      entityId: role.id,
      ipAddress: request.ip,
      result: 'success',
      details: { role: name, changed: body.permissions.length },
    });
    return { ok: true, updated: body.permissions.length };
  });
}
