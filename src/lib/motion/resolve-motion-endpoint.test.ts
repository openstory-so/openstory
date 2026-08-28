import { describe, expect, it } from 'vitest';
import {
  IMAGE_TO_VIDEO_MODELS,
  MOTION_REFERENCE_ENDPOINTS,
} from '@/lib/ai/models';
import { resolveMotionEndpoint } from './resolve-motion-endpoint';

describe('resolveMotionEndpoint', () => {
  it('routes Seedance to reference-to-video when refs are present', () => {
    expect(resolveMotionEndpoint('seedance_v2', true)).toEqual({
      via: 'fal',
      endpointId: 'bytedance/seedance-2.0/enterprise/v2/reference-to-video',
      references: 'endpoint',
      referenceConfig: MOTION_REFERENCE_ENDPOINTS.seedance_v2,
    });
  });

  it('keeps Seedance on image-to-video when there are no refs', () => {
    expect(resolveMotionEndpoint('seedance_v2', false)).toEqual({
      via: 'fal',
      endpointId: IMAGE_TO_VIDEO_MODELS.seedance_v2.id,
      references: 'none',
    });
  });

  it('keeps Kling on image-to-video and marks refs as inline', () => {
    expect(resolveMotionEndpoint('kling_v3_pro', true)).toEqual({
      via: 'fal',
      endpointId: IMAGE_TO_VIDEO_MODELS.kling_v3_pro.id,
      references: 'inline',
    });
  });

  it('does not send reference URLs for models that only substitute descriptions', () => {
    expect(resolveMotionEndpoint('veo3_1', true)).toEqual({
      via: 'fal',
      endpointId: IMAGE_TO_VIDEO_MODELS.veo3_1.id,
      references: 'none',
    });
  });

  it('stamps xAI-native Grok as via xai and marks refs as inline', () => {
    expect(
      resolveMotionEndpoint('grok_imagine_video_1_5', true, 'xai')
    ).toEqual({
      via: 'xai',
      endpointId: 'grok-imagine-video-1.5',
      references: 'inline',
    });
  });

  it('stamps xAI-native Grok with no refs as via xai', () => {
    expect(
      resolveMotionEndpoint('grok_imagine_video_1_5', false, 'xai')
    ).toEqual({
      via: 'xai',
      endpointId: 'grok-imagine-video-1.5',
      references: 'none',
    });
  });
});
