import type { RateCard } from '../rate-card.schema';

/**
 * https://docs.byteplus.com/en/docs/ModelArk/1544106 (Model pricing),
 * dreamina-seedance-2-5-260628, read 2026-09-13. The page is JS-rendered;
 * transcribed from its embedded document JSON:
 *
 * > Pricing varies based on output video resolution and whether the input
 * > includes video. For 480p and 720p outputs: Input without video: 10.70;
 * > Input with video: 6.40. For 1080p outputs: Input without video:
 * > (Original) 11.7 Time limited 28% off; Input with video: (Original) 7.0
 * > Time limited 28% off.   [USD per million tokens]
 * > Seedance 2.5: From 14:00 (UTC+8) on August 14, 2026 through 14:00
 * > (UTC+8) on September 17, 2026, 1080p output is billed at 28% off the
 * > list price (480p and 720p output are not eligible for the discount).
 * > Estimated video price: Token unit price × Token consumption.
 * > Estimated token consumption = (input video duration + output video
 * > duration) × width × height × 24 / 1024.
 * > When the input includes video, minimum token consumption limits apply:
 * > if the estimated token consumption is less than the minimum, the price
 * > is calculated on the minimum. The minimum is related to resolution,
 * > aspect ratio, and output duration.
 * > Price examples, 16:9, 5s output: 480p 0.514 per video; 720p 1.156 per
 * > video; 1080p 2.843 per video. With video input (lowest = 2–4 s input,
 * > highest = 30 s input): 480p 0.553–2.152; 720p 1.244–4.838; 1080p
 * > 3.062–11.907.
 *
 * Choices this card makes, all visible in the tables:
 * - 1080p is priced at LIST (11.70 / 7.00): the page's own worked example
 *   ($2.843) is at list, and reproducing it is the verification rule. The
 *   promo end is `source.expiresAt`; until then 1080p over-estimates by 28%.
 * - Dimensions are the page's implied 16:9 sizes (854×480, 1280×720,
 *   1920×1080 reproduce its token counts exactly). It publishes no sizes for
 *   the other ratios, so those lookups refuse.
 * - The minimum-token table is a Lark base the cron cannot read. Rows here
 *   are the ones the page's with-video price ranges pin: each "lowest"
 *   price is 9 s of tokens (4 s in + 5 s out) at that resolution. Any other
 *   with-video shape refuses.
 *
 * Bound to the calculator's levers, not Ark's `size` template
 * (`${ratio}_${resolution}`): the estimator splits `size` before handing the
 * request to the card. `input_video_duration` is the reference clip's
 * length in seconds, 0 when the input has no video.
 */
export const BYTEPLUS_SEEDANCE_2_5: RateCard = {
  inputs: {
    resolution: {
      param: 'resolution',
      kind: 'enum',
      values: ['480p', '720p', '1080p'],
      default: '720p',
    },
    ratio: {
      param: 'ratio',
      kind: 'enum',
      values: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
      default: '16:9',
    },
    duration: { param: 'duration', kind: 'number', default: 5 },
    input_video_duration: {
      param: 'input_video_duration',
      kind: 'number',
      default: 0,
    },
  },
  tables: {
    // USD per million tokens
    rate: {
      '480p': { no_video: 10.7, video: 6.4 },
      '720p': { no_video: 10.7, video: 6.4 },
      '1080p': { no_video: 11.7, video: 7.0 },
    },
    dims: {
      '480p': { '16:9': { w: 854, h: 480 } },
      '720p': { '16:9': { w: 1280, h: 720 } },
      '1080p': { '16:9': { w: 1920, h: 1080 } },
    },
    // [resolution][ratio][output duration] → minimum tokens with video input
    // = 9 s × per-second tokens (page: $0.553 / $1.244 / $3.062 ÷ rate)
    min_tokens: {
      '480p': { '16:9': { '5': 86_467.5 } },
      '720p': { '16:9': { '5': 194_400 } },
      '1080p': { '16:9': { '5': 437_400 } },
    },
  },
  price: {
    // rate × max(tokens, min_tokens when video is in the input) / 1e6
    '/': [
      {
        '*': [
          {
            lookup: {
              table: 'rate',
              keys: [
                { var: 'resolution' },
                {
                  if: [
                    { '>': [{ var: 'input_video_duration' }, 0] },
                    'video',
                    'no_video',
                  ],
                },
              ],
            },
          },
          {
            max: [
              {
                '/': [
                  {
                    '*': [
                      {
                        '+': [
                          { var: 'input_video_duration' },
                          { var: 'duration' },
                        ],
                      },
                      {
                        lookup: {
                          table: 'dims',
                          keys: [{ var: 'resolution' }, { var: 'ratio' }, 'w'],
                        },
                      },
                      {
                        lookup: {
                          table: 'dims',
                          keys: [{ var: 'resolution' }, { var: 'ratio' }, 'h'],
                        },
                      },
                      24,
                    ],
                  },
                  1024,
                ],
              },
              {
                if: [
                  { '>': [{ var: 'input_video_duration' }, 0] },
                  {
                    lookup: {
                      table: 'min_tokens',
                      keys: [
                        { var: 'resolution' },
                        { var: 'ratio' },
                        { var: 'duration' },
                      ],
                    },
                  },
                  0,
                ],
              },
            ],
          },
        ],
      },
      1_000_000,
    ],
  },
  examples: [
    {
      params: { resolution: '720p', ratio: '16:9', duration: 5 },
      usd: 1.156,
      quote: '720p 16:9 5s: 1.156 per video',
    },
    {
      params: { resolution: '480p', ratio: '16:9', duration: 5 },
      usd: 0.514,
      quote: '480p 16:9 5s: 0.514 per video',
    },
    {
      params: { resolution: '1080p', ratio: '16:9', duration: 5 },
      usd: 2.843,
      quote:
        '1080p 16:9 5s: 2.843 per video (list price; the 28%-off promo until Sep 17 is not applied — see header)',
    },
    {
      params: {
        resolution: '480p',
        ratio: '16:9',
        duration: 5,
        input_video_duration: 2,
      },
      usd: 0.553,
      quote:
        '480p with video: 0.553 (lowest price corresponds to 2-4 seconds input)',
    },
    {
      params: {
        resolution: '480p',
        ratio: '16:9',
        duration: 5,
        input_video_duration: 30,
      },
      usd: 2.152,
      quote:
        '480p with video: 2.152 (highest price corresponds to 30 seconds input)',
    },
    {
      params: {
        resolution: '720p',
        ratio: '16:9',
        duration: 5,
        input_video_duration: 4,
      },
      usd: 1.244,
      quote: '720p with video: 1.244 (2-4 seconds input)',
    },
    {
      params: {
        resolution: '720p',
        ratio: '16:9',
        duration: 5,
        input_video_duration: 30,
      },
      usd: 4.838,
      quote: '720p with video: 4.838 (30 seconds input)',
    },
    {
      params: {
        resolution: '1080p',
        ratio: '16:9',
        duration: 5,
        input_video_duration: 3,
      },
      usd: 3.062,
      quote: '1080p with video: 3.062 (2-4 seconds input)',
    },
    {
      params: {
        resolution: '1080p',
        ratio: '16:9',
        duration: 5,
        input_video_duration: 30,
      },
      usd: 11.907,
      quote: '1080p with video: 11.907 (30 seconds input)',
    },
  ],
  source: {
    url: 'https://docs.byteplus.com/en/docs/ModelArk/1544106',
    hash: '6d09466de8090c9d6599ef2fd2cb46c3c47983889fcfeacf5cef3e8e004fc19d',
    extractedAt: '2026-09-13T00:00:00Z',
    // 14:00 UTC+8, 2026-09-17 — end of the 1080p promo.
    expiresAt: '2026-09-17T06:00:00Z',
  },
};
