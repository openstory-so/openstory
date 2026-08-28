import { describe, expect, it } from 'vitest';
import {
  IMAGE_TO_VIDEO_MODELS,
  MOTION_REFERENCE_ENDPOINTS,
} from '@/lib/ai/models';
import { catalogFalEndpointIds } from '@/lib/billing/catalog-endpoints';

describe('catalogFalEndpointIds', () => {
  it('includes Seedance image-to-video and reference-to-video endpoints', () => {
    const ids = catalogFalEndpointIds();
    expect(ids).toContain(IMAGE_TO_VIDEO_MODELS.seedance_v2.id);
    expect(ids).toContain(MOTION_REFERENCE_ENDPOINTS.seedance_v2?.endpointId);
  });
});
