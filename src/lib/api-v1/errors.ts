/**
 * JSON error handling for the public `/api/v1/*` routes. Programmatic callers
 * get a stable `{ error: { code, message, details? } }` envelope and the right
 * HTTP status — never an HTML page or redirect.
 */

import { handleApiError, OpenStoryError } from '@/lib/errors';
import { getLogger, toErrorPayload } from '@/lib/observability/logger';
import { z } from 'zod';

const logger = getLogger(['openstory', 'api-v1']);

export function apiJsonError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  headers?: HeadersInit
): Response {
  return Response.json(
    { error: { code, message, details } },
    { status, headers }
  );
}

/**
 * Run a public-API route handler, translating thrown errors into the JSON
 * envelope: Zod → 400 with field issues, `OpenStoryError` → its own status,
 * anything else → 500. Keeps every v1 route's catch block identical.
 */
export async function runApiV1Handler(
  fn: () => Promise<Response>
): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiJsonError(400, 'VALIDATION_ERROR', 'Invalid request body.', {
        issues: error.issues,
      });
    }
    // A handler may throw a ready-made Response (e.g. from middleware-style
    // guards); pass it straight through.
    if (error instanceof Response) {
      return error;
    }
    const handled: OpenStoryError = handleApiError(error);
    if (handled.statusCode >= 500) {
      logger.error('api/v1 handler failed: {code} {message}', {
        code: handled.code,
        message: handled.message,
        // Keep the original error (stack/cause) so a 500 is traceable later.
        err: toErrorPayload(error),
      });
    }
    return apiJsonError(handled.statusCode, handled.code, handled.message);
  }
}
