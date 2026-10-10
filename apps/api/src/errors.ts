import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

/** Short machine-readable error codes returned to clients. */
export const ErrorCodes = {
  VALIDATION: 'validation_error',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  INTERNAL: 'internal_error',
} as const;

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function apiError(code: string, message: string, details?: unknown): ApiErrorBody {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

/**
 * Central error handler. Maps known errors to clean shapes and NEVER leaks
 * stack traces or internals to clients.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof ZodError) {
      return reply
        .status(400)
        .send(
          apiError(
            ErrorCodes.VALIDATION,
            'Request validation failed',
            err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          ),
        );
    }
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    // Fastify throws 4xx with safe messages (e.g. body parsing); pass those
    // through, but never internal 5xx detail.
    if (status >= 400 && status < 500) {
      const code =
        status === 401
          ? ErrorCodes.UNAUTHORIZED
          : status === 403
            ? ErrorCodes.FORBIDDEN
            : status === 404
              ? ErrorCodes.NOT_FOUND
              : status === 409
                ? ErrorCodes.CONFLICT
                : ErrorCodes.VALIDATION;
      return reply.status(status).send(apiError(code, err.message || 'Request failed'));
    }
    app.log.error(err);
    return reply.status(500).send(apiError(ErrorCodes.INTERNAL, 'Something went wrong'));
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send(apiError(ErrorCodes.NOT_FOUND, 'Route not found'));
  });
}
