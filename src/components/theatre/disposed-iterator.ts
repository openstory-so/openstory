/**
 * Dispose-safe consumption of mediabunny async iterators.
 *
 * `Input.dispose()` rejects any in-flight `for await` with InputDisposedError
 * *before* the loop body runs, so a `if (this.disposed) return` inside the
 * body never sees the throw. Wrap the iterator so a dispose() racing play()
 * is a quiet shutdown rather than an unhandled rejection (#1284).
 */

import { InputDisposedError } from 'mediabunny';

export function isInputDisposedError(err: unknown): boolean {
  return (
    err instanceof InputDisposedError ||
    (err instanceof Error && err.name === 'InputDisposedError')
  );
}

/**
 * Iterate `iterator` until it exhausts, `isDisposed()` is true, or it throws.
 * `InputDisposedError` is swallowed only while disposed; every other error
 * (and an InputDisposedError while still live) is rethrown.
 */
export async function forAwaitUntilDisposed<T>(
  iterator: AsyncIterable<T>,
  isDisposed: () => boolean,
  onValue: (value: T) => Promise<void> | void
): Promise<void> {
  try {
    for await (const value of iterator) {
      if (isDisposed()) return;
      await onValue(value);
      if (isDisposed()) return;
    }
  } catch (err) {
    if (isDisposed() && isInputDisposedError(err)) return;
    throw err;
  }
}
