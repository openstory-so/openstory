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
} = {
  FAL_KEY: 'test-fal-key',
  OPENROUTER_KEY: 'test-or-key',
  XAI_API_KEY: undefined,
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

const { submitStudioVideoJob, pollStudioVideoJob } =
  await import('./studio-video-generation');

describe('submitStudioVideoJob', () => {
  beforeEach(() => {
    mockGenerateVideo.mockClear();
    mockGetVideoJobStatus.mockClear();
    mockCreateGrokVideo.mockClear();
    mockFalVideo.mockClear();
    testEnv.XAI_API_KEY = undefined;
    testEnv.FAL_KEY = 'test-fal-key';
  });

  it('submits Seedance to the text-to-video endpoint with no image field', async () => {
    mockGenerateVideo.mockResolvedValue({
      jobId: 't2v-seedance',
      model: 'bytedance/seedance-2.0/enterprise/v2/text-to-video',
    });

    const result = await submitStudioVideoJob({
      prompt: 'A red fox turns toward camera',
      model: 'seedance_v2',
      duration: 5,
      aspectRatio: '9:16',
    });

    expect(result.jobId).toBe('t2v-seedance');
    expect(result.via).toBe('fal');
    expect(result.endpointId).toBe(
      'bytedance/seedance-2.0/enterprise/v2/text-to-video'
    );
    expect(mockFalVideo).toHaveBeenCalledWith(
      'bytedance/seedance-2.0/enterprise/v2/text-to-video',
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
});

describe('pollStudioVideoJob', () => {
  beforeEach(() => {
    mockGetVideoJobStatus.mockClear();
    mockCreateGrokVideo.mockClear();
    mockFalVideo.mockClear();
    testEnv.XAI_API_KEY = undefined;
    testEnv.FAL_KEY = 'test-fal-key';
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
});
