/**
 * The audio iterator's `for await` rejects with InputDisposedError when
 * dispose() tears down mediabunny Inputs while the sink is still pending
 * (#1284). The loop body never runs, so `if (this.disposed) return` is not
 * enough — the throw happens in the iterator itself.
 */
import { InputDisposedError } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import {
  forAwaitUntilDisposed,
  isInputDisposedError,
} from './disposed-iterator';

/** Async iterable that rejects on the first `next()` — the dispose race. */
function throwingIterable<T>(err: Error): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return Promise.reject(err);
        },
      };
    },
  };
}

describe('isInputDisposedError', () => {
  it('matches mediabunny InputDisposedError', () => {
    expect(isInputDisposedError(new InputDisposedError())).toBe(true);
  });

  it('matches a duck-typed error with the same name (cross-chunk copies)', () => {
    const err = new Error('Input has been disposed.');
    err.name = 'InputDisposedError';
    expect(isInputDisposedError(err)).toBe(true);
  });

  it('rejects unrelated errors', () => {
    expect(isInputDisposedError(new Error('decode failed'))).toBe(false);
    expect(isInputDisposedError('Input has been disposed.')).toBe(false);
  });
});

describe('forAwaitUntilDisposed', () => {
  it('swallows InputDisposedError thrown by the iterator after dispose (#1284)', async () => {
    async function* iterator() {
      yield 1;
      throw new InputDisposedError();
    }
    let disposed = false;
    const seen: number[] = [];

    await expect(
      forAwaitUntilDisposed(
        iterator(),
        () => disposed,
        (value) => {
          seen.push(value);
          disposed = true;
        }
      )
    ).resolves.toBeUndefined();
    expect(seen).toEqual([1]);
  });

  it('does not start the loop body when dispose wins the race before the first yield', async () => {
    const seen: number[] = [];

    await expect(
      forAwaitUntilDisposed(
        throwingIterable<number>(new InputDisposedError()),
        () => true,
        (value) => {
          seen.push(value);
        }
      )
    ).resolves.toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('rethrows InputDisposedError when the engine is not disposed', async () => {
    await expect(
      forAwaitUntilDisposed(
        throwingIterable(new InputDisposedError()),
        () => false,
        () => undefined
      )
    ).rejects.toSatisfy((err) => isInputDisposedError(err));
  });

  it('rethrows unrelated errors even after dispose', async () => {
    await expect(
      forAwaitUntilDisposed(
        throwingIterable(new Error('decode failed')),
        () => true,
        () => undefined
      )
    ).rejects.toThrow('decode failed');
  });

  it('stops after isDisposed becomes true without pulling the next value', async () => {
    let pulls = 0;
    async function* iterator() {
      pulls += 1;
      yield 1;
      pulls += 1;
      yield 2;
    }
    const seen: number[] = [];

    await forAwaitUntilDisposed(
      iterator(),
      () => seen.length >= 1,
      (value) => {
        seen.push(value);
      }
    );
    expect(seen).toEqual([1]);
    expect(pulls).toBe(1);
  });
});
