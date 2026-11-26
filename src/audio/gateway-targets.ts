/** The audio models a root trigger routes (#2436); children inherit the routes. */

import { ELEVENLABS_MUSIC_MODEL } from '@/billing/elevenlabs-pricing';
import { SEED_AUDIO_MODEL } from '@/cast/seed-voice';
import type { GatewayRouteTarget } from '@/gateway/server/route';

export const SEED_AUDIO_TARGET: GatewayRouteTarget = {
  provider: 'byteplus',
  modelId: SEED_AUDIO_MODEL,
};
export const ELEVENLABS_MUSIC_TARGET: GatewayRouteTarget = {
  provider: 'elevenlabs',
  modelId: ELEVENLABS_MUSIC_MODEL,
};

export const AUDIO_ROUTE_TARGETS: readonly GatewayRouteTarget[] = [
  SEED_AUDIO_TARGET,
  ELEVENLABS_MUSIC_TARGET,
];
