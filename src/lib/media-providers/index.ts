/**
 * Ordered media-provider registries (#1216).
 *
 * First claim wins. Native providers prepend themselves when those modules
 * land; fal is last and always claims, so a model with no native key still
 * renders on the existing fal path.
 */

import type { ImageToVideoModel, TextToImageModel } from '@/lib/ai/models';
import type { FalCredentialScopedDb } from '@/lib/db/scoped-workflow';
import { claimFrom, providerById } from './claim';
import { falImageProvider } from './fal-image';
import { falMotionProvider } from './fal-motion';
import type { MotionProvider } from './types';

export type { ProviderUsage } from './types';

const MOTION_PROVIDERS = [falMotionProvider] as const;
const IMAGE_PROVIDERS = [falImageProvider] as const;

export type MotionProviderId = (typeof MOTION_PROVIDERS)[number]['id'];
export type ImageProviderId = (typeof IMAGE_PROVIDERS)[number]['id'];

export function claimMotionProvider(
  modelKey: ImageToVideoModel,
  scopedDb?: FalCredentialScopedDb
) {
  return claimFrom(MOTION_PROVIDERS, modelKey, scopedDb);
}

export function claimImageProvider(
  modelKey: TextToImageModel,
  scopedDb?: FalCredentialScopedDb
) {
  return claimFrom(IMAGE_PROVIDERS, modelKey, scopedDb);
}

export function getMotionProvider(id: string): MotionProvider {
  return providerById(MOTION_PROVIDERS, id, 'motion');
}
