/**
 * `@tanstack/ai-grok` used to carry a stale 4000-character prompt check named
 * after `grok-2-image-1212`, and it ran on EVERY image call — `generateImages`
 * and `editImages` both call `validatePrompt` before any model branching — so
 * it also rejected the Imagine models we actually use, for which xAI documents
 * no cap (#1754). We patched it out under `patches/` until upstream dropped it
 * in 0.19 (the patch is gone with it).
 *
 * #1640's dependency bump once put the throw back silently, and a record run
 * then failed every character and location sheet before a request left the
 * process. This test fails instead if an ai-grok bump reintroduces it — then
 * re-create the patch for the new version (`bun patch`) and wire it through
 * `patchedDependencies`.
 *
 * It reads the installed file rather than importing it: the package's
 * `exports` map has no entry for that path, and the only public route to
 * `validatePrompt` is `generateImages`, which would go on to make a real
 * request once the prompt passed.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const VALIDATOR =
  'node_modules/@tanstack/ai-grok/dist/esm/image/image-provider-options.js';

describe('ai-grok prompt cap patch', () => {
  it('has the grok-2-image-1212 length throw patched out', () => {
    const source = readFileSync(VALIDATOR, 'utf8');
    // The model name alone is not the marker — it also names a size map and a
    // comment. The throw is.
    expect(source).toContain('Prompt cannot be empty.');
    expect(source).not.toContain('prompt length must be less than or equal to');
  });
});
