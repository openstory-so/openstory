/**
 * A/B eval: does an authored motion signature (`motion.shots/pace/energy`,
 * issue #858) produce livelier, more style-true sample videos than the same
 * style without it?
 *
 * For each base template in PAIRS, renders the SAME generated brief through
 * the real pipeline twice — once with the seeded template (baseline), once
 * with its "<name> Motion Rich" team variant (identical look/references/
 * camera; only `motion.shots/pace/energy` added). Outputs land in
 *   sample-videos-eval-baseline/<slug>/canonical.mp4
 *   sample-videos-eval-motion/<slug>/canonical.mp4
 * (same slug in both dirs so `eval-style-sample-videos.ts --dir <dir>` scores
 * both arms against the same intended-look rubric, and
 * `compare-eval-scores.ts sample-videos-eval-baseline sample-videos-eval-motion`
 * prints the movers).
 *
 * Usage:
 *   OPENSTORY_API_KEY=osk_… OPENSTORY_API_URL=http://localhost:3000 \
 *     bun scripts/eval-motion-ab.ts
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from '@/lib/ai/models';
import { GENERATED_STYLE_BRIEFS } from '@/lib/style/style-briefs.generated';
import { styleSlug } from '@/lib/style/style-slug';
import { concatClips, downloadTo } from './sample-media';
import {
  createSampleSequence,
  orderedShotVideos,
  waitForSampleSequence,
} from './sample-pipeline';

const PAIRS = ['Action', 'Neo-Noir Thriller', 'Product Ad'];
const ARMS = [
  { key: 'baseline', dir: 'sample-videos-eval-baseline', suffix: '' },
  { key: 'motion', dir: 'sample-videos-eval-motion', suffix: ' Motion Rich' },
] as const;

const baseUrl = process.env.OPENSTORY_API_URL ?? 'http://localhost:3000';
const apiKey = process.env.OPENSTORY_API_KEY;
if (!apiKey) {
  console.error('OPENSTORY_API_KEY required');
  process.exit(1);
}
const config = { baseUrl, apiKey };

async function renderOne(baseName: string, arm: (typeof ARMS)[number]) {
  const slug = styleSlug(baseName);
  const brief = GENERATED_STYLE_BRIEFS[slug];
  if (!brief) throw new Error(`no generated brief for ${slug}`);
  const outDir = path.join(process.cwd(), arm.dir, slug);
  await mkdir(path.join(outDir, '_frames'), { recursive: true });

  const label = `${baseName}${arm.suffix}`;
  const donePath = path.join(outDir, 'canonical.mp4');
  const idPath = path.join(outDir, 'canonical.sequence.json');
  if (existsSync(donePath)) {
    console.log(`[${arm.key}] ${label}: already rendered, skipping`);
    return;
  }

  // Resume: reuse a previously-created sequence id so an interrupted run
  // (or a killed poll) never re-bills a fresh render.
  let id: string;
  if (existsSync(idPath)) {
    id = z
      .object({ id: z.string().min(1) })
      .parse(JSON.parse(await readFile(idPath, 'utf8'))).id;
    console.log(`[${arm.key}] ${label}: resuming sequence ${id}`);
  } else {
    console.log(`[${arm.key}] ${label}: creating sequence…`);
    const created = await createSampleSequence(config, {
      script: brief,
      title: `eval ${label}`,
      enhance: 'always',
      targetSeconds: 15,
      styleName: label,
      aspectRatio: '16:9',
      imageModel: DEFAULT_IMAGE_MODEL,
      videoModel: DEFAULT_VIDEO_MODEL,
    });
    id = created.id;
    await writeFile(idPath, JSON.stringify({ id }));
    if (created.enhancedScript) {
      await writeFile(
        path.join(outDir, 'canonical.enhanced.txt'),
        created.enhancedScript
      );
    }
  }

  let state = await waitForSampleSequence(config, {
    id,
    onProgress: (p) =>
      console.log(`[${arm.key}] ${label}: ${JSON.stringify(p).slice(0, 120)}`),
  });
  // `orderedShotVideos` throws while any clip URL is still propagating —
  // re-poll briefly instead of failing the arm.
  let shots: ReturnType<typeof orderedShotVideos> | null = null;
  for (let retry = 0; retry < 20 && !shots; retry++) {
    try {
      shots = orderedShotVideos(state);
    } catch {
      console.log(`[${arm.key}] ${label}: waiting for clip URLs (${retry})`);
      await new Promise((r) => setTimeout(r, 15_000));
      state = await waitForSampleSequence(config, { id });
    }
  }
  if (!shots) throw new Error(`${label}: clip URLs never arrived`);

  const clips: string[] = [];
  for (const [i, shot] of shots.entries()) {
    // Local-R2 URLs are minted with VITE_APP_URL; when the dev server runs on
    // a fallback port (another worktree holds 3000), retarget them at baseUrl.
    const url = shot.videoUrl.replace('http://localhost:3000', baseUrl);
    const dest = path.join(outDir, '_frames', `shot_${i}.mp4`);
    await downloadTo(url, dest);
    clips.push(dest);
  }
  await concatClips(clips, path.join(outDir, 'canonical.mp4'));
  console.log(`[${arm.key}] ${label}: ${clips.length} clips → canonical.mp4`);
}

async function main() {
  // Both arms of a pair run concurrently; pairs run sequentially to stay
  // under the per-key rate limit and keep local fal spend gradual.
  for (const baseName of PAIRS) {
    await Promise.all(ARMS.map((arm) => renderOne(baseName, arm)));
  }
  console.log('done');
}

void main();
