/**
 * Plate normalization for the ALPR subsystem.
 *
 * Plates are stored and matched in a canonical form: uppercase with all
 * whitespace and dashes stripped (e.g. "abc 123" -> "ABC123"). Every write
 * path (list entries, hit reports) and every match lookup MUST go through
 * this function so a plate scanned as "ABC-123" matches a list entry saved
 * as "abc 123".
 */
export function normalizePlate(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, '');
}
