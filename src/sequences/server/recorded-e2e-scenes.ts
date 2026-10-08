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
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
} from '@/shots/scene-analysis.schema';
import {
  assembleScenes,
  type SceneSplittingScene,
} from './streaming-scene-parser';
import { reconcileSceneTags } from '@/sequences/tag-reconcile';
import { bibleFromWire } from '@/cast/bible-looks';
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
type Recording = 'original' | 'current';

const currentFiles: Record<string, string> = {
  'script-enhance': 'script-enhance__40651532',
  'script-analyze': 'script-analyze__6a9632fc',
  'script-bibles': 'script-bibles__f82b8cf7',
  'script-shot-list': 'script-shot-list__853d9e62',
};

function recordingFile(stage: string, recording: Recording): string {
  return `${stage}/${recording === 'current' ? (currentFiles[stage] ?? stage) : stage}.json`;
}

function recordedEnhancedScript(recording: Recording): string {
  if (recording === 'current')
    return stripTotalLine(
      responseContent(recordingFile('script-enhance', recording))
    );
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
export function recordedSplitScenes(recording: Recording = 'original'): {
  script: string;
  assembled: ReturnType<typeof assembleScenes>;
} {
  const script = recordedEnhancedScript(recording);
  const split = sceneSplitScenesResultSchema.parse(
    parseJson(responseContent(recordingFile('script-analyze', recording)))
  );
  const ids = recordedSceneIds();
  const assembled = assembleScenes(script, split, (index) => {
    const id = recording === 'current' ? `scene_${index + 1}` : ids[index];
    if (!id) throw new Error(`No recorded scene id for index ${index}`);
    return id;
  });
  return { script, assembled };
}

export function replayRecordedE2eScenes(recording: Recording = 'original'): {
  script: string;
  scenes: SceneSplittingScene[];
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible: ElementBibleEntry[];
} {
  const { script, assembled } = recordedSplitScenes(recording);

  const bibles = sceneSplitBiblesResultSchema.parse(
    parseJson(responseContent(recordingFile('script-bibles', recording)))
  );

  const sceneIdForLine = (lineNumber: number): string =>
    assembled.scenes[
      sceneIndexForLine(script, assembled.sceneOffsets, lineNumber)
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

  // The recording predates looks (#2015): every character parses to none
  // and gets its default look here, as the live join does.
  const analysed = bibleFromWire(
    bibles.characterBible,
    sceneIdForLine,
    script.split('\n').length
  );
  const { scenes: tagged } = reconcileSceneTags(assembled.scenes, {
    characterBible: analysed.characterBible,
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
      parseJson(responseContent(recordingFile('script-shot-list', recording)))
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
    analysed.characterBible,
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
