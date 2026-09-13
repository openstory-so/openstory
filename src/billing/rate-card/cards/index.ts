/**
 * Hand-written rate cards (#1605, step 1), keyed by endpoint id — fal
 * endpoint ids and BytePlus model ids share one namespace, as
 * `BYTEPLUS_RATE_CARD` already relies on. Step 2 replaces these with cards
 * the cron extracts from each source; until then they prove the vocabulary
 * covers six differently shaped price pages.
 */
import type { RateCard } from '../rate-card.schema';
import { BYTEPLUS_SEEDANCE_2_5 } from './byteplus-seedance-2-5';
import { GPT_IMAGE_2_5_FLARE_TEXT_TO_IMAGE } from './gpt-image-2-5-flare-text-to-image';
import { GROK_IMAGINE_VIDEO_REFERENCE_TO_VIDEO } from './grok-imagine-video-reference-to-video';
import { H3_MAX_REFERENCE_TO_VIDEO } from './h3-max-reference-to-video';
import { KLING_V3_PRO_IMAGE_TO_VIDEO } from './kling-v3-pro-image-to-video';
import { NANO_BANANA_2 } from './nano-banana-2';

export const RATE_CARDS: Readonly<Record<string, RateCard>> = {
  'fal-ai/kling-video/v3/pro/image-to-video': KLING_V3_PRO_IMAGE_TO_VIDEO,
  'xai/grok-imagine-video/v1.5/reference-to-video':
    GROK_IMAGINE_VIDEO_REFERENCE_TO_VIDEO,
  'minimax/h3-max/reference-to-video': H3_MAX_REFERENCE_TO_VIDEO,
  'fal-ai/nano-banana-2': NANO_BANANA_2,
  'openai/gpt-image-2.5/flare/text-to-image': GPT_IMAGE_2_5_FLARE_TEXT_TO_IMAGE,
  'dreamina-seedance-2-5-260628': BYTEPLUS_SEEDANCE_2_5,
};
