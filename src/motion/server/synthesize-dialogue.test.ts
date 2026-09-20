import { describe, expect, it, vi } from 'vitest';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { voicedDialogueLines } from '@/motion/dialogue-tts';
import { pcmToWav } from './pad-dialogue-audio';

// Exercise the real SDK serializer without making a paid provider request.
const wav = pcmToWav(new Uint8Array(44100 * 2));
const fetchRequest = vi.fn<typeof fetch>(async () =>
  Response.json({
    audio_base64: Buffer.from(wav).toString('base64'),
    voice_segments: [],
  })
);
vi.doMock('@/models/server/elevenlabs-config', () => ({
  createElevenLabsSdk: async () =>
    new ElevenLabsClient({
      apiKey: 'test-key',
      fetch: fetchRequest,
    }),
}));
vi.doMock('#storage', () => ({
  uploadFile: vi.fn(async () => ({
    publicUrl: '/r2/dialogue.wav',
    fullPath: 'audio/dialogue.wav',
  })),
}));
const { recordDialogueCall } = await import('./synthesize-dialogue');

describe('recordDialogueCall voice identity', () => {
  it('sends each character’s selected voice to ElevenLabs and stores the recording', async () => {
    const lines = voicedDialogueLines(
      {
        presence: true,
        lines: [
          {
            character: 'Maya',
            line: 'What’s one thing Sydney gets right?',
            tone: 'bright and spontaneous',
          },
          { character: 'Young Man', line: 'The beaches.', tone: '' },
        ],
      },
      [
        { name: 'Maya', voiceId: 'maya-selected-voice' },
        { name: 'Young Man', voiceId: 'young-man-selected-voice' },
      ]
    );
    const recording = await recordDialogueCall({
      apiKey: 'test-key',
      teamId: 'team-1',
      sequenceId: 'seq-1',
      lines: lines.map((line) => ({ ...line, shotId: 'shot-1' })),
    });
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    const request = fetchRequest.mock.calls[0];
    const target = request?.[0];
    const url =
      target instanceof Request
        ? target.url
        : target instanceof URL
          ? target.href
          : target;
    expect(url).toContain('/v1/text-to-dialogue/with-timestamps');
    const body = request?.[1]?.body;
    if (typeof body !== 'string')
      throw new Error('Expected a JSON provider request');
    expect(JSON.parse(body)).toMatchObject({
      model_id: 'eleven_v3',
      inputs: [
        {
          voice_id: 'maya-selected-voice',
          text: '[bright and spontaneous] What’s one thing Sydney gets right?',
        },
        { voice_id: 'young-man-selected-voice', text: 'The beaches.' },
      ],
    });
    expect(recording.url).toBe('/r2/dialogue.wav');
    expect(recording.turns).toMatchObject([
      { voiceId: 'maya-selected-voice', ttsModel: 'eleven_v3' },
      { voiceId: 'young-man-selected-voice', ttsModel: 'eleven_v3' },
    ]);
  });
});
