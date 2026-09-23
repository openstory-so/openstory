import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { expect, it } from 'vitest';

const FIXTURE_DIR = 'e2e/fixtures/recorded/elevenlabs';

type MusicFixture = {
  match: { endpoint?: string };
  response: { audio: string; format?: string };
};

/**
 * Every recorded music take, by endpoint rather than by filename: the
 * recorder names files from the prompt, so a re-record renames them
 * (#1640). TTS fixtures in the same folder are deliberately not included —
 * theirs is a stub, and only music is played back as a file.
 */
function musicFixtures(): MusicFixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const data: { fixtures: MusicFixture[] } = JSON.parse(
        readFileSync(join(FIXTURE_DIR, name), 'utf8')
      );
      return data.fixtures.filter((f) => f.match.endpoint === 'audio-gen');
    });
}

it('replays native music as playable MP3 audio', async () => {
  // An ID3 prefix alone passed generation but failed the browser's playback
  // check; parse the actual bytes with the same demuxer as the theatre. This
  // is also what keeps a trimmed take honest — a cut that lost the audio
  // would still be a file, but not a playable one.
  const fixtures = musicFixtures();
  expect(fixtures.length).toBeGreaterThan(0);
  for (const { response } of fixtures) {
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(Buffer.from(response.audio, 'base64')),
    });
    try {
      if (response.format !== undefined) expect(response.format).toBe('mp3');
      expect((await input.getFormat()).name).toBe('MP3');
      expect(await input.getAudioTracks()).toHaveLength(1);
      expect(await input.computeDuration()).toBeGreaterThan(0);
    } finally {
      input.dispose();
    }
  }
});
