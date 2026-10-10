import type { VinCandidate } from '@repo/shared';

/**
 * VIN helpers — Phase 1 order intake.
 *
 * extractVinCandidates pulls 17-character VIN-shaped tokens out of pasted
 * order text (RDN emails, PDFs-as-text, etc.) and reports whether each one
 * passes the ISO 3779 check-digit test. Candidates are returned for a human
 * to confirm — the API never auto-creates asset records from uncertain text.
 */

const VIN_TOKEN = /[A-HJ-NPR-Z0-9]{17}/g;

// ISO 3779 transliteration: letters -> digits (I, O, Q never appear in VINs).
const TRANSLITERATION: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};

// Position weights for the 17 VIN positions.
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** Normalize a raw scan/paste: uppercase, strip everything non-alphanumeric. */
export function normalizeVin(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** True when the 17-char VIN's 9th character matches the computed check digit. */
export function isCheckDigitValid(vin: string): boolean {
  const v = normalizeVin(vin);
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = v[i];
    const digit = /[0-9]/.test(ch) ? Number(ch) : TRANSLITERATION[ch];
    if (digit === undefined) return false;
    sum += digit * WEIGHTS[i];
  }
  const remainder = sum % 11;
  const expected = remainder === 10 ? 'X' : String(remainder);
  return v[8] === expected;
}

/**
 * Pull VIN candidates from free text. Duplicates are collapsed; each
 * candidate is flagged with its check-digit result so intake staff can
 * confirm the right one before it becomes an asset record.
 */
export function extractVinCandidates(text: string): VinCandidate[] {
  const upper = text.toUpperCase();
  const seen = new Set<string>();
  const out: VinCandidate[] = [];
  for (const match of upper.matchAll(VIN_TOKEN)) {
    const vin = match[0];
    if (seen.has(vin)) continue;
    seen.add(vin);
    out.push({ vin, checkDigitValid: isCheckDigitValid(vin) });
  }
  return out;
}
