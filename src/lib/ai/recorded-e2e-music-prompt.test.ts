import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reconstructRecordedMusicDesignPrompt } from './recorded-e2e-music-prompt';

const MUSIC_DESIGN_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../e2e/fixtures/recorded/openrouter/music-design/music-design.json'
);

describe('reconstructRecordedMusicDesignPrompt', () => {
  it('matches the recorded music-design aimock matcher', async () => {
    const data: {
      fixtures: Array<{ match: { userMessage: string } }>;
    } = JSON.parse(readFileSync(MUSIC_DESIGN_PATH, 'utf8'));
    const userMessage = data.fixtures[0]?.match.userMessage;
    expect(userMessage).toBe(await reconstructRecordedMusicDesignPrompt());
  });
});
