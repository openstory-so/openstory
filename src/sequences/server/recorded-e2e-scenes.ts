/**
 * Rebuilds the e2e full-pipeline scenes from recorded split + bible fixtures
 * using the same local derivation the workflow runs (#1218). Used to keep
 * visual/motion/music aimock matchers in lockstep with slice-derived metadata.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { stripTotalLine } from '@/models/enhance-duration';
import { sceneIndexForLine } from '@/sequences/boundary-split';
import {
  sceneSplitBiblesResultSchema,
  sceneSplitScenesResultSchema,
} from '@/sequences/response-schemas';
import { attachShotLists } from '@/shots/shot-list-pass';
import { shotListPassResultSchema } from '@/shots/shot-list.schema';
import type {
  ElementBibleEntry,
  LocationBibleEntry,
} from '@/shots/scene-analysis.schema';
import {
  assembleScenes,
  type SceneSplittingScene,
} from './streaming-scene-parser';
import { reconcileSceneTags } from '@/sequences/tag-reconcile';
import { buildCastCharacterBible } from '@/cast/character-prompt';

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

// The script the pipeline actually split is the LAST enhance turn: when the
// clip labels missed the target, enhance-duration.ts sends a correction turn
// ("Your clip duration labels sum to …") whose answer replaces the first.
// The app strips the enhancer's closing `TOTAL: <sum>s` line before the
// script is saved (enhance-script-turns.ts), so the split never sees it.
function recordedEnhancedScript(): string {
  const correction = loadOpenrouterStage('script-enhance').find((file) =>
    file.fixtures[0]?.match.userMessage?.startsWith(
      'Your clip duration labels sum to'
    )
  )?.fixtures[0]?.response.content;
  return stripTotalLine(
    correction ?? responseContent('script-enhance/script-enhance.json')
  );
}

function recordedSceneIds(): string[] {
  const scenes = z
    .array(sceneIdRowSchema)
    .parse(
      parseJson(block(userMessage('music-design/music-design.json'), 'SCENES'))
    );
  return scenes.map((s) => s.sceneId);
}

/** The recorded split, sliced locally: what the shot-list call was handed. */
export function recordedSplitScenes(): {
  script: string;
  assembled: ReturnType<typeof assembleScenes>;
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
  return { script, assembled };
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
  const { script, assembled } = recordedSplitScenes();

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

  const { scenes: tagged } = reconcileSceneTags(assembled.scenes, {
    characterBible: bibles.characterBible,
    locationBible,
    elementBible,
  });
  // The shot-list call's per-shot lines (#1585) replace the regex preview
  // before persist.
  // The grid is irrelevant here: the recorded script labels every shot, so
  // the labels fix the durations (#1593).
  const scenes = attachShotLists(
    tagged,
    shotListPassResultSchema.parse(
      parseJson(responseContent('script-shot-list/script-shot-list.json'))
    ),
    []
  );

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
      personality: '',
      movement: '',
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
