import type { AccessLevel, FieldGrant } from '@repo/shared';

/**
 * Permission engine — the heart of the manager-editable access matrix.
 *
 * DEFAULT-DENY: any (entity, field) pair with no explicit grant resolves to
 * 'hidden'. Nothing is ever visible by accident; managers open up fields
 * deliberately, never the other way around.
 */

export type FieldAction = 'read' | 'write';

const RANK: Record<AccessLevel, number> = { hidden: 0, read: 1, write: 2 };

/** Resolve the effective access level for one entity+field. Pure. */
export function accessFor(
  grants: FieldGrant[],
  entity: string,
  field: string,
): AccessLevel {
  const grant = grants.find((g) => g.entity === entity && g.field === field);
  return grant ? grant.access : 'hidden'; // <-- default-deny
}

/**
 * Can this set of grants perform `action` on entity.field?
 * - 'write' implies 'read'
 * - 'hidden' denies everything
 */
export function can(
  grants: FieldGrant[],
  action: FieldAction,
  entity: string,
  field: string,
): boolean {
  const level = accessFor(grants, entity, field);
  return RANK[level] >= RANK[action];
}

/** Convenience: does the role have ANY non-hidden grant on this entity? */
export function canSeeEntity(grants: FieldGrant[], entity: string): boolean {
  return grants.some((g) => g.entity === entity && g.access !== 'hidden');
}

/**
 * Strip an object down to only the fields the grants allow for `action`.
 * Unknown fields are dropped (default-deny), never passed through.
 */
export function filterFields<T extends Record<string, unknown>>(
  grants: FieldGrant[],
  entity: string,
  action: FieldAction,
  obj: T,
): Partial<T> {
  const out: Partial<T> = {};
  for (const [field, value] of Object.entries(obj)) {
    if (can(grants, action, entity, field)) {
      (out as Record<string, unknown>)[field] = value;
    }
  }
  return out;
}
