import type { Expr, RateCard, RateCardExample } from '../rate-card.schema';

/**
 * https://docs.byteplus.com/en/docs/ModelArk/1544106 (Model pricing), read
 * 2026-09-13 from the page's embedded document JSON, USD per million tokens:
 *
 * dreamina-seedance-2-0-260128:
 * > Pricing varies based on output video resolution and whether the input
 * > includes video. For 480p and 720p outputs: Input without video: 7.0;
 * > Input with video: 4.3. For 1080p outputs: Input without video: 7.7;
 * > Input with video: 4.7. For 4K outputs: Input without video: 4.0; Input
 * > with video: 2.4.
 * > Dreamina Seedance 2.0 (USD): 0.76 per video / 0.15 per second [720p 5s];
 * > 1.87 per video / 0.37 per second [1080p 5s]; 0.35 per video / 0.07 per
 * > second [480p 5s].
 *
 * dreamina-seedance-2-0-mini-260615:
 * > Pricing varies based on whether the input includes video. For 480p and
 * > 720p outputs: Input without video: (Original) 3.5 Time limited 60% off;
 * > Input with video: (Original) 2.1 Time limited 60% off.
 * > Dreamina Seedance 2.0 Mini (USD): 0.38 per video / 0.08 per second
 * > [720p 5s]; 0.18 per video / 0.04 per second [480p 5s].
 *
 * Same formula and 16:9 dimensions as the 2.5 card (`tokens = w × h × (in
 * + out) × 24 / 1024`); 720p and 1080p reproduce the page's own figures
 * exactly, the 480p figures are rounded on the page by more than 1% and are
 * not carried as examples. Mini is priced at LIST like the 2.5 card — its
 * worked examples are at list and the page names no promo end. The page's
 * minimum-token rule for video input is a Lark base the cron cannot read,
 * so with-video shapes price the formula alone (an under-estimate for very
 * short clips) — the drift report is where that shows up. No 4K row: the
 * page publishes no 4K dimensions.
 *
 * Bound to the fal-shaped levers the estimator hands every video card
 * (`resolution`, `aspect_ratio`, `duration`); `input_video_duration` is the
 * card-level lever studio sets.
 */
function arkSeedanceCard(opts: {
  rate: Record<string, { no_video: number; video: number }>;
  hash: string;
  examples: RateCardExample[];
}): RateCard {
  const dim = (side: 'w' | 'h'): Expr => ({
    lookup: {
      table: 'dims',
      keys: [{ var: 'resolution' }, { var: 'aspect_ratio' }, side],
    },
  });
  const tier: Expr = {
    if: [{ '>': [{ var: 'input_video_duration' }, 0] }, 'video', 'no_video'],
  };
  return {
    inputs: {
      resolution: {
        param: 'resolution',
        kind: 'enum',
        values: Object.keys(opts.rate),
        default: '720p',
      },
      aspect_ratio: {
        param: 'aspect_ratio',
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
      rate: opts.rate,
      dims: Object.fromEntries(
        Object.keys(opts.rate).map((resolution) => [
          resolution,
          {
            '16:9':
              resolution === '480p'
                ? { w: 854, h: 480 }
                : resolution === '720p'
                  ? { w: 1280, h: 720 }
                  : { w: 1920, h: 1080 },
          },
        ])
      ),
    },
    price: {
      '/': [
        {
          '*': [
            { lookup: { table: 'rate', keys: [{ var: 'resolution' }, tier] } },
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
                    dim('w'),
                    dim('h'),
                    24,
                  ],
                },
                1024,
              ],
            },
          ],
        },
        1_000_000,
      ],
    },
    examples: opts.examples,
    source: {
      url: 'https://docs.byteplus.com/en/docs/ModelArk/1544106',
      hash: opts.hash,
      extractedAt: '2026-09-13T00:00:00Z',
    },
  };
}

export const BYTEPLUS_SEEDANCE_2_0 = arkSeedanceCard({
  rate: {
    '480p': { no_video: 7.0, video: 4.3 },
    '720p': { no_video: 7.0, video: 4.3 },
    '1080p': { no_video: 7.7, video: 4.7 },
  },
  hash: 'c413b7ff05bf6f8a5224908a2ed0f057bcc2b8de4d4b39fd6904ffcdc3b8fb86',
  examples: [
    {
      params: { resolution: '720p', duration: 5 },
      usd: 0.756,
      quote:
        'Dreamina Seedance 2.0 (USD): 0.76 per video, 0.15 per second — 720p 5s',
    },
    {
      params: { resolution: '1080p', duration: 5 },
      usd: 1.871,
      quote:
        'Dreamina Seedance 2.0 (USD): 1.87 per video, 0.37 per second — 1080p 5s',
    },
  ],
});

export const BYTEPLUS_SEEDANCE_2_0_MINI = arkSeedanceCard({
  rate: {
    '480p': { no_video: 3.5, video: 2.1 },
    '720p': { no_video: 3.5, video: 2.1 },
  },
  hash: 'adffe9687e088a36f4ef1842f35aeb6826178ef951724ba11b6c2b43b5f926e5',
  examples: [
    {
      params: { resolution: '720p', duration: 5 },
      usd: 0.378,
      quote:
        'Dreamina Seedance 2.0 Mini (USD): 0.38 per video, 0.08 per second — 720p 5s',
    },
  ],
});
