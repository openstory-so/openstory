/**
 * Unit tests for `serializeError` — the cause-chain walker that makes a wrapped
 * driver error (e.g. the raw D1 error under drizzle's `DrizzleQueryError`)
 * observable in logs. The structured `{ err }` we hand to `logger.error` only
 * captures the top error's name/message/stack; `.cause` is dropped unless we
 * walk it (issue #864).
 */

import { describe, expect, it } from 'vitest';
import { type SerializedError, serializeError, toErrorPayload } from './logger';

/** Narrow a `SerializedError | string` to the object form, failing the test
 * (rather than casting) when it isn't one. */
function asSerialized(value: SerializedError | string): SerializedError {
  if (typeof value === 'string') {
    throw new Error(`expected a SerializedError object, got string: ${value}`);
  }
  return value;
}

describe('serializeError', () => {
  it('walks the .cause chain', () => {
    const root = new Error('D1_ERROR: storage overloaded');
    const wrapper = new Error('Failed query: select … from team_api_keys', {
      cause: root,
    });

    const result = serializeError(wrapper);

    expect(result).toMatchObject({
      name: 'Error',
      message: 'Failed query: select … from team_api_keys',
      cause: { name: 'Error', message: 'D1_ERROR: storage overloaded' },
    });
  });

  it('captures a multi-level cause chain', () => {
    const a = new Error('driver: connection reset');
    const b = new Error('query failed', { cause: a });
    const c = new Error('step failed', { cause: b });

    const result = serializeError(c);

    expect(result).toMatchObject({
      message: 'step failed',
      cause: {
        message: 'query failed',
        cause: { message: 'driver: connection reset' },
      },
    });
  });

  it('stops at maxDepth so a cyclic / very deep chain cannot recurse forever', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    // Force a cycle: a.cause -> b -> a -> …
    a.cause = b;

    const result = serializeError(a, 2);

    // Depth 2 yields a -> b -> a, then truncates (no `cause` on the innermost).
    expect(result).toMatchObject({
      message: 'a',
      cause: { message: 'b', cause: { message: 'a' } },
    });
    const innermost = asSerialized(
      asSerialized(asSerialized(result).cause ?? '').cause ?? ''
    );
    expect(innermost.message).toBe('a');
    expect(innermost.cause).toBeUndefined();
  });

  it('omits cause when there is none', () => {
    const result = serializeError(new Error('plain'));
    expect(result).toEqual({
      name: 'Error',
      message: 'plain',
      stack: expect.any(String),
    });
  });

  it('passes strings through and stringifies other non-errors', () => {
    expect(serializeError('boom')).toBe('boom');
    expect(serializeError(42)).toBe('42');
    expect(serializeError(null)).toBe('null');
  });
});

describe('toErrorPayload', () => {
  it('includes the cause chain when the error wraps one', () => {
    const root = new Error('D1_ERROR: too many connections');
    const wrapper = new Error('Failed query', { cause: root });

    const payload = toErrorPayload(wrapper);

    expect(payload).toMatchObject({
      code: 'UNKNOWN',
      message: 'Failed query',
      cause: { message: 'D1_ERROR: too many connections' },
    });
  });

  it('has no cause field for a plain error', () => {
    expect(toErrorPayload(new Error('plain')).cause).toBeUndefined();
  });
});
