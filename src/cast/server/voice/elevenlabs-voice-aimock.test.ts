/**
 * Voice Design against the aimock mock, not a hand-written double (#1640).
 *
 * aimock 1.43 dispatches the four Voice Design routes (CopilotKit/aimock#454),
 * which is what lets an e2e run replay them. Nothing in the Playwright suite
 * turns `generateVoices` on yet, so this is the only place the client half —
 * the `@tanstack/ai-elevenlabs` adapter for design, the official SDK for
 * save/get/delete — is exercised against the mock's actual wire shapes.
 *
 * It also pins what a recorded tape must contain: STRICT replay refuses every
 * one of these calls without a fixture (aimock only synthesises a voice when
 * lenient), and each route matches on its own endpoint key and match text —
 * the description for design, the `generated_voice_id` for create, the voice
 * id for get/delete.
 */

import { LLMock } from '@copilotkit/aimock';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DESCRIPTION =
  'A warm, gravelly narrator in his sixties, unhurried and dry.';
const GENERATED_VOICE_ID = 'gv_aimock_1';
const VOICE_ID = 'voice_aimock_1';

const mock = new LLMock({ port: 4098, strict: true, logLevel: 'silent' });
let baseURL = '';

beforeAll(async () => {
  mock.addFixtures([
    {
      match: {
        endpoint: 'elevenlabs-voice-design',
        userMessage: DESCRIPTION,
      },
      response: {
        json: {
          previews: [
            {
              generated_voice_id: GENERATED_VOICE_ID,
              audio_base_64: 'SUQzZmFrZS1kZXNpZ24=',
              media_type: 'audio/mpeg',
              duration_secs: 2.5,
            },
          ],
          text: DESCRIPTION,
        },
      },
    },
    {
      match: { endpoint: 'elevenlabs-voice', userMessage: GENERATED_VOICE_ID },
      response: {
        json: { voice_id: VOICE_ID, name: 'Narrator', category: 'generated' },
      },
    },
    {
      match: { endpoint: 'elevenlabs-voice-get', userMessage: VOICE_ID },
      response: {
        json: { voice_id: VOICE_ID, name: 'Narrator', category: 'generated' },
      },
    },
    {
      match: { endpoint: 'elevenlabs-voice-delete', userMessage: VOICE_ID },
      response: { json: { status: 'ok' } },
    },
  ]);
  baseURL = await mock.start();
  vi.doMock('#env', () => ({
    getEnv: () => ({
      ELEVENLABS_API_KEY: 'test-mock-key',
      ELEVENLABS_BASE_URL: baseURL,
    }),
  }));
});

afterAll(async () => {
  await mock.stop();
});

const voice = async () => await import('./elevenlabs-voice');

describe('Voice Design over aimock', () => {
  it('designs previews through the adapter', async () => {
    const { designVoicePreviews } = await voice();
    const previews = await designVoicePreviews('test-mock-key', DESCRIPTION);
    expect(previews).toEqual([
      {
        generatedVoiceId: GENERATED_VOICE_ID,
        audioBase64: 'SUQzZmFrZS1kZXNpZ24=',
        mediaType: 'audio/mpeg',
      },
    ]);
  });

  it('saves, reads back and deletes a designed voice through the SDK', async () => {
    const { saveDesignedVoice, getElevenLabsVoice, deleteElevenLabsVoice } =
      await voice();
    const voiceId = await saveDesignedVoice('test-mock-key', {
      voiceName: 'Narrator',
      voiceDescription: DESCRIPTION,
      generatedVoiceId: GENERATED_VOICE_ID,
    });
    expect(voiceId).toBe(VOICE_ID);

    const saved = await getElevenLabsVoice('test-mock-key', voiceId);
    expect(saved).toMatchObject({
      voiceId: VOICE_ID,
      name: 'Narrator',
      category: 'generated',
      isPremade: false,
    });

    await expect(
      deleteElevenLabsVoice('test-mock-key', voiceId)
    ).resolves.toBeUndefined();
  });

  it('refuses an unrecorded design under strict replay', async () => {
    const { designVoicePreviews } = await voice();
    await expect(
      designVoicePreviews('test-mock-key', 'an unrecorded brief, long enough')
    ).rejects.toThrow();
  });
});
