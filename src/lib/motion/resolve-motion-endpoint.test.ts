import { describe, expect, it } from 'vitest';
import {
  IMAGE_TO_VIDEO_MODELS,
  MOTION_REFERENCE_ENDPOINTS,
} from '@/lib/ai/models';
import { resolveMotionEndpoint } from './resolve-motion-endpoint';

describe('resolveMotionEndpoint', () => {
  it('routes Seedance 2.0 to enterprise reference-to-video when refs are present', () => {
    expect(resolveMotionEndpoint('seedance_v2', true)).toEqual({
      via: 'fal',
      endpointId: 'bytedance/seedance-2.0/enterprise/v2/reference-to-video',
      references: 'endpoint',
      referenceConfig: MOTION_REFERENCE_ENDPOINTS.seedance_v2,
    });
  });

  it('keeps Seedance 2.0 on enterprise image-to-video when there are no refs', () => {
    expect(resolveMotionEndpoint('seedance_v2', false)).toEqual({
      via: 'fal',
      endpointId: IMAGE_TO_VIDEO_MODELS.seedance_v2.id,
      references: 'none',
    });
  });

  it('routes Seedance 2.5 to 2.5 reference-to-video when refs are present', () => {
    expect(resolveMotionEndpoint('seedance_v2_5', true)).toEqual({
      via: 'fal',
      endpointId: 'bytedance/seedance-2.5/reference-to-video',
      references: 'endpoint',
      referenceConfig: MOTION_REFERENCE_ENDPOINTS.seedance_v2_5,
    });
  });

  it('keeps Seedance 2.5 on 2.5 image-to-video when there are no refs', () => {
    expect(resolveMotionEndpoint('seedance_v2_5', false)).toEqual({
      via: 'fal',
      endpointId: IMAGE_TO_VIDEO_MODELS.seedance_v2_5.id,
      references: 'none',
    });
  });

  it('routes H3 Max to reference-to-video when refs are present', () => {
    expect(resolveMotionEndpoint('minimax_h3_max', true)).toEqual({
      via: 'fal',
      endpointId: 'minimax/h3-max/reference-to-video',
      references: 'endpoint',
      referenceConfig: MOTION_REFERENCE_ENDPOINTS.minimax_h3_max,
    });
  });

  it('keeps H3 Max on image-to-video when there are no refs', () => {
    expect(resolveMotionEndpoint('minimax_h3_max', false)).toEqual({
      via: 'fal',
      endpointId: IMAGE_TO_VIDEO_MODELS.minimax_h3_max.id,
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

  it('stamps Ark Seedance 2.5 as via byteplus and marks refs as inline', () => {
    expect(resolveMotionEndpoint('seedance_v2_5', true, 'byteplus')).toEqual({
      via: 'byteplus',
      endpointId: 'dreamina-seedance-2-5-260628',
      references: 'inline',
    });
  });

  it('stamps Ark Seedance 2.5 with no refs as via byteplus', () => {
    expect(resolveMotionEndpoint('seedance_v2_5', false, 'byteplus')).toEqual({
      via: 'byteplus',
      endpointId: 'dreamina-seedance-2-5-260628',
      references: 'none',
    });
  });

  it('routes Omni Flash to fal reference-to-video when refs are present', () => {
    expect(resolveMotionEndpoint('gemini_omni_flash', true)).toEqual({
      via: 'fal',
      endpointId: 'fal-ai/gemini-omni-1.1-flash/reference-to-video',
      references: 'endpoint',
      referenceConfig: MOTION_REFERENCE_ENDPOINTS.gemini_omni_flash,
    });
  });

  it('keeps Omni Flash on fal image-to-video when there are no refs', () => {
    expect(resolveMotionEndpoint('gemini_omni_flash', false)).toEqual({
      via: 'fal',
      endpointId: IMAGE_TO_VIDEO_MODELS.gemini_omni_flash.id,
      references: 'none',
    });
  });

  it('stamps Google-native Omni Flash as via google and marks refs as inline', () => {
    expect(resolveMotionEndpoint('gemini_omni_flash', true, 'google')).toEqual({
      via: 'google',
      endpointId: 'gemini-omni-1.1-flash',
      references: 'inline',
    });
  });

  it('stamps Google-native Omni Flash with no refs as via google', () => {
    expect(resolveMotionEndpoint('gemini_omni_flash', false, 'google')).toEqual(
      {
        via: 'google',
        endpointId: 'gemini-omni-1.1-flash',
        references: 'none',
      }
    );
  });
});

describe('reference-only', () => {
  it('routes Seedance to reference-to-video even with no matched refs', () => {
    expect(resolveMotionEndpoint('seedance_v2_5', false, 'fal', true)).toEqual({
      via: 'fal',
      endpointId: 'bytedance/seedance-2.5/reference-to-video',
      references: 'endpoint',
      referenceConfig: MOTION_REFERENCE_ENDPOINTS.seedance_v2_5,
    });
  });

  it('refuses a model with no reference-to-video route', () => {
    expect(() =>
      resolveMotionEndpoint('kling_v3_pro', true, 'fal', true)
    ).toThrow(/cannot render without a start frame/);
    expect(() => resolveMotionEndpoint('veo3_1', false, 'fal', true)).toThrow(
      /cannot render without a start frame/
    );
  });

  it('marks refs inline on the native vias so no still is pinned as a frame', () => {
    expect(
      resolveMotionEndpoint('seedance_v2_5', false, 'byteplus', true)
    ).toEqual({
      via: 'byteplus',
      endpointId: 'dreamina-seedance-2-5-260628',
      references: 'inline',
    });
  });

  it('leaves image-to-video resolution untouched when the flag is off', () => {
    expect(resolveMotionEndpoint('seedance_v2_5', false, 'fal', false)).toEqual(
      resolveMotionEndpoint('seedance_v2_5', false)
    );
  });
});
