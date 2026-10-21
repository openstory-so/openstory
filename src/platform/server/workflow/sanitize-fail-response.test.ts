import { z } from 'zod';
import { describe, expect, test } from 'vitest';
import { isLlmAuthError, sanitizeFailResponse } from './sanitize-fail-response';

describe('sanitizeFailResponse', () => {
  test('passes through a normal error string unchanged', () => {
    expect(sanitizeFailResponse('Something went wrong')).toBe(
      'Something went wrong'
    );
  });

  test('unwraps a single child workflow prefix', () => {
    expect(
      sanitizeFailResponse('Child workflow abc failed: actual error')
    ).toBe('actual error');
  });

  test('unwraps nested child workflow prefixes', () => {
    expect(
      sanitizeFailResponse(
        'Child workflow abc failed: Child workflow def failed: actual error'
      )
    ).toBe('actual error');
  });

  test('unwraps deeply nested child workflow prefixes with realistic IDs', () => {
    expect(
      sanitizeFailResponse(
        'Child workflow a:seq_1:run_1 failed: Child workflow b:seq_1:shot_2:model failed: Child workflow c failed: root error'
      )
    ).toBe('root error');
  });

  test('unwraps child workflow prefixes containing fallback "Error:" wrappers', () => {
    expect(
      sanitizeFailResponse(
        'Child workflow abc failed: Error: Child workflow def failed: Something went wrong'
      )
    ).toBe('Something went wrong');
    expect(
      sanitizeFailResponse(
        'Child workflow motion:01SEQ:01FRAME failed: Error: fal rejected the job'
      )
    ).toBe('fal rejected the job');
    expect(
      sanitizeFailResponse(
        'Child workflow abc failed: Error: Child workflow def failed: Error: Something went wrong'
      )
    ).toBe('Something went wrong');
  });

  test('unwraps the error name the status fallback puts in front', () => {
    expect(
      sanitizeFailResponse(
        'Child workflow a failed: NonRetryableError: Child workflow b failed: Shot too long'
      )
    ).toBe('Shot too long');
    expect(
      sanitizeFailResponse(
        'Child workflow a failed: NonRetryableError: fal rejected the job'
      )
    ).toBe('fal rejected the job');
  });

  test('leaves an error name alone when there is no child wrapper', () => {
    expect(sanitizeFailResponse('HTTPError: 502 from provider')).toBe(
      'HTTPError: 502 from provider'
    );
  });

  test('preserves child workflow context when unwrapping leaves generic "Unknown error"', () => {
    expect(
      sanitizeFailResponse('Child workflow abc failed: Unknown error')
    ).toBe('Child workflow abc failed: Unknown error');
  });

  test('preserves child workflow context when unwrapping leaves "no error detail"', () => {
    expect(
      sanitizeFailResponse('Child workflow abc failed: no error detail')
    ).toBe('Child workflow abc failed: no error detail');
  });

  test('preserves child workflow context when unwrapping leaves empty string, undefined, or null', () => {
    expect(sanitizeFailResponse('Child workflow abc failed:')).toBe(
      'Child workflow abc failed:'
    );
    expect(sanitizeFailResponse('Child workflow abc failed:   ')).toBe(
      'Child workflow abc failed:'
    );
    expect(sanitizeFailResponse('Child workflow abc failed: undefined')).toBe(
      'Child workflow abc failed: undefined'
    );
    expect(sanitizeFailResponse('Child workflow abc failed: null')).toBe(
      'Child workflow abc failed: null'
    );
  });

  test('preserves child workflow context on nested generic error', () => {
    expect(
      sanitizeFailResponse(
        'Child workflow a:seq_1 failed: Child workflow b:shot_1 failed: no error detail'
      )
    ).toBe(
      'Child workflow a:seq_1 failed: Child workflow b:shot_1 failed: no error detail'
    );
  });

  test('does not falsely unwrap multi-word sentences starting with "Child workflow"', () => {
    expect(
      sanitizeFailResponse('Child workflow batch run failed: database locked')
    ).toBe('Child workflow batch run failed: database locked');
  });

  test('handles mixed casing and whitespace in child workflow prefix', () => {
    expect(
      sanitizeFailResponse(
        'CHILD WORKFLOW abc FAILED:   custom failure message'
      )
    ).toBe('custom failure message');
  });

  test('maps known CF error code wrapped inside child workflow prefix', () => {
    expect(
      sanitizeFailResponse('Child workflow motion:01 failed: error code: 1102')
    ).toBe('Worker exceeded memory limit (error code: 1102)');
    expect(
      sanitizeFailResponse(
        'Child workflow motion:01 failed: Error: error code: 1102'
      )
    ).toBe('Worker exceeded memory limit (error code: 1102)');
  });

  test('maps known CF error code 1102 to friendly message', () => {
    expect(sanitizeFailResponse('error code: 1102')).toBe(
      'Worker exceeded memory limit (error code: 1102)'
    );
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
    // Errors crossing step boundaries lose their `instanceof Error`
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
