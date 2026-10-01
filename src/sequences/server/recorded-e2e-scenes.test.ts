/**
 * The shot-list aimock fixture matches on the exact user message, so the
 * `<SCENES>` block the workflow formats from the recorded split must equal
 * the block the fixture was (re)written with — including the per-scene
 * `shots:` budget lines (#1593). This is what keeps the recorded e2e replay
 * green when the prompt formatter changes.
 *
 * The recorded enhanced script still carries the OLD `Shot N — Xs` labels
 * Enhance used to write (#1486/#1593 era) — they are frozen fixture text.
 * Since #1621 the split no longer reads them as a coverage lock, so the
 * fixture's `shots:` lines were hand-updated to the editorial-1s budget the
 * current code computes; the LLM's own shot-list response (and the resulting
 * shot durations) did not need to change.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_STYLE_TEMPLATES } from '@/look/style-templates';
import { getVariantImagePrompt } from '@/stills/server/variant-image';
import { deriveStillPrompt } from '@/shots/shot-list.derive';
import { sceneWithShotsSchema, storedShotSpec } from '@/shots/shot-list.schema';
import { buildShotImageReferenceImages } from '@/motion/server/build-motion-references';
import { buildReferenceImagePrompt } from '@/stills/reference-image-prompt';
import { DEFAULT_VIDEO_MODEL } from '@/models/models';
import { buildLocationMatchingPromptVariables } from '@/cast/server/location-matching-prompt';
import { durationGridForModel } from '@/motion/model-capabilities';
import { getChatPrompt } from '@/platform/server/ai/prompts-index';
import { formatScenesForShotListPrompt } from '@/shots/shot-list-pass';
import { buildPreviewPrompt, previewTextForShot } from './poster-prompt';
import {
  extractTaggedJson,
  loadOpenrouterStage,
  recordedSplitScenes,
  replayRecordedE2eScenes,
} from './recorded-e2e-scenes';

function fixtureScenesBlock(): string {
  const message =
    loadOpenrouterStage('script-shot-list')[0]?.fixtures[0]?.match.userMessage;
  if (!message) throw new Error('No shot-list fixture');
  const start = message.indexOf('<SCENES>\n') + '<SCENES>\n'.length;
  const end = message.indexOf('\n</SCENES>');
  return message.slice(start, end);
}

describe('recorded script-bibles fixture', () => {
  it('matches the live scene-bibles-chat user message (#1629)', async () => {
    const recorded = loadOpenrouterStage('script-bibles').find((file) =>
      file.fixtures[0]?.match.userMessage.includes(
        'Downtown Apartment Bathroom'
      )
    )?.fixtures[0]?.match.userMessage;
    if (!recorded) throw new Error('No coral-lipstick script-bibles fixture');
    const scriptStart =
      recorded.indexOf('<USER_SCRIPT>\n') + '<USER_SCRIPT>\n'.length;
    const scriptEnd = recorded.indexOf('\n</USER_SCRIPT>');
    const elementsStart =
      recorded.indexOf(
        'Produce an elementBible entry for each one used in the script:\n'
      ) +
      'Produce an elementBible entry for each one used in the script:\n'.length;
    const elementsEnd = recorded.indexOf('\n</ELEMENTS>');
    const { messages } = await getChatPrompt('phase/scene-bibles-chat', {
      script: recorded.slice(scriptStart, scriptEnd),
      elements: recorded.slice(elementsStart, elementsEnd),
    });
    const user = messages.find((message) => message.role === 'user');
    expect(user && typeof user.content === 'string' ? user.content : '').toBe(
      recorded
    );
  });
});

describe('recorded shot-list fixture', () => {
  it('matches the <SCENES> block the workflow formats from the recorded split', () => {
    const { assembled } = recordedSplitScenes();
    expect(
      formatScenesForShotListPrompt(
        assembled.scenes,
        durationGridForModel(DEFAULT_VIDEO_MODEL)
      )
    ).toBe(fixtureScenesBlock());
  });

  it('carries no shotLabelSeconds: Enhance no longer locks shot count (#1621)', () => {
    const { assembled } = recordedSplitScenes();
    for (const scene of assembled.scenes) {
      expect('shotLabelSeconds' in scene).toBe(false);
    }
    // Unused import guard: the helper is part of this module's public surface.
    expect(typeof extractTaggedJson).toBe('function');
  });
});

describe('recorded krea preview fixtures (#1642)', () => {
  it('match the shot-spec animatic prompt the split now fires', () => {
    const kreaDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../e2e/fixtures/recorded/fal/krea-2-turbo'
    );
    const kreaFileSchema = z.object({
      fixtures: z.array(
        z.object({ match: z.object({ userMessage: z.string().optional() }) })
      ),
    });
    const prompts = new Set(
      readdirSync(kreaDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          const raw = kreaFileSchema.parse(
            JSON.parse(readFileSync(resolve(kreaDir, name), 'utf8'))
          );
          return raw.fixtures[0]?.match.userMessage ?? '';
        })
    );
    const { scenes } = replayRecordedE2eScenes();
    const missing: string[] = [];
    for (const scene of scenes) {
      for (const shot of scene.shots ?? []) {
        const prompt = buildPreviewPrompt(
          previewTextForShot(scene, shot.shotNumber)
        );
        if (!prompts.has(prompt)) {
          missing.push(
            `scene ${scene.sceneNumber} shot ${shot.shotNumber}: ${prompt.slice(0, 80)}`
          );
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('recorded location matching fixture', () => {
  it('matches the physical location descriptions parsed from the recorded bibles', () => {
    const { locationBible } = replayRecordedE2eScenes();
    const { locationsDescription } = buildLocationMatchingPromptVariables(
      locationBible,
      []
    );
    const recorded = loadOpenrouterStage('location-match')
      .flatMap((file) => file.fixtures)
      .find((fixture) =>
        fixture.match.userMessage.includes('downtown_apartment_bathroom')
      )?.match.userMessage;
    expect(recorded).toBeDefined();
    expect(recorded).toContain(
      `EXTRACTED LOCATIONS FROM SCRIPT (${locationBible.length} total):\n${locationsDescription}\n\nLIBRARY LOCATIONS TO MATCH`
    );
    expect(recorded).not.toContain('Time of Day:');
  });
});

describe('recorded derived still fixtures', () => {
  it.each(['original', 'current'] as const)(
    '%s recording matches canonical scene direction and reference bindings',
    (recording) => {
      const replay = replayRecordedE2eScenes(recording);
      const style = DEFAULT_STYLE_TEMPLATES.find(
        (entry) => entry.name === 'Product Ad'
      )?.config;
      if (!style) throw new Error('Missing Product Ad style');
      // Use canonical bible identity order, independent of SQL row order.
      // Fixture identities stand in for generated URLs; text depends on tokens/order, not URLs.
      const characters: Parameters<
        typeof buildShotImageReferenceImages
      >[0]['characters'] = replay.characterBible
        .slice()
        .sort((a, b) =>
          a.characterId < b.characterId
            ? -1
            : a.characterId > b.characterId
              ? 1
              : 0
        )
        .map((entry) => ({
          ...entry,
          id: entry.characterId,
          sheetImageUrl: `https://fixture/${entry.characterId}`,
          sheetInputHash: null,
          selectedSheetVersionId: null,
          sheetStatus: 'completed',
        }));
      const locations: Parameters<
        typeof buildShotImageReferenceImages
      >[0]['locations'] = replay.locationBible
        .slice()
        .sort((a, b) =>
          a.locationId < b.locationId ? -1 : a.locationId > b.locationId ? 1 : 0
        )
        .map((entry) => ({
          ...entry,
          id: entry.locationId,
          referenceImageUrl: `https://fixture/${entry.locationId}`,
          referenceInputHash: null,
          selectedReferenceVersionId: null,
          referenceStatus: 'completed',
        }));
      const elements: Parameters<
        typeof buildShotImageReferenceImages
      >[0]['elements'] = replay.elementBible
        .slice()
        .sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0))
        .map((entry) => ({
          ...entry,
          id: entry.token,
          imageUrl: `https://fixture/${entry.token}`,
          kind: 'image',
          durationSeconds: null,
        }));
      const dir = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../e2e/fixtures/recorded/xai'
      );
      const schema = z.object({
        fixtures: z.array(
          z.object({ match: z.object({ userMessage: z.string() }) })
        ),
      });
      const requests = readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .flatMap((name) =>
          schema
            .parse(JSON.parse(readFileSync(resolve(dir, name), 'utf8')))
            .fixtures.map((fixture) => fixture.match.userMessage)
        );
      let count = 0;
      for (const rawScene of replay.scenes) {
        const scene = sceneWithShotsSchema.parse({
          ...rawScene,
          dialoguePresent: false,
          continuousFromPrevious: false,
          continuity: {
            ...rawScene.continuity,
            elementTags: rawScene.continuity?.elementTags ?? [],
          },
        });
        for (const spec of scene.shots) {
          const visualPrompt = deriveStillPrompt(
            storedShotSpec(spec),
            scene,
            style
          );
          const refs = buildShotImageReferenceImages({
            scene,
            visualPrompt,
            characters,
            locations,
            elements,
          });
          const prompt = buildReferenceImagePrompt(visualPrompt, refs).prompt;
          expect(requests).toContain(prompt);
          const grid = buildReferenceImagePrompt(
            getVariantImagePrompt('landscape_16_9', visualPrompt),
            [
              {
                referenceImageUrl: 'https://fixture/primary',
                description:
                  'Primary source scene — generate 9 variant shots from this image',
                role: 'primary',
              },
              ...refs,
            ]
          ).prompt;
          expect(requests).toContain(grid);
          count++;
        }
      }
      expect(count).toBe(10);
    }
  );
});
