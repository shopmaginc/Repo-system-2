import { createHash, randomBytes } from 'node:crypto';

/**
 * Refresh tokens are opaque random values. Only their SHA-256 hash is stored,
 * so a database read alone never yields a usable token.
 */
export function generateRefreshToken(): { token: string; tokenHash: string } {
  const token = randomBytes(48).toString('hex'); // 384 bits of entropy
  const tokenHash = createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Refresh tokens live 30 days; they are rotated on every use. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function refreshTokenExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + REFRESH_TOKEN_TTL_MS);
}
