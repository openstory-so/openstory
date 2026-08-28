/**
 * workerd's global `fetch` is a method. Calling it after a getter returns it
 * (`this.fetch(url)` in @tanstack/ai-grok's video adapter) binds `this` to
 * the adapter and throws:
 *   Illegal invocation: function called with incorrect `this` reference
 *
 * An arrow function ignores the call-site `this` and re-dispatches through
 * `globalThis.fetch`.
 */
export const workersSafeFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, init);
