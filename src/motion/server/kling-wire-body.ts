/**
 * Kling rejects `prompt` together with `multi_prompt`. The parsed request
 * still carries a prompt string — the longest shot, which is what
 * `generateVideo` and the schema length check need — and this is the body
 * that may go to fal.
 */
export function klingWireInput<T extends { prompt?: unknown }>(input: T): T {
  if (!hasMultiPrompt(input)) return input;
  const { prompt: _prompt, ...rest } = input;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- packed Kling body is T minus prompt
  return rest as unknown as T;
}

function hasMultiPrompt(input: object): boolean {
  if (!('multi_prompt' in input)) return false;
  const multi = input.multi_prompt;
  return Array.isArray(multi) && multi.length > 0;
}

/**
 * `@tanstack/ai-fal` copies the `generateVideo` prompt onto the queue body
 * after `modelOptions`. A packed job has to send that string (the adapter
 * requires one) and then take it off the body fal actually receives (#2271).
 */
export function stripPackedKlingPrompt(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    const body = init?.body;
    if (typeof body !== 'string') return fetchImpl(input, init);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return fetchImpl(input, init);
    }
    if (!isPromptRecord(parsed)) return fetchImpl(input, init);
    const wire = klingWireInput(parsed);
    if (wire === parsed) return fetchImpl(input, init);
    return fetchImpl(input, { ...init, body: JSON.stringify(wire) });
  };
}

function isPromptRecord(value: unknown): value is { prompt?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
