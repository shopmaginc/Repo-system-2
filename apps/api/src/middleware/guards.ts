import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RoleName } from '@repo/shared';
import { can, type FieldAction } from '../lib/permissions.js';
import { logAudit } from '../lib/audit.js';
import { ErrorCodes, apiError } from '../errors.js';

/**
 * Require one of the given roles. Role checks run AFTER authentication, so
 * request.authUser is guaranteed present here.
 */
export function requireRole(...roles: (RoleName | string)[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser;
    if (!user || !roles.includes(user.role)) {
      await logAudit(request.server.db, {
        actorId: user?.id,
        action: 'auth.role_denied',
        ipAddress: request.ip,
        result: 'denied',
        details: { requiredRoles: roles, actualRole: user?.role ?? null },
      });
      return reply
        .status(403)
        .send(apiError(ErrorCodes.FORBIDDEN, 'Insufficient role for this action'));
    }
  };
}

/**
 * Require field-level access from the manager-editable matrix.
 * Denials are audit-logged — probing for hidden fields is itself suspicious.
 */
export function requireFieldAccess(
  entity: string,
  field: string,
  action: FieldAction,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser;
    if (!user || !can(user.grants, action, entity, field)) {
      await logAudit(request.server.db, {
        actorId: user?.id,
        action: 'permission.denied',
        entityType: entity,
        entityId: field,
        ipAddress: request.ip,
        result: 'denied',
        details: { requestedAction: action },
      });
      return reply
        .status(403)
        .send(apiError(ErrorCodes.FORBIDDEN, 'You do not have access to this field'));
    }
  };
}
