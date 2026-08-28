/**
 * Rebuilds the e2e full-pipeline scenes from recorded split + bible fixtures
 * using the same local derivation the workflow runs (#1218). Used to keep
 * visual/motion/music aimock matchers in lockstep with slice-derived metadata.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { sceneIndexForLine } from './boundary-split';
import {
  sceneSplitBiblesResultSchema,
  sceneSplitScenesResultSchema,
} from './response-schemas';
import type {
  ElementBibleEntry,
  LocationBibleEntry,
} from './scene-analysis.schema';
import {
  assembleScenes,
  type SceneSplittingScene,
} from './streaming-scene-parser';
import { reconcileSceneTags } from './tag-reconcile';
import { buildCastCharacterBible } from '@/lib/prompts/character-prompt';

const OPENROUTER_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../e2e/fixtures/recorded/openrouter'
);

const fixtureFileSchema = z.object({
  fixtures: z.array(
    z.object({
      match: z.object({
        userMessage: z.string(),
        model: z.string().optional(),
      }),
      response: z.object({ content: z.string().optional() }).passthrough(),
    })
  ),
});

export type FixtureFile = z.infer<typeof fixtureFileSchema>;

const sceneIdRowSchema = z.object({ sceneId: z.string() });

export const recordedCurrentSceneSchema = z.object({
  sceneId: z.string(),
  sceneNumber: z.number(),
  originalScript: z.object({
    extract: z.string(),
    dialogue: z.array(
      z.object({
        character: z.string(),
        line: z.string(),
        tone: z.string(),
      })
    ),
  }),
  metadata: z.object({
    title: z.string(),
    durationSeconds: z.number(),
    location: z.string(),
    timeOfDay: z.string(),
    storyBeat: z.string(),
  }),
  continuity: z.object({
    characterTags: z.array(z.string()),
    environmentTag: z.string(),
    elementTags: z.array(z.string()).nullable(),
    colorPalette: z.string(),
    lightingSetup: z.string(),
    styleTag: z.string(),
  }),
});

function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

function loadFixture(rel: string): FixtureFile {
  return fixtureFileSchema.parse(
    parseJson(readFileSync(resolve(OPENROUTER_DIR, rel), 'utf8'))
  );
}

function userMessage(rel: string): string {
  const msg = loadFixture(rel).fixtures[0]?.match.userMessage;
  if (!msg) throw new Error(`No userMessage in ${rel}`);
  return msg;
}

function responseContent(rel: string): string {
  const content = loadFixture(rel).fixtures[0]?.response.content;
  if (content === undefined) throw new Error(`No response in ${rel}`);
  return content;
}

function block(source: string, tag: string): string {
  const start = source.indexOf(`<${tag}>`);
  const end = source.indexOf(`</${tag}>`);
  if (start < 0 || end < 0) {
    throw new Error(`Missing <${tag}> in fixture`);
  }
  return source.slice(start + tag.length + 2, end).trim();
}

function recordedEnhancedScript(): string {
  return responseContent('script-enhance/script-enhance.json');
}

function recordedSceneIds(): string[] {
  const scenes = z
    .array(sceneIdRowSchema)
    .parse(
      parseJson(block(userMessage('music-design/music-design.json'), 'SCENES'))
    );
  return scenes.map((s) => s.sceneId);
}

export function replayRecordedE2eScenes(): {
  script: string;
  scenes: SceneSplittingScene[];
  characterBible: z.infer<
    typeof sceneSplitBiblesResultSchema
  >['characterBible'];
  locationBible: LocationBibleEntry[];
  elementBible: ElementBibleEntry[];
} {
  const script = recordedEnhancedScript();
  const split = sceneSplitScenesResultSchema.parse(
    parseJson(responseContent('script-analyze/script-analyze.json'))
  );
  const ids = recordedSceneIds();
  const assembled = assembleScenes(script, split, (index) => {
    const id = ids[index];
    if (!id) throw new Error(`No recorded scene id for index ${index}`);
    return id;
  });

  const bibles = sceneSplitBiblesResultSchema.parse(
    parseJson(responseContent('script-bibles/script-bibles.json'))
  );

  const sceneIdForLine = (lineNumber: number): string =>
    assembled.scenes[
      sceneIndexForLine(script, assembled.resolution.offsets, lineNumber)
    ]?.sceneId ?? '';

  const locationBible: LocationBibleEntry[] = bibles.locationBible.map(
    (entry) => ({
      ...entry,
      firstMention: {
        sceneId: sceneIdForLine(entry.firstMention.lineNumber),
        text: entry.firstMention.text,
        lineNumber: entry.firstMention.lineNumber,
      },
    })
  );
  const elementBible: ElementBibleEntry[] = bibles.elementBible.map(
    (entry) => ({
      ...entry,
      firstMention: {
        sceneId: sceneIdForLine(entry.firstMention.lineNumber),
        text: entry.firstMention.text,
        lineNumber: entry.firstMention.lineNumber,
      },
    })
  );

  const { scenes } = reconcileSceneTags(assembled.scenes, {
    characterBible: bibles.characterBible,
    locationBible,
    elementBible,
  });

  // Analyze-script casts matched talent onto the bible BEFORE visual/motion
  // prompts (#867). Replay the recorded Maisie → Sienna Blake match so
  // CHARACTER_BIBLE JSON matches live, not the pre-cast split output.
  const talentCast = z
    .object({
      matches: z.array(
        z.object({
          characterId: z.string(),
          talentId: z.string(),
        })
      ),
    })
    .parse(parseJson(responseContent('talent-cast/talent-cast.json')));
  const characterBible = buildCastCharacterBible(
    bibles.characterBible,
    talentCast.matches.map((match) => ({
      characterId: match.characterId,
      talentName: 'Sienna Blake',
    }))
  );

  return {
    script,
    scenes,
    characterBible,
    locationBible,
    elementBible,
  };
}

export function loadOpenrouterStage(stage: string): FixtureFile[] {
  const dir = resolve(OPENROUTER_DIR, stage);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) =>
      fixtureFileSchema.parse(
        parseJson(readFileSync(resolve(dir, name), 'utf8'))
      )
    );
}

export function extractTaggedJson<T>(
  userMessage: string,
  tag: string,
  schema: z.ZodType<T>
): T {
  return schema.parse(parseJson(block(userMessage, tag)));
}

export function parseFixtureFile(raw: string): FixtureFile {
  return fixtureFileSchema.parse(parseJson(raw));
}

export const visualPromptResponseSchema = z.object({
  visual: z
    .object({
      fullPrompt: z.string().optional(),
    })
    .optional(),
});

export { OPENROUTER_DIR };
