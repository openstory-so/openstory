import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mockFalVideo,
  mockGenerateVideo,
  mockGetVideoJobStatus,
} from '@/lib/motion/__mocks__/fal-client.mock';

vi.doMock('#db-client', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => [] }) }) }),
  }),
}));

const testEnv: {
  FAL_KEY: string | undefined;
  OPENROUTER_KEY: string | undefined;
  XAI_API_KEY: string | undefined;
  ARK_API_KEY: string | undefined;
  ARK_BASE_URL: string | undefined;
  E2E_TEST: string | undefined;
} = {
  FAL_KEY: 'test-fal-key',
  OPENROUTER_KEY: 'test-or-key',
  XAI_API_KEY: undefined,
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

const mockCreateBytePlusVideo = vi.fn(() => ({
  kind: 'video',
  name: 'byteplus',
  model: 'dreamina-seedance-2-5-260628',
}));
vi.doMock('@tanstack/ai-byteplus', () => ({
  createBytePlusVideo: mockCreateBytePlusVideo,
}));

const { submitStudioVideoJob, pollStudioVideoJob, studioVideoCostFromUsage } =
  await import('./studio-video-generation');

describe('submitStudioVideoJob', () => {
  beforeEach(() => {
    mockGenerateVideo.mockClear();
    mockGetVideoJobStatus.mockClear();
    mockCreateGrokVideo.mockClear();
    mockCreateBytePlusVideo.mockClear();
    mockFalVideo.mockClear();
    testEnv.XAI_API_KEY = undefined;
    testEnv.FAL_KEY = 'test-fal-key';
    testEnv.ARK_API_KEY = undefined;
    testEnv.ARK_BASE_URL = undefined;
    testEnv.E2E_TEST = undefined;
  });

  it('submits Seedance 2.5 to the 2.5 text-to-video endpoint with no image field', async () => {
    mockGenerateVideo.mockResolvedValue({
      jobId: 't2v-seedance',
      model: 'bytedance/seedance-2.5/text-to-video',
    });

    const result = await submitStudioVideoJob({
      prompt: 'A red fox turns toward camera',
      model: 'seedance_v2_5',
      duration: 5,
      aspectRatio: '9:16',
    });

    expect(result.jobId).toBe('t2v-seedance');
    expect(result.via).toBe('fal');
    expect(result.endpointId).toBe('bytedance/seedance-2.5/text-to-video');
    expect(mockFalVideo).toHaveBeenCalledWith(
      'bytedance/seedance-2.5/text-to-video',
      expect.objectContaining({ apiKey: 'test-fal-key' })
    );
    expect(mockGenerateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'A red fox turns toward camera',
        modelOptions: expect.objectContaining({
          duration: '5',
          aspect_ratio: '9:16',
        }),
      })
    );
    expect(mockGenerateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOptions: expect.not.objectContaining({
          image_url: expect.anything(),
          start_image_url: expect.anything(),
        }),
      })
    );
  });

  it('sends native Grok a text prompt with no start frame', async () => {
    testEnv.XAI_API_KEY = 'platform-xai';
    mockGenerateVideo.mockResolvedValue({
      jobId: 'xai-t2v',
      model: 'grok-imagine-video-1.5',
    });

    const result = await submitStudioVideoJob({
      prompt: 'A red fox turns toward camera',
      model: 'grok_imagine_video_1_5',
      duration: 5,
      aspectRatio: '16:9',
    });

    expect(result.via).toBe('xai');
    expect(result.endpointId).toBe('grok-imagine-video-1.5');
    expect(mockCreateGrokVideo).toHaveBeenCalled();
    expect(mockGenerateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'A red fox turns toward camera',
        duration: 5,
        size: '16:9_720p',
      })
    );
  });

  it('falls back to fal Grok T2V when no xAI key exists', async () => {
    mockGenerateVideo.mockResolvedValue({
      jobId: 'fal-grok-t2v',
      model: 'xai/grok-imagine-video/v1.5/text-to-video',
    });

    const result = await submitStudioVideoJob({
      prompt: 'A red fox turns toward camera',
      model: 'grok_imagine_video_1_5',
      duration: 5,
    });

    expect(result.via).toBe('fal');
    expect(result.endpointId).toBe('xai/grok-imagine-video/v1.5/text-to-video');
    expect(mockCreateGrokVideo).not.toHaveBeenCalled();
  });

  it('submits Seedance to Ark when configured', async () => {
    testEnv.ARK_API_KEY = 'ark-test';
    mockGenerateVideo.mockResolvedValue({ jobId: 'ark-t2v' });

    const result = await submitStudioVideoJob({
      prompt: 'A red fox turns toward camera',
      model: 'seedance_v2_5',
      duration: 5,
      aspectRatio: '9:16',
    });

    expect(result.via).toBe('byteplus');
    expect(result.usedOwnKey).toBe(false);
    expect(result.endpointId).toBe('dreamina-seedance-2-5-260628');
    expect(mockCreateBytePlusVideo).toHaveBeenCalled();
    expect(mockFalVideo).not.toHaveBeenCalled();
    expect(mockGenerateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'A red fox turns toward camera',
        duration: 5,
        size: '9:16_720p',
      })
    );
  });

  it('falls back to fal when Ark rejects a studio still as a possible real person', async () => {
    testEnv.ARK_API_KEY = 'ark-test';
    mockGenerateVideo
      .mockRejectedValueOnce(
        new Error(
          "BytePlus Ark video task creation failed (400 InputImageSensitiveContentDetected.PrivacyInformation): The request failed because the input image 'content[1]' may contain real person."
        )
      )
      .mockResolvedValueOnce({ jobId: 'fal-after-ark' });

    const result = await submitStudioVideoJob({
      prompt: 'Camera pushes in',
      model: 'seedance_v2_5',
      mode: 'frames',
      startImageUrl: 'https://example.com/start.jpg',
      duration: 5,
    });

    expect(result.via).toBe('fal');
    expect(result.jobId).toBe('fal-after-ark');
    expect(mockFalVideo).toHaveBeenCalled();
    expect(mockGenerateVideo).toHaveBeenCalledTimes(2);
  });

  it('sends studio frames to Ark as start_frame / end_frame', async () => {
    testEnv.ARK_API_KEY = 'ark-test';
    mockGenerateVideo.mockResolvedValue({ jobId: 'ark-frames' });

    const result = await submitStudioVideoJob({
      prompt: 'Camera pushes in',
      model: 'seedance_v2_5',
      mode: 'frames',
      startImageUrl: 'https://example.com/start.jpg',
      endImageUrl: 'https://example.com/end.jpg',
      duration: 5,
    });

    expect(result.via).toBe('byteplus');
    expect(mockGenerateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: [
          { type: 'text', content: expect.any(String) },
          {
            type: 'image',
            source: { type: 'url', value: 'https://example.com/start.jpg' },
            metadata: { role: 'start_frame' },
          },
          {
            type: 'image',
            source: { type: 'url', value: 'https://example.com/end.jpg' },
            metadata: { role: 'end_frame' },
          },
        ],
      })
    );
  });

  it('sends studio references to Ark as reference roles, not frames', async () => {
    testEnv.ARK_API_KEY = 'ark-test';
    mockGenerateVideo.mockResolvedValue({ jobId: 'ark-refs' });

    await submitStudioVideoJob({
      prompt: 'The fox walks',
      model: 'seedance_v2_5',
      mode: 'reference',
      referenceImages: ['https://example.com/fox.jpg'],
      referenceVideos: ['https://example.com/clip.mp4'],
      duration: 5,
    });

    expect(mockGenerateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: [
          { type: 'text', content: expect.any(String) },
          {
            type: 'image',
            source: { type: 'url', value: 'https://example.com/fox.jpg' },
            metadata: { role: 'reference' },
          },
          {
            type: 'video',
            source: { type: 'url', value: 'https://example.com/clip.mp4' },
          },
        ],
      })
    );
  });
});

describe('pollStudioVideoJob', () => {
  beforeEach(() => {
    mockGetVideoJobStatus.mockClear();
    mockCreateGrokVideo.mockClear();
    mockCreateBytePlusVideo.mockClear();
    mockFalVideo.mockClear();
    testEnv.XAI_API_KEY = undefined;
    testEnv.FAL_KEY = 'test-fal-key';
    testEnv.ARK_API_KEY = undefined;
    testEnv.ARK_BASE_URL = undefined;
    testEnv.E2E_TEST = undefined;
  });

  it('polls the T2V endpoint the job was submitted to', async () => {
    mockGetVideoJobStatus.mockResolvedValue({
      jobId: 'job-1',
      status: 'completed',
      url: 'https://example.com/video.mp4',
    });

    const result = await pollStudioVideoJob({
      jobId: 'job-1',
      via: 'fal',
      endpointId: 'fal-ai/kling-video/v3/pro/text-to-video',
    });

    expect(result.status).toBe('completed');
    expect(mockFalVideo).toHaveBeenCalledWith(
      'fal-ai/kling-video/v3/pro/text-to-video',
      expect.anything()
    );
  });

  it('polls Ark when the job was stamped byteplus', async () => {
    testEnv.ARK_API_KEY = 'ark-test';
    mockGetVideoJobStatus.mockResolvedValue({
      jobId: 'ark-job',
      status: 'completed',
      url: 'https://example.com/video.mp4',
    });

    const result = await pollStudioVideoJob({
      jobId: 'ark-job',
      via: 'byteplus',
      endpointId: 'dreamina-seedance-2-5-260628',
    });

    expect(result.status).toBe('completed');
    expect(mockCreateBytePlusVideo).toHaveBeenCalled();
    expect(mockFalVideo).not.toHaveBeenCalled();
  });
});

describe('studioVideoCostFromUsage', () => {
  it('bills Ark tokens and skips fal usage sampling', async () => {
    const billing = await studioVideoCostFromUsage(
      {
        via: 'byteplus',
        endpointId: 'dreamina-seedance-2-5-260628',
        modelKey: 'seedance_v2_5',
      },
      { promptTokens: 0, completionTokens: 0, totalTokens: 108_000 }
    );
    expect(billing.unitsBilled).toBe(108);
    expect(billing.recordFalUsage).toBe(false);
    expect(billing.endpointId).toBe('dreamina-seedance-2-5-260628');
  });
});
