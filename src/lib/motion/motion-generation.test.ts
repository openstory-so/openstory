import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_FAL_PRICING } from '@/lib/ai/__tests__/fal-pricing-fixture';
import { micros } from '@/lib/billing/money';
import {
  mockFalVideo,
  mockGenerateVideo,
  mockGetVideoJobStatus,
} from './__mocks__/fal-client.mock';

// Mock DB + env so api-key resolution falls through to platform key
vi.doMock('#db-client', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => [] }) }) }),
  }),
}));

const testEnv: {
  FAL_KEY: string | undefined;
  OPENROUTER_KEY: string | undefined;
  XAI_API_KEY: string | undefined;
  GEMINI_API_KEY: string | undefined;
  ARK_API_KEY: string | undefined;
  ARK_BASE_URL: string | undefined;
  E2E_TEST: string | undefined;
} = {
  FAL_KEY: 'test-fal-key',
  OPENROUTER_KEY: 'test-or-key',
  XAI_API_KEY: undefined,
  GEMINI_API_KEY: undefined,
  ARK_API_KEY: undefined,
  ARK_BASE_URL: undefined,
  E2E_TEST: undefined,
};

vi.doMock('#env', () => ({
  getEnv: () => testEnv,
}));

const mockCreateGrokVideo = vi.fn(() => ({
  kind: 'video',
  name: 'grok',
  model: 'grok-imagine-video-1.5',
}));
vi.doMock('@tanstack/ai-grok', () => ({
  createGrokVideo: mockCreateGrokVideo,
}));

const mockCreateGeminiVideo = vi.fn(() => ({
  kind: 'video',
  name: 'gemini',
  model: 'gemini-omni-1.1-flash',
}));
vi.doMock('@tanstack/ai-gemini', () => ({
  createGeminiVideo: mockCreateGeminiVideo,
}));

const mockToArkMediaUrl = vi.fn(async (url: string) => `asset://${url}`);
vi.doMock('@/lib/ai/byteplus-asset-ingest', () => ({
  toArkMediaUrl: mockToArkMediaUrl,
  toArkFetchableUrl: async (url: string) => url,
}));

const {
  submitMotionJob,
  pollMotionJob,
  motionCostFromUsage,
  calculateMotionMetadata,
} = await import('./motion-generation');

describe('Motion Service', () => {
  beforeEach(() => {
    mockGenerateVideo.mockClear();
    mockGetVideoJobStatus.mockClear();
    mockFalVideo.mockClear();
    mockCreateGrokVideo.mockClear();
    mockCreateGeminiVideo.mockClear();
    mockToArkMediaUrl.mockClear();
    testEnv.XAI_API_KEY = undefined;
    testEnv.GEMINI_API_KEY = undefined;
    testEnv.FAL_KEY = 'test-fal-key';
    testEnv.ARK_API_KEY = undefined;
    testEnv.ARK_BASE_URL = undefined;
    testEnv.E2E_TEST = undefined;
  });

  describe('submitMotionJob', () => {
    it('should submit job with Kling v3 Pro model options', async () => {
      mockGenerateVideo.mockResolvedValue({
        jobId: 'test-kling-v3-request-id',
        model: 'fal-ai/kling-video/v3/pro/image-to-video',
      });

      const result = await submitMotionJob({
        imageUrl: 'https://example.com/image.jpg',
        prompt: 'A person walking',
        model: 'kling_v3_pro',
        duration: 5,
      });

      expect(result.jobId).toBe('test-kling-v3-request-id');
      expect(result.modelKey).toBe('kling_v3_pro');
      expect(result.via).toBe('fal');
      expect(result.usedOwnKey).toBe(false);
      expect(result.submittedAt).toBeGreaterThan(0);

      expect(mockGenerateVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'A person walking',
          modelOptions: expect.objectContaining({
            start_image_url: 'https://example.com/image.jpg',
            duration: '5',
            cfg_scale: 0.5,
            negative_prompt:
              'blur, distort, and low quality, background music, musical score, soundtrack',
          }),
        })
      );
    });

    it('should submit job with Seedance 2.5 model options', async () => {
      mockGenerateVideo.mockResolvedValue({
        jobId: 'test-seedance-request-id',
        model: 'bytedance/seedance-2.5/image-to-video',
      });

      const result = await submitMotionJob({
        imageUrl: 'https://example.com/image.jpg',
        prompt: 'Dynamic action sequence',
        model: 'seedance_v2_5',
        duration: 5,
        fps: 25,
      });

      expect(result.jobId).toBe('test-seedance-request-id');
      expect(result.modelKey).toBe('seedance_v2_5');

      expect(mockGenerateVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Dynamic action sequence',
          modelOptions: expect.objectContaining({
            image_url: 'https://example.com/image.jpg',
          }),
        })
      );
    });

    it('should handle submission failure', async () => {
      mockGenerateVideo.mockRejectedValue(new Error('API error'));

      await expect(
        submitMotionJob({
          imageUrl: 'https://example.com/image.jpg',
          prompt: 'Test prompt',
          model: 'kling_v3_pro',
        })
      ).rejects.toThrow('API error');
    });

    it('should submit job with Veo 3.1 model options', async () => {
      mockGenerateVideo.mockResolvedValue({
        jobId: 'test-veo3-1-request-id',
        model: 'fal-ai/veo3.1/image-to-video',
      });

      const result = await submitMotionJob({
        imageUrl: 'https://example.com/image.jpg',
        prompt: 'Smooth camera movement',
        model: 'veo3_1',
        duration: 8,
      });

      expect(result.jobId).toBe('test-veo3-1-request-id');
      expect(result.modelKey).toBe('veo3_1');

      expect(mockGenerateVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Smooth camera movement',
          modelOptions: expect.objectContaining({
            image_url: 'https://example.com/image.jpg',
          }),
        })
      );
    });

    it('stamps via byteplus for Seedance when Ark is configured', async () => {
      testEnv.ARK_API_KEY = 'ark-test';
      mockGenerateVideo.mockResolvedValue({ jobId: 'ark-job-id' });

      const result = await submitMotionJob({
        imageUrl: 'https://example.com/image.jpg',
        prompt: 'Dynamic action sequence',
        model: 'seedance_v2_5',
        duration: 5,
      });

      expect(result.via).toBe('byteplus');
      expect(result.usedOwnKey).toBe(false);
      expect(result.jobId).toBe('ark-job-id');
    });

    it('registers the start frame and every reference as asset://', async () => {
      testEnv.ARK_API_KEY = 'ark-test';
      mockGenerateVideo.mockResolvedValue({ jobId: 'ark-assets' });

      await submitMotionJob({
        imageUrl: 'https://example.com/still.jpg',
        prompt: 'SCARLETT waves the LOGO',
        model: 'seedance_v2_5',
        duration: 5,
        referenceImages: [
          {
            referenceImageUrl: 'https://example.com/scarlett.png',
            description: 'Scarlett',
            role: 'character',
            token: 'SCARLETT',
          },
          {
            referenceImageUrl: 'https://example.com/logo.png',
            description: 'a logo',
            role: 'element',
            token: 'LOGO',
          },
        ],
      });

      expect(mockGenerateVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: [
            expect.objectContaining({ type: 'text' }),
            expect.objectContaining({
              type: 'image',
              source: expect.objectContaining({
                value: 'asset://https://example.com/still.jpg',
              }),
            }),
            expect.objectContaining({
              type: 'image',
              source: expect.objectContaining({
                value: 'asset://https://example.com/scarlett.png',
              }),
            }),
            expect.objectContaining({
              type: 'image',
              source: expect.objectContaining({
                value: 'asset://https://example.com/logo.png',
              }),
            }),
          ],
        })
      );
    });

    it('falls back to fal when Ark rejects the still as a possible real person', async () => {
      testEnv.ARK_API_KEY = 'ark-test';
      mockGenerateVideo
        .mockRejectedValueOnce(
          new Error(
            "BytePlus Ark video task creation failed (400 InputImageSensitiveContentDetected.PrivacyInformation): The request failed because the input image 'content[1]' may contain real person."
          )
        )
        .mockResolvedValueOnce({ jobId: 'fal-after-ark' });

      const result = await submitMotionJob({
        imageUrl: 'https://example.com/image.jpg',
        prompt: 'Dynamic action sequence',
        model: 'seedance_v2_5',
        duration: 5,
      });

      expect(result.via).toBe('fal');
      expect(result.jobId).toBe('fal-after-ark');
      expect(result.usedOwnKey).toBe(false);
      expect(mockGenerateVideo).toHaveBeenCalledTimes(2);
    });

    it('does not fall back to fal on a different Ark 400', async () => {
      testEnv.ARK_API_KEY = 'ark-test';
      mockGenerateVideo.mockRejectedValue(
        new Error(
          'BytePlus Ark video task creation failed (400 InvalidParameter): size is malformed'
        )
      );

      await expect(
        submitMotionJob({
          imageUrl: 'https://example.com/image.jpg',
          prompt: 'Dynamic action sequence',
          model: 'seedance_v2_5',
          duration: 5,
        })
      ).rejects.toThrow('InvalidParameter');
      expect(mockGenerateVideo).toHaveBeenCalledTimes(1);
    });

    it('names the asset:// gap when Ark blocks the still and there is no fal key', async () => {
      testEnv.ARK_API_KEY = 'ark-test';
      testEnv.FAL_KEY = undefined;
      mockGenerateVideo.mockRejectedValue(
        new Error(
          "BytePlus Ark video task creation failed (400 InputImageSensitiveContentDetected.PrivacyInformation): The request failed because the input image 'content[1]' may contain real person."
        )
      );

      await expect(
        submitMotionJob({
          imageUrl: 'https://example.com/image.jpg',
          prompt: 'Dynamic action sequence',
          model: 'seedance_v2_5',
          duration: 5,
        })
      ).rejects.toThrow(/asset:\/\//);
    });

    it('keeps Kling on fal even when Ark is configured', async () => {
      testEnv.ARK_API_KEY = 'ark-test';
      mockGenerateVideo.mockResolvedValue({
        jobId: 'kling-job',
        model: 'fal-ai/kling-video/v3/pro/image-to-video',
      });

      const result = await submitMotionJob({
        imageUrl: 'https://example.com/image.jpg',
        prompt: 'A person walking',
        model: 'kling_v3_pro',
        duration: 5,
      });

      expect(result.via).toBe('fal');
    });

    it('stamps the H3 Max r2v endpoint when refs are attached', async () => {
      mockGenerateVideo.mockResolvedValue({
        jobId: 'h3-r2v-job',
        model: 'minimax/h3-max/reference-to-video',
      });

      const result = await submitMotionJob({
        imageUrl: 'https://example.com/still.jpg',
        prompt: 'SCARLETT waves',
        model: 'minimax_h3_max',
        duration: 5,
        referenceImages: [
          {
            referenceImageUrl: 'https://example.com/scarlett.png',
            description: 'Scarlett',
            role: 'character',
            token: 'SCARLETT',
          },
        ],
      });

      expect(result.endpointId).toBe('minimax/h3-max/reference-to-video');
      expect(mockFalVideo).toHaveBeenCalledWith(
        'minimax/h3-max/reference-to-video',
        expect.anything()
      );
    });

    it('stamps the H3 Max i2v endpoint when there are no refs', async () => {
      mockGenerateVideo.mockResolvedValue({
        jobId: 'h3-i2v-job',
        model: 'minimax/h3-max/image-to-video',
      });

      const result = await submitMotionJob({
        imageUrl: 'https://example.com/still.jpg',
        prompt: 'A person walking',
        model: 'minimax_h3_max',
        duration: 5,
      });

      expect(result.endpointId).toBe('minimax/h3-max/image-to-video');
    });
  });

  describe('pollMotionJob', () => {
    it('polls fal by default so pre-#1216 submissions keep working', async () => {
      mockGetVideoJobStatus.mockResolvedValue({
        jobId: 'job-1',
        status: 'completed',
        url: 'https://example.com/video.mp4',
        usage: { unitsBilled: 12 },
      });

      const result = await pollMotionJob('job-1', 'kling_v3_pro');

      expect(result.status).toBe('completed');
      expect(result.url).toBe('https://example.com/video.mp4');
      expect(mockGetVideoJobStatus).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'job-1' })
      );
    });

    it('throws on an unknown via stamp', async () => {
      await expect(
        pollMotionJob('job-1', 'kling_v3_pro', undefined, 'openai')
      ).rejects.toThrow('Unknown media via: openai');
    });

    it('polls xAI when the submission stamped via xai', async () => {
      testEnv.XAI_API_KEY = 'platform-xai';
      mockGetVideoJobStatus.mockResolvedValue({
        jobId: 'xai-job',
        status: 'completed',
        url: 'https://example.com/video.mp4',
        usage: { cost: 0.4 },
      });

      const result = await pollMotionJob(
        'xai-job',
        'grok_imagine_video_1_5',
        undefined,
        'xai'
      );

      expect(result.status).toBe('completed');
      expect(mockCreateGrokVideo).toHaveBeenCalled();
    });

    it('polls the BytePlus via when the job was stamped byteplus', async () => {
      testEnv.ARK_API_KEY = 'ark-test';
      mockGetVideoJobStatus.mockResolvedValue({
        jobId: 'ark-job-1',
        status: 'completed',
        url: 'https://example.com/video.mp4',
        usage: { totalTokens: 108_000 },
      });

      const result = await pollMotionJob(
        'ark-job-1',
        'seedance_v2_5',
        undefined,
        'byteplus'
      );

      expect(result.status).toBe('completed');
      expect(mockGetVideoJobStatus).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'ark-job-1' })
      );
    });

    it('polls the stamped H3 Max r2v endpoint, not catalog i2v', async () => {
      mockGetVideoJobStatus.mockResolvedValue({
        jobId: 'h3-r2v-job',
        status: 'completed',
        url: 'https://example.com/video.mp4',
      });

      await pollMotionJob(
        'h3-r2v-job',
        'minimax_h3_max',
        undefined,
        'fal',
        'minimax/h3-max/reference-to-video'
      );

      expect(mockFalVideo).toHaveBeenCalledWith(
        'minimax/h3-max/reference-to-video',
        expect.anything()
      );
    });

    it('falls back to catalog i2v when endpointId is missing (pre-stamp jobs)', async () => {
      mockGetVideoJobStatus.mockResolvedValue({
        jobId: 'job-1',
        status: 'completed',
        url: 'https://example.com/video.mp4',
      });

      await pollMotionJob('job-1', 'minimax_h3_max');

      expect(mockFalVideo).toHaveBeenCalledWith(
        'minimax/h3-max/image-to-video',
        expect.anything()
      );
    });
  });

  describe('native xAI submit (issue #1167)', () => {
    it('submits a Grok clip to xAI when a key is present', async () => {
      testEnv.XAI_API_KEY = 'platform-xai';
      mockGenerateVideo.mockResolvedValue({
        jobId: 'xai-job-1',
        model: 'grok-imagine-video-1.5',
      });

      const result = await submitMotionJob({
        imageUrl: 'https://example.com/image.jpg',
        prompt: 'A person walking',
        model: 'grok_imagine_video_1_5',
        duration: 5,
      });

      expect(result.via).toBe('xai');
      expect(result.jobId).toBe('xai-job-1');
      expect(mockCreateGrokVideo).toHaveBeenCalled();
    });

    it('falls back to fal for Grok when no xAI key exists', async () => {
      mockGenerateVideo.mockResolvedValue({
        jobId: 'fal-grok-job',
        model: 'xai/grok-imagine-video/v1.5/image-to-video',
      });

      const result = await submitMotionJob({
        imageUrl: 'https://example.com/image.jpg',
        prompt: 'A person walking',
        model: 'grok_imagine_video_1_5',
        duration: 5,
      });

      expect(result.via).toBe('fal');
      expect(mockCreateGrokVideo).not.toHaveBeenCalled();
    });

    it('sends the start frame as a start_frame image part', async () => {
      testEnv.XAI_API_KEY = 'platform-xai';
      mockGenerateVideo.mockResolvedValue({
        jobId: 'xai-job-frame',
        model: 'grok-imagine-video-1.5',
      });

      await submitMotionJob({
        imageUrl: 'https://example.com/image.jpg',
        prompt: 'A person walking',
        model: 'grok_imagine_video_1_5',
        duration: 5,
      });

      expect(mockGenerateVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: [
            { type: 'text', content: 'A person walking' },
            {
              type: 'image',
              source: { type: 'url', value: 'https://example.com/image.jpg' },
              metadata: { role: 'start_frame' },
            },
          ],
        })
      );
    });

    it('sends library refs as reference/character parts and tags the prompt', async () => {
      testEnv.XAI_API_KEY = 'platform-xai';
      mockGenerateVideo.mockResolvedValue({
        jobId: 'xai-job-refs',
        model: 'grok-imagine-video-1.5',
      });

      await submitMotionJob({
        imageUrl: 'https://example.com/still.jpg',
        prompt: 'SCARLETT lifts the CORAL_LIPSTICK',
        model: 'grok_imagine_video_1_5',
        duration: 5,
        referenceImages: [
          {
            referenceImageUrl: 'https://example.com/scarlett.png',
            description: 'Scarlett - athletic',
            role: 'character',
            token: 'SCARLETT',
          },
          {
            referenceImageUrl: 'https://example.com/lipstick.png',
            description: 'CORAL_LIPSTICK - a coral tube',
            role: 'element',
            token: 'CORAL_LIPSTICK',
          },
        ],
      });

      expect(mockGenerateVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: [
            {
              type: 'text',
              content: expect.stringMatching(
                /Use <IMAGE_0> as the starting frame\.\n<IMAGE_1> lifts the <IMAGE_2>/
              ),
            },
            {
              type: 'image',
              source: { type: 'url', value: 'https://example.com/still.jpg' },
              metadata: { role: 'reference' },
            },
            {
              type: 'image',
              source: {
                type: 'url',
                value: 'https://example.com/scarlett.png',
              },
              metadata: { role: 'character' },
            },
            {
              type: 'image',
              source: {
                type: 'url',
                value: 'https://example.com/lipstick.png',
              },
              metadata: { role: 'reference' },
            },
          ],
        })
      );
    });
  });

  describe('native Google submit', () => {
    it('submits an Omni Flash clip to Google when a key is present', async () => {
      testEnv.GEMINI_API_KEY = 'platform-google';
      mockGenerateVideo.mockResolvedValue({
        jobId: 'google-job-1',
        model: 'gemini-omni-1.1-flash',
      });

      const result = await submitMotionJob({
        imageUrl: 'https://example.com/image.jpg',
        prompt: 'A person walking',
        model: 'gemini_omni_flash',
        duration: 5,
      });

      expect(result.via).toBe('google');
      expect(result.jobId).toBe('google-job-1');
      expect(mockCreateGeminiVideo).toHaveBeenCalled();
    });

    it('falls back to fal for Omni Flash when no Google key exists', async () => {
      mockGenerateVideo.mockResolvedValue({
        jobId: 'fal-omni-job',
        model: 'fal-ai/gemini-omni-1.1-flash/image-to-video',
      });

      const result = await submitMotionJob({
        imageUrl: 'https://example.com/image.jpg',
        prompt: 'A person walking',
        model: 'gemini_omni_flash',
        duration: 5,
      });

      expect(result.via).toBe('fal');
      expect(mockCreateGeminiVideo).not.toHaveBeenCalled();
    });

    it('sends the still + prompt with the task pinned to image_to_video', async () => {
      testEnv.GEMINI_API_KEY = 'platform-google';
      mockGenerateVideo.mockResolvedValue({
        jobId: 'google-job-frame',
        model: 'gemini-omni-1.1-flash',
      });

      await submitMotionJob({
        imageUrl: 'https://example.com/image.jpg',
        prompt: 'A person walking',
        model: 'gemini_omni_flash',
        duration: 5,
      });

      expect(mockGenerateVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: [
            {
              type: 'image',
              source: { type: 'url', value: 'https://example.com/image.jpg' },
            },
            { type: 'text', content: 'A person walking' },
          ],
          modelOptions: {
            generation_config: { video_config: { task: 'image_to_video' } },
            response_format: {
              type: 'video',
              delivery: 'uri',
              duration: '5s',
            },
          },
        })
      );
      // Top-level duration/size would make the adapter drop delivery:uri.
      expect(mockGenerateVideo.mock.calls.at(-1)?.[0].duration).toBeUndefined();
      expect(mockGenerateVideo.mock.calls.at(-1)?.[0].size).toBeUndefined();
    });

    it('tags library refs as <IMAGE_REF_n> and pins reference_to_video', async () => {
      testEnv.GEMINI_API_KEY = 'platform-google';
      mockGenerateVideo.mockResolvedValue({
        jobId: 'google-job-refs',
        model: 'gemini-omni-1.1-flash',
      });

      await submitMotionJob({
        imageUrl: 'https://example.com/still.jpg',
        prompt: 'SCARLETT lifts the CORAL_LIPSTICK',
        model: 'gemini_omni_flash',
        duration: 5,
        referenceImages: [
          {
            referenceImageUrl: 'https://example.com/scarlett.png',
            description: 'Scarlett - athletic',
            role: 'character',
            token: 'SCARLETT',
          },
        ],
      });

      expect(mockGenerateVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: [
            {
              type: 'image',
              source: { type: 'url', value: 'https://example.com/still.jpg' },
            },
            {
              type: 'image',
              source: {
                type: 'url',
                value: 'https://example.com/scarlett.png',
              },
            },
            {
              type: 'text',
              content: expect.stringMatching(
                /Use <IMAGE_REF_0> as the starting frame\.\n<IMAGE_REF_1> lifts the/
              ),
            },
          ],
          modelOptions: {
            generation_config: { video_config: { task: 'reference_to_video' } },
            response_format: {
              type: 'video',
              delivery: 'uri',
              duration: '5s',
            },
          },
        })
      );
    });
  });

  describe('pollMotionJob via google', () => {
    it('polls Google when the submission stamped via google', async () => {
      testEnv.GEMINI_API_KEY = 'platform-google';
      mockGetVideoJobStatus.mockResolvedValue({
        jobId: 'google-job',
        status: 'completed',
        url: 'data:video/mp4;base64,AAAA',
        usage: { promptTokens: 0, completionTokens: 28_960, totalTokens: 0 },
      });

      const result = await pollMotionJob(
        'google-job',
        'gemini_omni_flash',
        undefined,
        'google'
      );

      expect(result.status).toBe('completed');
      expect(mockCreateGeminiVideo).toHaveBeenCalled();
    });

    it('throws when a google-stamped job has no key to poll with', async () => {
      await expect(
        pollMotionJob('google-job', 'gemini_omni_flash', undefined, 'google')
      ).rejects.toThrow(/no Google key is available/);
    });
  });

  describe('calculateMotionMetadata', () => {
    it('gates H3 Max without refs on the i2v row', () => {
      const { cost, model } = calculateMotionMetadata(
        {
          imageUrl: 'https://example.com/still.jpg',
          prompt: 'A person walking',
          model: 'minimax_h3_max',
          duration: 5,
        },
        TEST_FAL_PRICING
      );
      expect(model).toBe('minimax/h3-max/image-to-video');
      expect(cost).toBe(micros(200_000));
    });

    it('gates H3 Max with refs on the r2v row, not i2v', () => {
      const { cost, model } = calculateMotionMetadata(
        {
          imageUrl: 'https://example.com/still.jpg',
          prompt: 'SCARLETT waves',
          model: 'minimax_h3_max',
          duration: 5,
          referenceImages: [
            {
              referenceImageUrl: 'https://example.com/scarlett.png',
              description: 'Scarlett',
              role: 'character',
              token: 'SCARLETT',
            },
          ],
        },
        TEST_FAL_PRICING
      );
      expect(model).toBe('minimax/h3-max/reference-to-video');
      expect(cost).toBe(micros(400_000));
    });
  });

  describe('motionCostFromUsage', () => {
    it('uses xAI’s reported cost and skips fal usage sampling', async () => {
      const billing = await motionCostFromUsage(
        'xai',
        { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0.4 },
        { modelKey: 'grok_imagine_video_1_5', hasReferenceImages: false }
      );
      expect(billing.cost).toBe(400_000);
      expect(billing.recordFalUsage).toBe(false);
      expect(billing.endpointId).toBe('grok-imagine-video-1.5');
    });

    it('prices Google video-output tokens and skips fal usage sampling', async () => {
      // 5s of 720p video = 28,960 output tokens @ $17.50/1M = $0.5068.
      const billing = await motionCostFromUsage(
        'google',
        { promptTokens: 120, completionTokens: 28_960, totalTokens: 29_080 },
        { modelKey: 'gemini_omni_flash', hasReferenceImages: false }
      );
      expect(billing.cost).toBe(506_800);
      expect(billing.recordFalUsage).toBe(false);
      expect(billing.endpointId).toBe('gemini-omni-1.1-flash');
    });
  });
});
