/**
 * Custom error classes for better error handling and categorization.
 *
 * Server-fn boundary: seroval itself preserves own props on Errors, but
 * TanStack Router registers `ShallowErrorPlugin` in `defaultSerovalPlugins`,
 * and that plugin matches EVERY `Error` and serializes only `message` —
 * `code`, `statusCode`, `details` and even `name` are dropped in transit.
 * (#1087 blamed seroval; #1099 traced it to the plugin.)
 *
 * The adapter at the bottom of this file wins because
 * `getDefaultSerovalPlugins()` builds `[...serializationAdapters,
 * ...defaultSerovalPlugins]` and seroval uses the FIRST plugin whose `test()`
 * passes. Two things keep that working, and both are silent if broken:
 *   1. the adapter stays registered in `createStart` (src/start.ts), and
 *   2. custom adapters keep being ordered ahead of the defaults.
 * `errors.test.ts` pins both. Branch on `errorCode()`, never on message prose.
 */

import { createSerializationAdapter } from '@tanstack/react-router';

export class OpenStoryError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;

    // V8-only, and since #1099 this constructor also runs in the browser
    // (fromSerializable). An unguarded call throws a TypeError inside seroval
    // deserialization on non-V8 engines, which would swallow the whole
    // server-fn response instead of surfacing the error it carries.
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      details: this.details,
    };
  }
}

export class DatabaseError extends OpenStoryError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'DATABASE_ERROR', 500, details);
  }
}

export class ConnectionError extends OpenStoryError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONNECTION_ERROR', 503, details);
  }
}

export class ValidationError extends OpenStoryError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, details);
  }
}

/** The write collides with an existing resource (e.g. a duplicate slug). */
export class ConflictError extends OpenStoryError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFLICT', 409, details);
  }
}

export class ConfigurationError extends OpenStoryError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIGURATION_ERROR', 500, details);
  }
}

export class StorageError extends OpenStoryError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'STORAGE_ERROR', 500, details);
  }
}

export class AuthenticationError extends OpenStoryError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'AUTHENTICATION_ERROR', 401, details);
  }
}

export class NotFoundError extends OpenStoryError {
  constructor(
    message: string = 'Not found',
    details?: Record<string, unknown>
  ) {
    super(message, 'NOT_FOUND', 404, details);
  }
}

export class InsufficientCreditsError extends OpenStoryError {
  constructor(
    message: string = 'Insufficient credits',
    details?: Record<string, unknown>
  ) {
    super(message, 'INSUFFICIENT_CREDITS', 402, details);
  }
}

/**
 * A live enforcement action blocks what the caller tried to do (#1180).
 *
 * 403, not 402: the account is not short of anything it can top up. `details`
 * carries the action type and the user-facing notice so the client can explain
 * the block and link to the appeal route instead of showing a bare error.
 */
export class AccountRestrictedError extends OpenStoryError {
  constructor(
    message: string = 'This account is restricted',
    details?: Record<string, unknown>
  ) {
    super(message, 'ACCOUNT_RESTRICTED', 403, details);
  }
}

/**
 * A rights attestation is required for this upload and was not supplied
 * (#1180). 400 rather than 403: the request itself is incomplete, and the fix
 * is to resubmit with the attestation.
 */
export class AttestationRequiredError extends OpenStoryError {
  constructor(
    message: string = 'A rights attestation is required for this upload',
    details?: Record<string, unknown>
  ) {
    super(message, 'ATTESTATION_REQUIRED', 400, details);
  }
}

/**
 * Stable machine-readable code from a thrown value.
 *
 * Structural, not nominal: it reads a string `.code` off anything that has one
 * — live `OpenStoryError`s on the server, the instances
 * `openStoryErrorSerializationAdapter` reconstructs on the client, and also
 * foreign errors that happen to carry a `code` (Stripe, Node `ENOENT`, …).
 */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Is this OUR insufficient-credits failure? Callers gate the billing dialog on it. */
export function isInsufficientCreditsError(error: unknown): boolean {
  return errorCode(error) === 'INSUFFICIENT_CREDITS';
}

/**
 * Display text for an arbitrary thrown value. A Zod failure — a live
 * `ZodError`, or one that crossed the server-fn boundary as its JSON `message`
 * (#1285) — collapses to one `path: message` line per issue instead of the raw
 * issue array.
 */
export function errorMessage(
  error: unknown,
  fallback = 'Unknown error'
): string {
  if (!(error instanceof Error)) return fallback;
  return zodIssuesLine(error.message) ?? error.message;
}

function zodIssuesLine(message: string): string | null {
  if (!message.startsWith('[')) return null;
  let issues: unknown;
  try {
    issues = JSON.parse(message);
  } catch {
    return null;
  }
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const lines: string[] = [];
  for (const issue of issues) {
    if (!isRecord(issue) || typeof issue.message !== 'string') return null;
    const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
    lines.push(path ? `${path}: ${issue.message}` : issue.message);
  }
  return lines.join('; ');
}

/**
 * Utility function to handle and format errors consistently for API routes
 */
export const handleApiError = (error: unknown): OpenStoryError => {
  if (error instanceof OpenStoryError) {
    return error;
  }

  if (error instanceof Error) {
    return new OpenStoryError(error.message, 'INTERNAL_ERROR', 500, {
      originalError: error.name,
    });
  }

  return new OpenStoryError('An unknown error occurred', 'UNKNOWN_ERROR', 500, {
    originalError: typeof error,
  });
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Round-trips OpenStoryError through the server-fn seroval envelope so
 * `code`/`statusCode`/`details` survive to the client. Details ride as JSON to
 * stay inside seroval's serializable value set. Registered in `createStart`
 * (src/start.ts) — see this file's header for why ordering matters.
 *
 * Subclass identity is deliberately NOT preserved: every error arrives as a
 * base `OpenStoryError` with `name` patched back on, so client-side
 * `instanceof InsufficientCreditsError` is always false. Discriminate with
 * `errorCode()` / `isInsufficientCreditsError()`.
 *
 * Both JSON hops are guarded because they run *while serializing an error*:
 * a circular ref in `details` would otherwise replace a clean 402 with an
 * opaque serialization failure and the billing gate would never open.
 */
export const openStoryErrorSerializationAdapter = createSerializationAdapter({
  key: 'openstory-error',
  test: (value): value is OpenStoryError => value instanceof OpenStoryError,
  toSerializable: (error) => ({
    name: error.name,
    message: error.message,
    code: error.code,
    statusCode: error.statusCode,
    detailsJson: safeStringify(error.details),
  }),
  fromSerializable: (value) => {
    const error = new OpenStoryError(
      value.message,
      value.code,
      value.statusCode,
      safeParseRecord(value.detailsJson)
    );
    error.name = value.name;
    return error;
  },
});

/** Details are diagnostic — losing them must never lose the error itself. */
function safeStringify(
  details: Record<string, unknown> | undefined
): string | undefined {
  if (!details) return undefined;
  try {
    return JSON.stringify(details);
  } catch {
    return undefined;
  }
}

function safeParseRecord(json: string | undefined) {
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
