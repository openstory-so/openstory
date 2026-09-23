/**
 * `@tanstack/ai-grok` carries a stale 4000-character prompt check named after
 * `grok-2-image-1212`, and it runs on EVERY image call — `generateImages` and
 * `editImages` both call `validatePrompt` before any model branching — so it
 * also rejects the Imagine models we actually use, for which xAI documents no
 * cap (#1754). `patches/` removes it.
 *
 * The patch is keyed to an exact version, so an ai-grok bump drops it
 * silently: that is how #1640's dependency bump put the throw back, and a
 * record run then failed every character and location sheet before a request
 * left the process. This test fails instead. When it does, copy the patch to
 * the new version and update `patchedDependencies` — or delete both if
 * upstream gates the check on the model.
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
