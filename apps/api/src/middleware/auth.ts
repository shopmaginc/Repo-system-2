import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthenticatedUser, FieldGrant } from '@repo/shared';
import type { DbClient, DbFieldPermission, DbUser } from '../db.js';
import { logAudit } from '../lib/audit.js';
import { ErrorCodes, apiError } from '../errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on authenticated routes. */
    authUser?: AuthenticatedUser;
  }
  interface FastifyInstance {
    db: DbClient;
  }
}

const USER_WITH_ROLE = {
  include: { role: true },
} as const;

/**
 * Load a user plus their role and permission grants. Returns null when the
 * user does not exist OR is not active — suspended/revoked users are treated
 * exactly like missing users, so their sessions die immediately.
 */
export async function loadActiveUser(
  db: DbClient,
  userId: string,
): Promise<AuthenticatedUser | null> {
  const row = (await db.user.findUnique({
    where: { id: userId },
    ...USER_WITH_ROLE,
  })) as (DbUser & { fieldPermissions?: DbFieldPermission[] }) | null;

  if (!row || row.status !== 'active') return null;

  const permRows = (await db.fieldPermission.findMany({
    where: { roleId: row.roleId },
  })) as DbFieldPermission[];

  const grants: FieldGrant[] = permRows.map((p) => ({
    entity: p.entity,
    field: p.field,
    access: p.access,
  }));

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role.name,
    status: row.status,
    grants,
    canCaptureLotPhotos: row.role.canCaptureLotPhotos,
  };
}

/**
 * Authentication hook: verifies the JWT, then loads the user fresh from the
 * database on EVERY request. That per-request check is what makes
 * suspend/revoke take effect immediately — no waiting for token expiry.
 */
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('authUser', undefined);

  app.addHook('onRequest', async (request, reply) => {
    // Public routes opt out explicitly.
    const routeConfig = request.routeOptions.config as { public?: boolean } | undefined;
    if (routeConfig?.public) return;

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      await logAudit(app.db, {
        action: 'auth.missing_token',
        ipAddress: request.ip,
        result: 'denied',
      });
      return reply
        .status(401)
        .send(apiError(ErrorCodes.UNAUTHORIZED, 'Authentication required'));
    }

    let payload: { sub?: string };
    try {
      payload = (await request.jwtVerify()) as { sub?: string };
    } catch {
      await logAudit(app.db, {
        action: 'auth.invalid_token',
        ipAddress: request.ip,
        result: 'denied',
      });
      return reply
        .status(401)
        .send(apiError(ErrorCodes.UNAUTHORIZED, 'Invalid or expired token'));
    }

    if (!payload.sub) {
      return reply
        .status(401)
        .send(apiError(ErrorCodes.UNAUTHORIZED, 'Invalid or expired token'));
    }

    const user = await loadActiveUser(app.db, payload.sub);
    if (!user) {
      // Covers: unknown user, suspended user, revoked user.
      await logAudit(app.db, {
        actorId: payload.sub,
        action: 'auth.inactive_account',
        ipAddress: request.ip,
        result: 'denied',
      });
      return reply
        .status(401)
        .send(apiError(ErrorCodes.UNAUTHORIZED, 'Account is not active'));
    }

    request.authUser = user;
  });
}
