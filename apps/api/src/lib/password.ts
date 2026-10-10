import bcrypt from 'bcryptjs';

/**
 * Password hashing via bcrypt. Cost factor 12 is a deliberate balance:
 * slow enough to resist offline brute force, fast enough not to hurt login UX.
 */
const COST_FACTOR = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST_FACTOR);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  // bcrypt.compare runs in constant-ish time for wrong passwords too; also
  // guard against empty inputs explicitly.
  if (!password || !hash) return false;
  return bcrypt.compare(password, hash);
}
