import { describe, expect, it } from 'vitest';
import {
  EDIT_ENDPOINTS,
  IMAGE_TO_VIDEO_MODELS,
  MOTION_REFERENCE_ENDPOINTS,
} from '@/lib/ai/models';
import { catalogFalEndpointIds } from '@/lib/billing/catalog-endpoints';
import { studioVideoEndpointId } from '@/lib/studio/text-to-video';

describe('catalogFalEndpointIds', () => {
  it('includes Seedance image-to-video and reference-to-video endpoints', () => {
    const ids = catalogFalEndpointIds();
    expect(ids).toContain(IMAGE_TO_VIDEO_MODELS.seedance_v2.id);
    expect(ids).toContain(MOTION_REFERENCE_ENDPOINTS.seedance_v2?.endpointId);
    expect(ids).toContain(IMAGE_TO_VIDEO_MODELS.seedance_v2_5.id);
    expect(ids).toContain(MOTION_REFERENCE_ENDPOINTS.seedance_v2_5?.endpointId);
    expect(ids).toContain(
      MOTION_REFERENCE_ENDPOINTS.minimax_h3_max?.endpointId
    );
  });

  it('includes studio text/reference endpoints and edit siblings (#1388)', () => {
    const ids = catalogFalEndpointIds();
    expect(ids).toContain(studioVideoEndpointId('seedance_v2', 'text'));
    expect(ids).toContain(studioVideoEndpointId('kling_v3_pro', 'reference'));
    for (const endpointId of Object.values(EDIT_ENDPOINTS)) {
      expect(ids).toContain(endpointId);
    }
  });
});
