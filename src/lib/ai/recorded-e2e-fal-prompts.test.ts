import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reconstructRecordedFalEditPrompts } from './recorded-e2e-fal-prompts';

const V2_EDIT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../e2e/fixtures/recorded/fal/xai-grok-imagine-image-v2.0-edit'
);

function loadEditUserMessages(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const data: {
        fixtures: Array<{ match: { userMessage: string } }>;
      } = JSON.parse(readFileSync(resolve(dir, name), 'utf8'));
      const userMessage = data.fixtures[0]?.match.userMessage;
      if (!userMessage) throw new Error(`No userMessage in ${name}`);
      return userMessage;
    });
}

describe('reconstructRecordedFalEditPrompts', () => {
  it('matches every reconstructed Grok v2.0/edit aimock matcher', () => {
    const fixtures = loadEditUserMessages(V2_EDIT_DIR);
    const missing = reconstructRecordedFalEditPrompts()
      .filter((live) => !fixtures.includes(live.prompt))
      .map((live) => `${live.kind} scene ${live.sceneNumber}`);
    expect(missing).toEqual([]);
  });
});
