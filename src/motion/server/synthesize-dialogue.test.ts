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

describe('recordDialogueCall turn timing', () => {
  const cast = [
    { name: 'Maya', voiceId: 'voice-maya' },
    { name: 'Otto', voiceId: 'voice-otto' },
  ];
  const turn = (shotId: string, character: string, text: string) => {
    const [voiced] = voicedDialogueLines(
      { presence: true, lines: [{ character, line: text, tone: '' }] },
      cast
    );
    if (!voiced) throw new Error('line was not voiced');
    return { ...voiced, shotId };
  };
  // Two shots, three turns: shot-a speaks twice, then shot-b.
  const lines = [
    turn('shot-a', 'Maya', 'One.'),
    turn('shot-a', 'Otto', 'Two.'),
    turn('shot-b', 'Maya', 'Three.'),
  ];
  const segment = (at: number, start: number, end: number) => ({
    // The SDK parses the wire shape, so every required key is present.
    voice_id: 'voice-maya',
    character_start_index: 0,
    character_end_index: 1,
    dialogue_input_index: at,
    start_time_seconds: start,
    end_time_seconds: end,
  });
  const answerWith = (voiceSegments: unknown[]) =>
    fetchRequest.mockImplementationOnce(async () =>
      Response.json({
        audio_base64: Buffer.from(wav).toString('base64'),
        voice_segments: voiceSegments,
      })
    );
  const record = () =>
    recordDialogueCall({
      apiKey: 'test-key',
      teamId: 'team-1',
      sequenceId: 'seq-1',
      lines,
    });

  it('maps segments onto lines by input index, spanning a turn reported in pieces', async () => {
    // Out of order, turn 1 in two pieces, and the last end past the file.
    answerWith([
      segment(2, 0.7, 99),
      segment(1, 0.45, 0.6),
      segment(0, 0.05, 0.3),
      segment(1, 0.35, 0.4),
    ]);
    const recording = await record();
    const end = recording.durationSeconds;
    expect(
      recording.turns.map((t) => [t.shotId, t.startSeconds, t.endSeconds])
    ).toEqual([
      ['shot-a', 0.05, 0.3],
      ['shot-a', 0.35, 0.6],
      // Clamped to the recording: a range past the file cannot be cut.
      ['shot-b', 0.7, end],
    ]);
    // Each shot's window holds its own turns — never a neighbour's words.
    const windowOf = (shotId: string) =>
      recording.windows.find((window) => window.shotId === shotId);
    expect(windowOf('shot-a')?.fromSeconds).toBeLessThanOrEqual(0.05);
    expect(windowOf('shot-a')?.toSeconds).toBeGreaterThanOrEqual(0.6);
    expect(windowOf('shot-a')?.toSeconds).toBeLessThanOrEqual(0.7);
    expect(windowOf('shot-b')?.fromSeconds).toBeGreaterThanOrEqual(0.6);
    expect(windowOf('shot-b')?.toSeconds).toBe(end);
  });

  it('refuses to guess ranges when several shots come back with no segments', async () => {
    answerWith([]);
    await expect(record()).rejects.toThrow(/no voice segments/);
  });

  it('refuses a recording that leaves a turn untimed', async () => {
    answerWith([segment(0, 0, 0.3), segment(2, 0.7, 0.9)]);
    await expect(record()).rejects.toThrow(/no timing for turn 2\/3/);
  });
});
