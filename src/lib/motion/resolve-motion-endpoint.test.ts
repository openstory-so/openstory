import { describe, expect, it } from 'vitest';
import {
  IMAGE_TO_VIDEO_MODELS,
  MOTION_REFERENCE_ENDPOINTS,
} from '@/lib/ai/models';
import { resolveMotionEndpoint } from './resolve-motion-endpoint';

describe('resolveMotionEndpoint', () => {
  it('routes Seedance to reference-to-video when refs are present', () => {
    expect(resolveMotionEndpoint('seedance_v2', true)).toEqual({
      endpointId: 'bytedance/seedance-2.5/reference-to-video',
      usesReferenceEndpoint: true,
      referenceConfig: MOTION_REFERENCE_ENDPOINTS.seedance_v2,
    });
  });

  it('keeps Seedance on image-to-video when there are no refs', () => {
    expect(resolveMotionEndpoint('seedance_v2', false)).toEqual({
      endpointId: IMAGE_TO_VIDEO_MODELS.seedance_v2.id,
      usesReferenceEndpoint: false,
    });
  });

  it('keeps Kling on image-to-video even with refs (elements ride inline)', () => {
    expect(resolveMotionEndpoint('kling_v3_pro', true)).toEqual({
      endpointId: IMAGE_TO_VIDEO_MODELS.kling_v3_pro.id,
      usesReferenceEndpoint: false,
    });
  });

  it('keeps models without a reference endpoint on image-to-video', () => {
    expect(resolveMotionEndpoint('veo3_1', true)).toEqual({
      endpointId: IMAGE_TO_VIDEO_MODELS.veo3_1.id,
      usesReferenceEndpoint: false,
    });
  });
});
