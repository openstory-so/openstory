import { errorMessage } from '@/lib/errors';

const MAX_MESSAGE_LENGTH = 500;

/** Known Cloudflare error codes mapped to human-readable messages */
const CF_ERROR_CODES: Record<string, string> = {
  '1102': 'Worker exceeded memory limit',
};

/**
 * Extract a useful error message from QStash failResponse.
 *
 * QStash wraps the actual error in a pattern like:
 *   "Couldn't parse 'failResponse' in 'failureFunction', received: '<actual error>'"
 *
 * This function extracts the inner error and maps known codes to friendly messages.
 */
export function sanitizeFailResponse(failResponse: unknown): string {
  const raw = extractRawMessage(failResponse).trim();
  if (!raw) return 'Unknown error';

  // Extract inner message from QStash wrapper pattern
  const wrapperMatch = raw.match(/received:\s*'(.+)'$/s);
  const innerMessage = wrapperMatch?.[1];
  const message = innerMessage ? innerMessage.trim() : raw;

  // Map known CF error codes
  const codeMatch = message.match(/error code:\s*(\d+)/i);
  const code = codeMatch?.[1];
  if (code) {
    const friendly = CF_ERROR_CODES[code];
    if (friendly) return `${friendly} (error code: ${code})`;
  }

  // Truncate excessively long messages
  if (message.length > MAX_MESSAGE_LENGTH) {
    return `${message.slice(0, MAX_MESSAGE_LENGTH)}…`;
  }

  return message;
}

// QStash failure functions can receive a failResponse whose `JSON.stringify`
// renders as `"{}"` because the error's enumerable own properties are empty
// (e.g. an Error reconstituted across step boundaries, a fetch Response, or
// an HTTPError-style object). Walk known message-bearing fields and the full
// property set including non-enumerables before giving up.
function extractRawMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (value instanceof Error) return errorMessage(value) || value.toString();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value !== 'object') return '';

  // Index by name so we also pick up non-enumerable own properties like
  // Error.message — Object.entries would skip those. We've already narrowed
  // value to a non-null object, so the cast is safe by construction.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- narrowed above
  const record = value as Record<string, unknown>;
  const obj: Record<string, unknown> = {};
  for (const k of Object.getOwnPropertyNames(value)) {
    obj[k] = record[k];
  }
  for (const field of [
    'message',
    'error',
    'description',
    'statusText',
  ] as const) {
    const candidate = obj[field];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  if (typeof obj.cause !== 'undefined') {
    const fromCause = extractRawMessage(obj.cause);
    if (fromCause) return fromCause;
  }

  // Fall back to JSON.stringify of the full property set (including
  // non-enumerables) so values like Error.message that would normally
  // serialize to "{}" are visible.
  const serialized = JSON.stringify(obj);
  return serialized && serialized !== '{}' ? serialized : '';
}

/**
 * Detect whether an error message indicates the LLM provider rejected the API
 * key (revoked, expired, or otherwise unauthorised) — OpenRouter directly, or
 * fal's OpenRouter endpoint when the call was fal-routed (issue #895). Used by
 * workflow failure handlers to mark a stored BYOK key invalid.
 */
export function isLlmAuthError(message: string): boolean {
  return /\b(401|403|unauthori[sz]ed|forbidden|no auth credentials|invalid api key)\b/i.test(
    message
  );
}
