import { z } from 'zod';
import { describe, expect, test } from 'vitest';
import { isLlmAuthError, sanitizeFailResponse } from './sanitize-fail-response';

describe('sanitizeFailResponse', () => {
  test('passes through a normal error string unchanged', () => {
    expect(sanitizeFailResponse('Something went wrong')).toBe(
      'Something went wrong'
    );
  });

  test('extracts inner message from QStash wrapper pattern', () => {
    const wrapped =
      "Couldn't parse 'failResponse' in 'failureFunction', received: 'error code: 1102'";
    expect(sanitizeFailResponse(wrapped)).toBe(
      'Worker exceeded memory limit (error code: 1102)'
    );
  });

  test('maps known CF error code 1102 to friendly message', () => {
    expect(sanitizeFailResponse('error code: 1102')).toBe(
      'Worker exceeded memory limit (error code: 1102)'
    );
  });

  test('extracts inner text for unknown error codes', () => {
    const wrapped =
      "Couldn't parse 'failResponse' in 'failureFunction', received: 'some unexpected error'";
    expect(sanitizeFailResponse(wrapped)).toBe('some unexpected error');
  });

  test('truncates excessively long messages', () => {
    const long = 'x'.repeat(600);
    const result = sanitizeFailResponse(long);
    expect(result.length).toBeLessThanOrEqual(501); // 500 + ellipsis char
    expect(result.endsWith('…')).toBe(true);
  });

  test('handles empty string', () => {
    expect(sanitizeFailResponse('')).toBe('Unknown error');
  });

  test('handles null/undefined', () => {
    expect(sanitizeFailResponse(null)).toBe('Unknown error');
    expect(sanitizeFailResponse(undefined)).toBe('Unknown error');
  });

  test('handles non-string values', () => {
    expect(sanitizeFailResponse(42)).toBe('42');
  });

  test('extracts message-bearing field from object failResponse', () => {
    expect(sanitizeFailResponse({ error: 'bad' })).toBe('bad');
    expect(sanitizeFailResponse({ message: 'something broke' })).toBe(
      'something broke'
    );
    expect(sanitizeFailResponse({ statusText: 'Bad Gateway' })).toBe(
      'Bad Gateway'
    );
  });

  test('walks Error.cause when top-level is empty', () => {
    const cause = new Error('underlying cause');
    expect(sanitizeFailResponse({ cause })).toBe('underlying cause');
  });

  test('serializes non-enumerable Error fields instead of returning "{}"', () => {
    // Errors crossing QStash step boundaries lose their `instanceof Error`
    // identity but keep `.message` as a non-enumerable own property — the
    // old `JSON.stringify` path rendered these as the useless string "{}".
    const errlike: Record<string, unknown> = Object.create(null);
    Object.defineProperty(errlike, 'message', {
      value: 'lost across boundary',
      enumerable: false,
    });
    expect(sanitizeFailResponse(errlike)).toBe('lost across boundary');
  });

  test('returns "Unknown error" for an empty object', () => {
    expect(sanitizeFailResponse({})).toBe('Unknown error');
  });
});

describe('isLlmAuthError', () => {
  test('detects 401 / Unauthorized', () => {
    expect(isLlmAuthError('LLM stream error: 401 Unauthorized')).toBe(true);
    expect(isLlmAuthError('OpenRouter returned 401')).toBe(true);
  });

  test('detects 403 / Forbidden', () => {
    expect(isLlmAuthError('403 Forbidden')).toBe(true);
  });

  test('detects OpenRouter no-auth-credentials message', () => {
    expect(isLlmAuthError('No auth credentials found')).toBe(true);
  });

  test('detects invalid-api-key message case-insensitively', () => {
    expect(isLlmAuthError('Invalid API key: sk-or-...')).toBe(true);
  });

  test('does not match unrelated errors', () => {
    expect(isLlmAuthError('Request timed out')).toBe(false);
    expect(isLlmAuthError('500 Internal Server Error')).toBe(false);
    expect(isLlmAuthError('Rate limit exceeded')).toBe(false);
  });
});

describe('sanitizeFailResponse with a ZodError', () => {
  test('stores one line, not the raw issue array (#1285)', () => {
    const error = z.enum(['film', 'tech']).safeParse('documentary').error;
    expect(sanitizeFailResponse(error)).toBe(
      'Invalid option: expected one of "film"|"tech"'
    );
  });
});
