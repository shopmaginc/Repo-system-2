import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DbRefreshToken, DbUser } from '../db.js';
import { verifyPassword } from '../lib/password.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
} from '../lib/tokens.js';
import { logAudit } from '../lib/audit.js';
import { ErrorCodes, apiError } from '../errors.js';

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(512),
});

const USER_LOGIN_SELECT = {
  include: { role: true },
} as const;

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /auth/login — email + password. Issues a short-lived JWT access
   * token and a rotating opaque refresh token.
   */
  app.post('/auth/login', { config: { public: true } }, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const email = body.email.toLowerCase().trim();

    const user = (await app.db.user.findUnique({
      where: { email },
      ...USER_LOGIN_SELECT,
    })) as (DbUser & { role: { name: string } }) | null;

    const fail = async (action: string, details?: Record<string, unknown>) => {
      await logAudit(app.db, {
        actorId: user?.id,
        action,
        ipAddress: request.ip,
        result: 'denied',
        details,
      });
      // Same message for unknown email / wrong password / inactive account:
      // never reveal which part failed.
      return reply
        .status(401)
        .send(apiError(ErrorCodes.UNAUTHORIZED, 'Invalid email or password'));
    };

    if (!user) return fail('auth.login.failed', { reason: 'unknown_email' });
    if (!(await verifyPassword(body.password, user.passwordHash))) {
      return fail('auth.login.failed', { reason: 'bad_password' });
    }
    if (user.status !== 'active') {
      return fail('auth.login.inactive', { status: user.status });
    }

    const accessToken = await reply.jwtSign(
      { role: user.role.name },
      { sub: user.id, expiresIn: `${app.config.JWT_ACCESS_TTL_SECONDS}s` },
    );
    const { token: refreshToken, tokenHash } = generateRefreshToken();
    await app.db.refreshToken.create({
      data: { tokenHash, userId: user.id, expiresAt: refreshTokenExpiry() },
    });

    await logAudit(app.db, {
      actorId: user.id,
      action: 'auth.login',
      ipAddress: request.ip,
      result: 'success',
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: app.config.JWT_ACCESS_TTL_SECONDS,
    };
  });

  /**
   * POST /auth/refresh — rotate a refresh token into a new pair.
   * The presented token is revoked (single-use) to limit replay.
   */
  app.post('/auth/refresh', { config: { public: true } }, async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    const tokenHash = hashRefreshToken(body.refreshToken);

    const stored = (await app.db.refreshToken.findUnique({
      where: { tokenHash },
    })) as DbRefreshToken | null;

    if (
      !stored ||
      stored.revokedAt !== null ||
      stored.expiresAt.getTime() < Date.now()
    ) {
      await logAudit(app.db, {
        action: 'auth.refresh.denied',
        ipAddress: request.ip,
        result: 'denied',
      });
      return reply
        .status(401)
        .send(apiError(ErrorCodes.UNAUTHORIZED, 'Invalid refresh token'));
    }

    const user = (await app.db.user.findUnique({
      where: { id: stored.userId },
      ...USER_LOGIN_SELECT,
    })) as (DbUser & { role: { name: string } }) | null;

    // Suspended/revoked users cannot refresh — sessions die immediately.
    if (!user || user.status !== 'active') {
      await app.db.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      });
      await logAudit(app.db, {
        actorId: stored.userId,
        action: 'auth.refresh.inactive',
        ipAddress: request.ip,
        result: 'denied',
      });
      return reply
        .status(401)
        .send(apiError(ErrorCodes.UNAUTHORIZED, 'Account is not active'));
    }

    // Rotate: revoke the presented token, issue a fresh pair.
    await app.db.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    const accessToken = await reply.jwtSign(
      { role: user.role.name },
      { sub: user.id, expiresIn: `${app.config.JWT_ACCESS_TTL_SECONDS}s` },
    );
    const next = generateRefreshToken();
    await app.db.refreshToken.create({
      data: { tokenHash: next.tokenHash, userId: user.id, expiresAt: refreshTokenExpiry() },
    });

    await logAudit(app.db, {
      actorId: user.id,
      action: 'auth.refresh',
      ipAddress: request.ip,
      result: 'success',
    });

    return {
      accessToken,
      refreshToken: next.token,
      expiresIn: app.config.JWT_ACCESS_TTL_SECONDS,
    };
  });

  /**
   * POST /auth/logout — revoke the presented refresh token.
   * Access tokens are short-lived (15 min); logout kills the refresh chain.
   */
  app.post('/auth/logout', { config: { public: true } }, async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    const tokenHash = hashRefreshToken(body.refreshToken);
    const stored = (await app.db.refreshToken.findUnique({
      where: { tokenHash },
    })) as DbRefreshToken | null;

    if (stored && stored.revokedAt === null) {
      await app.db.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      });
      await logAudit(app.db, {
        actorId: stored.userId,
        action: 'auth.logout',
        ipAddress: request.ip,
        result: 'success',
      });
    }
    return { ok: true };
  });

  /**
   * GET /auth/me — the authenticated user's profile. Used by clients for
   * display (name/role on badges, business cards) — never includes secrets.
   */
  app.get('/me', async (request) => {
    const u = request.authUser!;
    return {
      user: {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        canCaptureLotPhotos: u.canCaptureLotPhotos,
      },
    };
  });
}
