import { describe, expect, it, vi } from 'vitest';

const envValues: Record<string, string | undefined> = {};
vi.doMock('#env', () => ({
  getEnv: () => envValues,
}));

const captureProductEvent = vi.fn();
vi.doMock('./product-events', () => ({
  captureProductEvent,
}));

const { captureSequenceContentReady, captureStudioGenerationCompleted } =
  await import('./content-feed');
const { SITE_CONFIG } = await import('@/ui/marketing/constants');

const origin = SITE_CONFIG.url.replace(/\/$/, '');

describe('captureStudioGenerationCompleted', () => {
  it('absolutizes a studio still for Slack and points watch_url at /images', () => {
    captureProductEvent.mockClear();
    captureStudioGenerationCompleted({
      distinctId: 'u1',
      teamId: 'team-1',
      assetId: 'asset-1',
      activity: 'image',
      model: 'gpt_image_2',
      mediaUrl: '/r2/thumbnails/a.png',
      contentType: 'image/png',
      prompt: 'a red fox',
      aspectRatio: '16:9',
    });

    expect(captureProductEvent).toHaveBeenCalledWith({
      distinctId: 'u1',
      event: 'studio_generation_completed',
      properties: {
        team_id: 'team-1',
        activity: 'image',
        asset_id: 'asset-1',
        model: 'gpt_image_2',
        media_url: `${origin}/r2/thumbnails/a.png`,
        preview_url: `${origin}/r2/thumbnails/a.png`,
        watch_url: `${origin}/images`,
        prompt: 'a red fox',
        aspect_ratio: '16:9',
        content_type: 'image/png',
      },
    });
  });

  it('omits preview_url for a studio clip so Slack is not handed an mp4 as an image', () => {
    captureProductEvent.mockClear();
    captureStudioGenerationCompleted({
      distinctId: 'u1',
      teamId: 'team-1',
      assetId: 'asset-1',
      activity: 'video',
      model: 'seedance_v2',
      mediaUrl: '/r2/videos/a.mp4',
      contentType: 'video/mp4',
      prompt: 'the fox turns',
      aspectRatio: '16:9',
      duration: 5,
    });

    expect(captureProductEvent).toHaveBeenCalledWith({
      distinctId: 'u1',
      event: 'studio_generation_completed',
      properties: {
        team_id: 'team-1',
        activity: 'video',
        asset_id: 'asset-1',
        model: 'seedance_v2',
        media_url: `${origin}/r2/videos/a.mp4`,
        watch_url: `${origin}/videos`,
        prompt: 'the fox turns',
        aspect_ratio: '16:9',
        content_type: 'video/mp4',
        duration: 5,
      },
    });
  });

  it('truncates a long prompt at 280 characters', () => {
    captureProductEvent.mockClear();
    const prompt = 'x'.repeat(300);
    captureStudioGenerationCompleted({
      distinctId: 'u1',
      teamId: 'team-1',
      assetId: 'asset-1',
      activity: 'image',
      model: 'gpt_image_2',
      mediaUrl: '/r2/thumbnails/a.png',
      contentType: 'image/png',
      prompt,
      aspectRatio: '1:1',
    });

    expect(captureProductEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          prompt: `${'x'.repeat(279)}…`,
        }),
      })
    );
  });
});

describe('captureSequenceContentReady', () => {
  it('absolutizes the poster and keeps the watch URL off the email UTM', () => {
    captureProductEvent.mockClear();
    captureSequenceContentReady({
      distinctId: 'u1',
      teamId: 'team-1',
      sequenceId: 'seq_1',
      title: 'The Long Walk',
      watchUrl: 'https://openstory.so/sequences/seq_1/scenes',
      posterUrl: '/r2/posters/seq_1.png',
    });

    expect(captureProductEvent).toHaveBeenCalledWith({
      distinctId: 'u1',
      event: 'sequence_content_ready',
      properties: {
        team_id: 'team-1',
        sequence_id: 'seq_1',
        title: 'The Long Walk',
        watch_url: 'https://openstory.so/sequences/seq_1/scenes',
        poster_url: `${origin}/r2/posters/seq_1.png`,
        preview_url: `${origin}/r2/posters/seq_1.png`,
      },
    });
  });

  it('falls back to the OG image when there is no poster', () => {
    captureProductEvent.mockClear();
    captureSequenceContentReady({
      distinctId: 'u1',
      teamId: 'team-1',
      sequenceId: 'seq_1',
      title: 'Untitled Sequence',
      watchUrl: 'https://openstory.so/sequences/seq_1/scenes',
    });

    expect(captureProductEvent).toHaveBeenCalledWith({
      distinctId: 'u1',
      event: 'sequence_content_ready',
      properties: {
        team_id: 'team-1',
        sequence_id: 'seq_1',
        title: 'Untitled Sequence',
        watch_url: 'https://openstory.so/sequences/seq_1/scenes',
        preview_url: `${origin}/og.jpg`,
      },
    });
  });
});
