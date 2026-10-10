import { CASE_STATUSES, type CaseStatus } from '@repo/shared';

/**
 * Case lifecycle state machine — Phase 1.
 *
 * The TRANSITIONS map encodes the legal operational moves through Craig's
 * 11-stage lifecycle. Non-managers may only use moves present in the map
 * (the happy path plus explicit one-step "hold/send-back" moves, e.g.
 * verify -> field_work when the equipment turns out not to match).
 * Managers may additionally jump to any non-terminal status (override),
 * because real operations sometimes skip or revisit stages.
 *
 * `cancelled` is manager-only, always. Terminal states (closed, cancelled)
 * admit no outgoing moves.
 */

const TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  intake: ['assigned', 'cancelled'],
  assigned: ['field_work', 'intake', 'cancelled'],
  field_work: ['verify', 'assigned', 'cancelled'],
  verify: ['possession', 'field_work', 'cancelled'],
  possession: ['transport', 'cancelled'],
  transport: ['lot_storage', 'cancelled'],
  lot_storage: ['condition_report', 'cancelled'],
  condition_report: ['delivery', 'cancelled'],
  delivery: ['invoicing', 'cancelled'],
  invoicing: ['closed', 'cancelled'],
  closed: [],
  cancelled: [],
};

export const TERMINAL_STATUSES: CaseStatus[] = ['closed', 'cancelled'];

export function isCaseStatus(value: unknown): value is CaseStatus {
  return (
    typeof value === 'string' &&
    (CASE_STATUSES as readonly string[]).includes(value)
  );
}

export function isTerminal(status: CaseStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Is this status change legal?
 * - Unknown statuses: never.
 * - Same-status "moves": never (use notes/tasks for commentary).
 * - Terminal source: never.
 * - `cancelled`: manager only.
 * - Manager: any non-terminal target (override).
 * - Everyone else: only moves present in TRANSITIONS.
 */
export function canTransition(
  from: CaseStatus,
  to: CaseStatus,
  isManager: boolean,
): boolean {
  if (!isCaseStatus(from) || !isCaseStatus(to)) return false;
  if (from === to) return false;
  if (isTerminal(from)) return false;
  if (to === 'cancelled') return isManager;
  if (isManager) return !isTerminal(to);
  return TRANSITIONS[from].includes(to);
}

/** Human-readable reason when canTransition returns false. */
export function transitionError(
  from: CaseStatus,
  to: CaseStatus,
  isManager: boolean,
): string {
  if (!isCaseStatus(to)) return `Unknown target status: ${String(to)}`;
  if (from === to) return 'Case is already in that status';
  if (isTerminal(from)) return `Case is ${from}; terminal cases cannot move`;
  if (to === 'cancelled' && !isManager)
    return 'Only a manager can cancel a case';
  return `Illegal transition: ${from} -> ${to}`;
}
