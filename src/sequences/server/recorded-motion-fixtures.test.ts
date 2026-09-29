import { expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { z } from 'zod';
import { motionPromptFromVersion } from '@/motion/server/resolve-motion-prompt';
import { replayRecordedE2eScenes } from './recorded-e2e-scenes';
import { DEFAULT_STYLE_TEMPLATES } from '@/look/style-templates';
import { deriveShots } from '@/shots/shot-list.derive';
import { sceneWithShotsSchema } from '@/shots/shot-list.schema';
import { sceneForShot } from '@/shots/server/shot-work-items';
import { buildMotionRender } from '@/motion/server/build-motion-render';
import { packedSceneFromScene } from '@/motion/server/build-motion-prompts';
import { buildMotionReferenceImages } from '@/motion/server/build-motion-references';
import { buildReferenceVideoPrompt } from '@/motion/server/build-reference-video-prompt';
import { getMotionReferenceEndpoint } from '@/models/models';
it('recorded packed and individual motion requests match canonical direction and reference bindings', () => {
  const requests: string[] = [];
  const config = getMotionReferenceEndpoint('minimax_h3_max');
  if (!config) throw new Error('Missing motion reference config');
  const style = DEFAULT_STYLE_TEMPLATES.find(
    (x) => x.name === 'Product Ad'
  )?.config;
  if (!style) throw new Error('Missing Product Ad style');
  const r = replayRecordedE2eScenes('current');
  const characters = r.characterBible.map((x) => ({
    ...x,
    id: x.characterId,
    sheetImageUrl: 'https://x/' + x.characterId,
    sheetStatus: 'completed' as const,
    sheetInputHash: null,
    selectedSheetVersionId: null,
  }));
  const elements = r.elementBible.map((x) => ({
    ...x,
    id: x.token,
    imageUrl: 'https://x/' + x.token,
    kind: 'image' as const,
    durationSeconds: null,
  }));
  characters.sort((a, b) =>
    a.characterId < b.characterId ? -1 : a.characterId > b.characterId ? 1 : 0
  );
  elements.sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  for (const raw of r.scenes) {
    const scene = sceneWithShotsSchema.parse({
      ...raw,
      dialoguePresent: true,
      continuousFromPrevious: false,
      continuity: {
        ...raw.continuity,
        elementTags: raw.continuity?.elementTags ?? [],
      },
    });
    const shots = scene.shots.map((spec) => {
      const per = sceneForShot(scene, spec.shotNumber);
      const d = deriveShots(
        { ...scene, originalScript: per.originalScript },
        style
      ).find((x) => x.shotNumber === spec.shotNumber);
      if (!d) throw new Error('Missing derived shot');
      // Render reads authored per-shot dialogue, never the analysis scene's aggregate lines.
      const motionPrompt = motionPromptFromVersion(
        {
          text: d.motionPrompt.fullPrompt,
          audio: d.motionPrompt.audio ?? null,
        },
        { presence: spec.dialogue.length > 0, lines: spec.dialogue }
      );
      return {
        shotId: 'shot-' + spec.shotNumber,
        sceneId: scene.sceneId,
        renderSegmentId: scene.sceneId,
        model: 'minimax_h3_max' as const,
        duration: d.durationMs / 1000,
        imageUrl: 'https://x/still',
        prompt: d.motionPrompt.fullPrompt,
        motionPrompt,
        packedScene: packedSceneFromScene(scene, style),
        characterTags: scene.continuity.characterTags,
        generateAudio: true,
        referenceOnly: false,
      };
    });
    for (const mode of ['packed', 'single'] as const) {
      const groups = mode === 'packed' ? [shots] : shots.map((s) => [s]);
      for (const group of groups) {
        const jobs = buildMotionRender({
          shots: group,
          userId: 'u',
          teamId: 't',
        });
        for (const job of jobs) {
          const refs = buildMotionReferenceImages({
            scene,
            characters,
            elements,
            motionPrompt: job.input.prompt,
          });
          const request = buildReferenceVideoPrompt(
            config,
            job.input.prompt,
            'https://x/still',
            refs
          ).prompt;
          requests.push(request);
        }
      }
    }
  }
  const directory = new URL(
    '../../../e2e/fixtures/recorded/fal/minimax-h3-max-reference-to-video/',
    import.meta.url
  );
  const schema = z.object({
    fixtures: z.array(
      z.object({ match: z.object({ userMessage: z.string() }) })
    ),
  });
  const recorded = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) =>
      schema
        .parse(JSON.parse(readFileSync(new URL(name, directory), 'utf8')))
        .fixtures.map((fixture) => fixture.match.userMessage)
    );
  expect(requests).toHaveLength(15);
  for (const request of requests) expect(recorded).toContain(request);
});
