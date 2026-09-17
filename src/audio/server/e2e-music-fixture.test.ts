import { readFileSync } from 'node:fs';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { expect, it } from 'vitest';

it('replays native music as playable MP3 audio', async () => {
  // Replay uses two seconds of silent MP3, not provider-generated music.
  // An ID3 prefix alone passed generation but failed the browser's playback
  // check; parse the actual bytes with the same demuxer as the theatre.
  const data: {
    fixtures: Array<{ response: { audio: string; format: string } }>;
  } = JSON.parse(
    readFileSync('e2e/fixtures/recorded/elevenlabs/music-replay.json', 'utf8')
  );
  expect(data.fixtures.length).toBeGreaterThan(0);
  for (const { response } of data.fixtures) {
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(Buffer.from(response.audio, 'base64')),
    });
    try {
      expect(response.format).toBe('mp3');
      expect((await input.getFormat()).name).toBe('MP3');
      expect(await input.getAudioTracks()).toHaveLength(1);
      expect(await input.computeDuration()).toBeGreaterThan(0);
    } finally {
      input.dispose();
    }
  }
});
