/**
 * Rewrite visual/motion/music aimock match.userMessage bodies so they match
 * slice-derived scene JSON (#1218). Responses stay as recorded — fal fixtures
 * still key off those visual/motion prompts.
 *
 *   bun scripts/patch-e2e-scene-split-matchers.ts
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { narrowShotPromptContext } from '@/lib/ai/prompt-context';
import {
  extractTaggedJson,
  OPENROUTER_DIR,
  parseFixtureFile,
  recordedCurrentSceneSchema,
  replayRecordedE2eScenes,
  visualPromptResponseSchema,
} from '@/lib/ai/recorded-e2e-scenes';
import { reconstructRecordedMusicDesignPrompt } from '@/lib/ai/recorded-e2e-music-prompt';
import { getChatPrompt } from '@/lib/prompts';
import { StyleConfigSchema } from '@/lib/style/style-config';

function listStage(stage: string): Array<{
  name: string;
  path: string;
  data: ReturnType<typeof parseFixtureFile>;
  raw: string;
}> {
  const dir = resolve(OPENROUTER_DIR, stage);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const path = resolve(dir, name);
      const raw = readFileSync(path, 'utf8');
      return {
        name,
        path,
        raw,
        data: parseFixtureFile(raw),
      };
    });
}

/** Swap only the encoded userMessage so recordedTimings stay compact. */
function patchUserMessage(path: string, raw: string, from: string, to: string) {
  const oldEncoded = JSON.stringify(from);
  const newEncoded = JSON.stringify(to);
  if (!raw.includes(oldEncoded)) {
    throw new Error(`Could not locate encoded userMessage in ${path}`);
  }
  writeFileSync(path, raw.replace(oldEncoded, newEncoded));
}

const { scenes, characterBible, locationBible, elementBible } =
  replayRecordedE2eScenes();

const visualFiles = listStage('visual-prompts');
const firstVisual = visualFiles[0]?.data.fixtures[0]?.match.userMessage;
if (!firstVisual) throw new Error('No visual-prompt fixture');
const styleConfig = StyleConfigSchema.parse(
  extractTaggedJson(firstVisual, 'DIRECTOR_STYLE', z.unknown())
);
const aspectRatio = '16:9';

const visualSummaryBySceneId: Record<string, string> = {};

for (const file of visualFiles) {
  const fixture = file.data.fixtures[0];
  if (!fixture) continue;
  const recorded = extractTaggedJson(
    fixture.match.userMessage,
    'CURRENT_SCENE',
    recordedCurrentSceneSchema
  );
  const index = recorded.sceneNumber - 1;
  const scene = scenes[index];
  if (!scene) throw new Error(`No live scene ${recorded.sceneNumber}`);
  const sceneBefore = index > 0 ? scenes[index - 1] : undefined;
  const sceneAfter = index < scenes.length - 1 ? scenes[index + 1] : undefined;
  const narrowed = narrowShotPromptContext({
    scene,
    styleConfig,
    characterBible,
    locationBible,
    elementBible,
    aspectRatio,
    analysisModel: 'anthropic/claude-opus-5',
  });
  const { messages } = await getChatPrompt(
    'phase/visual-prompt-scene-generation-chat',
    {
      sceneBefore: sceneBefore
        ? JSON.stringify(sceneBefore, null, 2)
        : '(none)',
      sceneAfter: sceneAfter ? JSON.stringify(sceneAfter, null, 2) : '(none)',
      scene: JSON.stringify(scene, null, 2),
      characterBible: JSON.stringify(narrowed.characterBible, null, 2),
      locationBible: JSON.stringify(narrowed.locationBible, null, 2),
      elementBible: JSON.stringify(narrowed.elementBible, null, 2),
      styleConfig: JSON.stringify(styleConfig, null, 2),
      aspectRatio,
    }
  );
  const user = messages.find((m) => m.role === 'user');
  if (!user || typeof user.content !== 'string') {
    throw new Error(`visual prompt ${file.name}: no user message`);
  }
  patchUserMessage(
    file.path,
    file.raw,
    fixture.match.userMessage,
    user.content
  );
  const responseContent = fixture.response.content;
  if (responseContent === undefined) {
    throw new Error(`visual prompt ${file.name}: no response content`);
  }
  const parsed = visualPromptResponseSchema.parse(
    JSON.parse(responseContent) as unknown
  );
  visualSummaryBySceneId[scene.sceneId] = parsed.visual?.fullPrompt ?? '';
}

const motionFiles = listStage('motion-prompts');
for (const file of motionFiles) {
  const fixture = file.data.fixtures[0];
  if (!fixture) continue;
  const recorded = extractTaggedJson(
    fixture.match.userMessage,
    'CURRENT_SCENE',
    recordedCurrentSceneSchema
  );
  const index = recorded.sceneNumber - 1;
  const scene = scenes[index];
  if (!scene) throw new Error(`No live scene ${recorded.sceneNumber}`);
  const sceneBefore = index > 0 ? scenes[index - 1] : undefined;
  const sceneAfter = index < scenes.length - 1 ? scenes[index + 1] : undefined;
  const narrowed = narrowShotPromptContext({
    scene,
    styleConfig,
    characterBible,
    locationBible,
    elementBible,
    aspectRatio,
    analysisModel: 'anthropic/claude-opus-5',
    startingFrameImageUrl: 'https://example.invalid/frame.jpg',
  });
  const { messages } = await getChatPrompt(
    'phase/motion-prompt-scene-generation-chat',
    {
      startingFrameNote:
        'The rendered starting frame is attached below as an image — animate strictly from it.',
      sceneBefore: sceneBefore
        ? JSON.stringify(sceneBefore, null, 2)
        : '(none)',
      sceneAfter: sceneAfter ? JSON.stringify(sceneAfter, null, 2) : '(none)',
      scene: JSON.stringify(scene, null, 2),
      characterBible: JSON.stringify(narrowed.characterBible, null, 2),
      locationBible: JSON.stringify(narrowed.locationBible, null, 2),
      elementBible: JSON.stringify(narrowed.elementBible, null, 2),
      styleConfig: JSON.stringify(styleConfig, null, 2),
      aspectRatio,
    }
  );
  const user = messages.find((m) => m.role === 'user');
  if (!user || typeof user.content !== 'string') {
    throw new Error(`motion prompt ${file.name}: no user message`);
  }
  patchUserMessage(
    file.path,
    file.raw,
    fixture.match.userMessage,
    user.content
  );
}

const musicPath = resolve(OPENROUTER_DIR, 'music-design/music-design.json');
const musicRaw = readFileSync(musicPath, 'utf8');
const music = parseFixtureFile(musicRaw);
const musicFixture = music.fixtures[0];
if (!musicFixture) throw new Error('No music-design fixture');
patchUserMessage(
  musicPath,
  musicRaw,
  musicFixture.match.userMessage,
  await reconstructRecordedMusicDesignPrompt()
);

console.log(
  `Patched ${visualFiles.length} visual, ${motionFiles.length} motion, and music-design matchers.`
);
