import { describe, expect, it } from 'vitest';
import type { FieldGrant } from '@repo/shared';
import { accessFor, can, canSeeEntity, filterFields } from '../src/lib/permissions.js';

/**
 * Permission engine unit tests.
 * The engine is pure (no DB), so these run anywhere.
 */

const MANAGER_GRANTS: FieldGrant[] = [
  { entity: 'debtor', field: 'ssn', access: 'write' },
  { entity: 'debtor', field: 'name', access: 'write' },
  { entity: 'case', field: 'vin', access: 'write' },
];

const AGENT_GRANTS: FieldGrant[] = [
  { entity: 'debtor', field: 'name', access: 'read' },
  { entity: 'case', field: 'vin', access: 'read' },
  { entity: 'case', field: 'notes', access: 'write' },
];

describe('default-deny', () => {
  it('resolves unknown entity/field pairs to hidden', () => {
    expect(accessFor(AGENT_GRANTS, 'debtor', 'ssn')).toBe('hidden');
    expect(accessFor(AGENT_GRANTS, 'invoice', 'amount')).toBe('hidden');
    expect(accessFor([], 'case', 'vin')).toBe('hidden');
  });

  it('denies read and write on ungranted fields', () => {
    expect(can(AGENT_GRANTS, 'read', 'debtor', 'ssn')).toBe(false);
    expect(can(AGENT_GRANTS, 'write', 'debtor', 'ssn')).toBe(false);
  });

  it('drops ungranted fields when filtering objects', () => {
    const debtor = { name: 'Jane Doe', ssn: '123-45-6789', dob: '1980-01-01' };
    expect(filterFields(AGENT_GRANTS, 'debtor', 'read', debtor)).toEqual({
      name: 'Jane Doe',
    });
  });

  it('reports no visibility on entities with zero grants', () => {
    expect(canSeeEntity(AGENT_GRANTS, 'invoice')).toBe(false);
    expect(canSeeEntity(AGENT_GRANTS, 'case')).toBe(true);
  });
});

describe('grant semantics', () => {
  it('write implies read', () => {
    expect(can(MANAGER_GRANTS, 'read', 'debtor', 'ssn')).toBe(true);
    expect(can(MANAGER_GRANTS, 'write', 'debtor', 'ssn')).toBe(true);
  });

  it('read does not imply write', () => {
    expect(can(AGENT_GRANTS, 'read', 'case', 'vin')).toBe(true);
    expect(can(AGENT_GRANTS, 'write', 'case', 'vin')).toBe(false);
  });

  it('grants on one field never leak to another', () => {
    expect(can(AGENT_GRANTS, 'read', 'debtor', 'name')).toBe(true);
    expect(can(AGENT_GRANTS, 'read', 'debtor', 'dob')).toBe(false);
  });
});

describe('seed-matrix spot checks', () => {
  it('agent cannot see debtor PII but can read case VIN', () => {
    expect(can(AGENT_GRANTS, 'read', 'debtor', 'ssn')).toBe(false);
    expect(can(AGENT_GRANTS, 'read', 'debtor', 'dob')).toBe(false);
    expect(can(AGENT_GRANTS, 'read', 'case', 'vin')).toBe(true);
    expect(can(AGENT_GRANTS, 'write', 'case', 'notes')).toBe(true);
  });
});
