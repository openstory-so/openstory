import type { Expr, RateCard, RateCardExample } from '../rate-card.schema';

/**
 * The nine fal Seedance endpoints, Pricing sections read 2026-09-13. Three
 * families, each with an image-to-video, reference-to-video and
 * text-to-video page; i2v and t2v carry the same text, r2v adds the
 * video-input rule. These replace the `tokens` estimation strategy and its
 * 16:9 dimension table (#1605): the formula now lives in the card, and the
 * page's own per-second figures are what get quoted.
 *
 * `input_video_duration` is a card-level lever (seconds of video reference
 * the request carries; the body has only URLs) — studio sets it, sequences
 * never send clips, so it defaults to 0.
 */

const EXTRACTED_AT = '2026-09-13T00:00:00Z';

const falUrl = (endpointId: string) =>
  `https://fal.ai/models/${endpointId}/llms.txt`;

const DURATION = { param: 'duration', kind: 'number', default: 5 } as const;
const INPUT_VIDEO = {
  param: 'input_video_duration',
  kind: 'number',
  default: 0,
} as const;

/**
 * Seedance 2.5 / 2.0 Mini: fal states a per-second price per resolution.
 *
 * 2.5 (`bytedance/seedance-2.5/…`):
 * > For 480p, your request will cost roughly **$0.2205** per second of
 * > generated video, for 720p, you will be charged roughly **$0.4730** per
 * > second of generated video, and for 1080p, roughly **$1.164** per second
 * > of generated video. [r2v:] If video inputs are provided the price is
 * > multiplied by 0.6. With video inputs and 720p resolution, the price is
 * > roughly **$0.2838** per second of generated video. With video
 * > references, you will be charged for both input and output videos.
 *
 * 2.0 Mini (`bytedance/seedance-2.0/mini/…`):
 * > For every second of video generated, you will be charged roughly
 * > **$0.0721** per second for **480p** and **$0.1547** per second for **720p**.
 * > [r2v:] If a video input is provided, the video input is charged at
 * > **0.6** times the per-second price for the selected resolution. This is
 * > roughly **$0.0433/second** for 480p video and **$0.0928/second** for
 * > 720p video. You will be charged for video input and output, at the rate
 * > for the output resolution.
 *
 * The two r2v pages word the video rule differently and the cards follow
 * each: 2.5 multiplies the whole (input + output) charge by 0.6; Mini bills
 * output seconds at the full rate and input seconds at 0.6×.
 */
function perSecondCard(opts: {
  endpointId: string;
  hash: string;
  perSecond: Record<string, number>;
  videoInput?: 'whole' | 'input';
  examples: RateCardExample[];
}): RateCard {
  const rate: Expr = {
    lookup: { table: 'per_second', keys: [{ var: 'resolution' }] },
  };
  const hasVideo: Expr = { '>': [{ var: 'input_video_duration' }, 0] };
  const price: Expr =
    opts.videoInput === 'whole'
      ? {
          '*': [
            { '+': [{ var: 'duration' }, { var: 'input_video_duration' }] },
            rate,
            { if: [hasVideo, 0.6, 1] },
          ],
        }
      : opts.videoInput === 'input'
        ? {
            '+': [
              { '*': [{ var: 'duration' }, rate] },
              { '*': [{ var: 'input_video_duration' }, rate, 0.6] },
            ],
          }
        : { '*': [{ var: 'duration' }, rate] };
  return {
    inputs: {
      duration: DURATION,
      resolution: {
        param: 'resolution',
        kind: 'enum',
        values: Object.keys(opts.perSecond),
        default: '720p',
      },
      ...(opts.videoInput && { input_video_duration: INPUT_VIDEO }),
    },
    tables: { per_second: opts.perSecond },
    price,
    examples: opts.examples,
    source: {
      url: falUrl(opts.endpointId),
      hash: opts.hash,
      extractedAt: EXTRACTED_AT,
    },
  };
}

const SEEDANCE_2_5_PER_SECOND = {
  '480p': 0.2205,
  '720p': 0.473,
  '1080p': 1.164,
};
const SEEDANCE_2_5_EXAMPLES: RateCardExample[] = [
  {
    params: { duration: '5', resolution: '720p' },
    usd: 2.365,
    quote: 'for 720p, you will be charged roughly $0.4730 per second — 5s',
  },
  {
    params: { duration: '5', resolution: '480p' },
    usd: 1.1025,
    quote: 'For 480p, your request will cost roughly $0.2205 per second — 5s',
  },
  {
    params: { duration: '5', resolution: '1080p' },
    usd: 5.82,
    quote: 'for 1080p, roughly $1.164 per second — 5s',
  },
];

const MINI_PER_SECOND = { '480p': 0.0721, '720p': 0.1547 };
const MINI_EXAMPLES: RateCardExample[] = [
  {
    params: { duration: '5', resolution: '720p' },
    usd: 0.7735,
    quote: '$0.1547/second for 720p — 5s',
  },
  {
    params: { duration: '5', resolution: '480p' },
    usd: 0.3605,
    quote: '$0.0721/second for 480p — 5s',
  },
];

/**
 * Seedance 2.0 enterprise (`bytedance/seedance-2.0/enterprise/v2/…`), which
 * publishes only the 720p per-second figure and the token formula:
 *
 * > For every second of 720p video you generated, you will be charged
 * > **$0.3024/second**. Your request will cost $0.014 per 1000 tokens. The
 * > number of tokens is given by (height of output video * width of output
 * > video * duration * 24) / 1024. [r2v: … * ( input duration + output
 * > duration) * 24) / 1024. **If video inputs are provided the price is
 * > multiplied by 0.6**. With video inputs and 720p resolution the price is
 * > **$0.1814** per second.]
 *
 * (The t2v page says $0.3034 — a typo within the 1% tolerance.) 720p
 * reproduces exactly at 1280×720. The page names no output sizes for the
 * other tiers, so the table assumes 16:9 for them — the same assumption the
 * retired `TOKEN_RESOLUTION_DIMENSIONS` made — and a portrait request is
 * over-quoted by nothing worse than that.
 */
function enterpriseCard(opts: {
  endpointId: string;
  hash: string;
  videoInput: boolean;
  examples: RateCardExample[];
}): RateCard {
  const dim = (side: 'w' | 'h'): Expr => ({
    lookup: { table: 'dims', keys: [{ var: 'resolution' }, side] },
  });
  const seconds: Expr = opts.videoInput
    ? { '+': [{ var: 'duration' }, { var: 'input_video_duration' }] }
    : { var: 'duration' };
  const usd: Expr = {
    '*': [
      { '/': [{ '*': [dim('w'), dim('h'), seconds, 24] }, 1024 * 1000] },
      0.014,
    ],
  };
  return {
    inputs: {
      duration: DURATION,
      resolution: {
        param: 'resolution',
        kind: 'enum',
        values: ['480p', '720p', '1080p', '4k'],
        default: '720p',
      },
      ...(opts.videoInput && { input_video_duration: INPUT_VIDEO }),
    },
    tables: {
      dims: {
        '480p': { w: 854, h: 480 },
        '720p': { w: 1280, h: 720 },
        '1080p': { w: 1920, h: 1080 },
        '4k': { w: 3840, h: 2160 },
      },
    },
    price: opts.videoInput
      ? {
          '*': [
            usd,
            { if: [{ '>': [{ var: 'input_video_duration' }, 0] }, 0.6, 1] },
          ],
        }
      : usd,
    examples: opts.examples,
    source: {
      url: falUrl(opts.endpointId),
      hash: opts.hash,
      extractedAt: EXTRACTED_AT,
    },
  };
}

const ENTERPRISE_720P: RateCardExample = {
  params: { duration: '5', resolution: '720p' },
  usd: 1.512,
  quote:
    'For every second of 720p video you generated, you will be charged $0.3024/second — 5s',
};

export const SEEDANCE_FAL_RATE_CARDS: Readonly<Record<string, RateCard>> = {
  'bytedance/seedance-2.0/enterprise/v2/image-to-video': enterpriseCard({
    endpointId: 'bytedance/seedance-2.0/enterprise/v2/image-to-video',
    hash: '9534b87848e2968c9e7419fccd290dfe0487421cb54bfdb3dcbb350997a22d2f',
    videoInput: false,
    examples: [ENTERPRISE_720P],
  }),
  'bytedance/seedance-2.0/enterprise/v2/text-to-video': enterpriseCard({
    endpointId: 'bytedance/seedance-2.0/enterprise/v2/text-to-video',
    hash: '3b67bc89b5f39e0962c76b95e3961e51cda5f6670606bba944c125bafcdb2113',
    videoInput: false,
    examples: [
      { ...ENTERPRISE_720P, usd: 1.517, quote: '$0.3034/second — 5s' },
    ],
  }),
  'bytedance/seedance-2.0/enterprise/v2/reference-to-video': enterpriseCard({
    endpointId: 'bytedance/seedance-2.0/enterprise/v2/reference-to-video',
    hash: '4fea96ce18d620d80ee585418d52ccc9447b05cc1b883c4e0785d27f3a6b6e4a',
    videoInput: true,
    examples: [
      ENTERPRISE_720P,
      {
        params: { duration: '5', resolution: '720p', input_video_duration: 5 },
        usd: 1.814,
        quote:
          'With video inputs and 720p resolution the price is $0.1814 per second — 5s in + 5s out',
      },
    ],
  }),
  'bytedance/seedance-2.5/image-to-video': perSecondCard({
    endpointId: 'bytedance/seedance-2.5/image-to-video',
    hash: 'ba2e13cb02c3ec69d9153272a0239203a53462c3a020a52ed7a44e62f61e8d76',
    perSecond: SEEDANCE_2_5_PER_SECOND,
    examples: SEEDANCE_2_5_EXAMPLES,
  }),
  'bytedance/seedance-2.5/text-to-video': perSecondCard({
    endpointId: 'bytedance/seedance-2.5/text-to-video',
    hash: 'ba2e13cb02c3ec69d9153272a0239203a53462c3a020a52ed7a44e62f61e8d76',
    perSecond: SEEDANCE_2_5_PER_SECOND,
    examples: SEEDANCE_2_5_EXAMPLES,
  }),
  'bytedance/seedance-2.5/reference-to-video': perSecondCard({
    endpointId: 'bytedance/seedance-2.5/reference-to-video',
    hash: '88df1181d6ee26ef44338d4c942555331ef0db35b3d6553fadf66c1b7494c904',
    perSecond: SEEDANCE_2_5_PER_SECOND,
    videoInput: 'whole',
    examples: [
      ...SEEDANCE_2_5_EXAMPLES,
      {
        params: { duration: '5', resolution: '720p', input_video_duration: 5 },
        usd: 2.838,
        quote:
          'With video inputs and 720p resolution, the price is roughly $0.2838 per second — 5s in + 5s out',
      },
    ],
  }),
  'bytedance/seedance-2.0/mini/image-to-video': perSecondCard({
    endpointId: 'bytedance/seedance-2.0/mini/image-to-video',
    hash: 'af222bf568fb0cad39a464f02990cc5c7c0a6d45dfe28b5c8f40e5dd4d1f1136',
    perSecond: MINI_PER_SECOND,
    examples: MINI_EXAMPLES,
  }),
  'bytedance/seedance-2.0/mini/text-to-video': perSecondCard({
    endpointId: 'bytedance/seedance-2.0/mini/text-to-video',
    hash: 'ffb023b702ebd5f12d797b8b9de7885f455b96f27a4bdc797796b7d0b66f2d0e',
    perSecond: MINI_PER_SECOND,
    examples: MINI_EXAMPLES,
  }),
  'bytedance/seedance-2.0/mini/reference-to-video': perSecondCard({
    endpointId: 'bytedance/seedance-2.0/mini/reference-to-video',
    hash: 'a0d8f577d233bcdbfafad197cf838ebeaad80427984e01d4dbe88b8ab9fb3b3c',
    perSecond: MINI_PER_SECOND,
    videoInput: 'input',
    examples: [
      ...MINI_EXAMPLES,
      {
        params: { duration: '5', resolution: '720p', input_video_duration: 5 },
        usd: 1.2375,
        quote:
          'video input is charged at 0.6 times the per-second price … $0.0928/second for 720p — 5s in + 5s out',
      },
    ],
  }),
};
