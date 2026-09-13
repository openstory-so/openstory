import type { RateCard } from '../rate-card.schema';

/**
 * https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video/llms.txt
 * Pricing section, read 2026-09-13:
 *
 * > For every second of video you generated, you will be charged **$0.112**
 * > (audio off) or **$0.168** (audio on), if voice control is used while
 * > generating audio you will be charged **$0.196**. For example, a 5s video
 * > with audio on and voice control will cost **$0.98**
 *
 * `duration` is a string enum ("3".."15") on this endpoint. The input schema
 * exposes no field for voice control (it is driven from the prompt), so
 * `voice_control` is a card-level lever the caller sets; it defaults to off.
 */
export const KLING_V3_PRO_IMAGE_TO_VIDEO: RateCard = {
  inputs: {
    duration: { param: 'duration', kind: 'number', default: 5 },
    generate_audio: { param: 'generate_audio', kind: 'boolean', default: true },
    voice_control: { param: 'voice_control', kind: 'boolean', default: false },
  },
  tables: {},
  price: {
    '*': [
      { var: 'duration' },
      {
        if: [
          { and: [{ var: 'generate_audio' }, { var: 'voice_control' }] },
          0.196,
          { var: 'generate_audio' },
          0.168,
          0.112,
        ],
      },
    ],
  },
  examples: [
    {
      params: { duration: '5', generate_audio: true, voice_control: true },
      usd: 0.98,
      quote: 'a 5s video with audio on and voice control will cost $0.98',
    },
    {
      params: { duration: '5', generate_audio: true },
      usd: 0.84,
      quote: '$0.168 (audio on) per second — 5s',
    },
    {
      params: { duration: '5', generate_audio: false },
      usd: 0.56,
      quote: '$0.112 (audio off) per second — 5s',
    },
  ],
  source: {
    url: 'https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video/llms.txt',
    hash: '65d9fd98bb2aad1a74f948572ab7a12dd5c27175fd9b2ef35de53460c39d5bd4',
    extractedAt: '2026-09-13T00:00:00Z',
  },
};
