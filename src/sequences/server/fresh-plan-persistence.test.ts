import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import type { Database } from '@/platform/server/db/client';
import { relations } from '@/platform/server/db/schema/relations';
import {
  framePromptVersions,
  sequences,
  shotPromptVersions,
  shotSpecVersions,
  shots,
  styles,
  teams,
  user,
} from '@/platform/server/db/schema';
import { generateId } from '@/platform/id';
import type { StyleConfig } from '@/look/style-config';
import type {
  CharacterBibleEntry,
  LocationBibleEntry,
  Scene,
} from '@/shots/scene-analysis.schema';
import { DEFAULT_ANALYSIS_MODEL } from '@/models/models.config';
import { createCastRecords } from '@/cast/server/workflows/cast-records';
import { toWorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { shotWorkItems } from '@/shots/server/shot-work-items';
import { persistShotSpec } from '@/shots/server/persist-shot-spec';

let client: Client;
let db: Database;
vi.doMock('#db-client', () => ({ getDb: () => db }));
const { createScopedDb } = await import('@/platform/server/db/scoped');
const { computeGenerationPlan } = await import('./generation-plan');
const { computePlan } = await import('@/shots/server/update-stale-plan');

const styleConfig: StyleConfig = {
  version: 2,
  look: {
    artStyle: 'watercolor',
    mood: 'quiet',
    lighting: 'soft',
    colorPalette: ['blue'],
    colorGrading: 'cool',
  },
  motion: { camera: 'locked' },
  references: [],
};
const character: CharacterBibleEntry = {
  characterId: 'maya',
  name: 'Maya',
  age: '30',
  gender: 'woman',
  ethnicity: '',
  physicalDescription: 'dark hair',
  standardClothing: 'yellow coat',
  looks: [],
  distinguishingFeatures: '',
  personality: '',
  movement: '',
  voiceDescription: '',
  voiceOnly: false,
  isPerson: true,
  consistencyTag: 'maya',
};
const location: LocationBibleEntry = {
  locationId: 'hall',
  name: 'Hall',
  type: 'interior',
  description: 'A stone hall',
  architecturalStyle: 'gothic',
  keyFeatures: 'stone arches',
  ambiance: 'quiet',
  consistencyTag: 'hall',
  firstMention: { sceneId: 'analysis-scene', text: 'Hall', lineNumber: 1 },
};
const scene: Scene = {
  sceneId: 'analysis-scene',
  sceneNumber: 1,
  originalScript: { extract: 'Maya crosses the hall.', dialogue: [] },
  metadata: {
    title: 'Hall',
    location: 'Hall',
    timeOfDay: 'day',
    storyBeat: '',
    durationSeconds: 6,
  },
  continuity: {
    characterTags: ['maya'],
    environmentTag: 'hall',
    colorPalette: '',
    lightingSetup: '',
    styleTag: '',
  },
  shots: [1, 2].map((shotNumber) => ({
    shotNumber,
    framing: {
      shotSize: 'wide',
      angle: 'eye level',
      composition: 'Maya in the hall',
      subjectStartState: 'standing',
    },
    action: 'Maya walks',
    cameraMovement: { move: 'static', pacing: 'slow' },
    direction: '',
    soundCue: '',
    dialogue: [],
    durationSeconds: 3,
  })),
};
beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});
afterAll(() => client.close());

it('keeps persisted derived prompts current before sheets exist, while retaining edit staleness', async () => {
  const teamId = generateId(),
    actorId = generateId(),
    sequenceId = generateId(),
    styleId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'Team', slug: teamId });
  await db
    .insert(user)
    .values({ id: actorId, name: 'User', email: 'persist@example.com' });
  await db
    .insert(styles)
    .values({ id: styleId, teamId, name: 'Look', config: styleConfig });
  await db.insert(sequences).values({
    id: sequenceId,
    teamId,
    title: 'Sequence',
    styleId,
    status: 'completed',
    analysisModel: DEFAULT_ANALYSIS_MODEL,
    imageModel: 'nano_banana_2',
    videoModel: 'kling_v3_pro',
    aspectRatio: '16:9',
    generateStartFrames: true,
    includeMusic: false,
    generationStopAt: 'images',
  });
  const scopedDb = createScopedDb(teamId, actorId);
  const narrative = {
    title: 'Hall',
    location: 'Hall',
    timeOfDay: 'day',
    storyBeat: '',
    continuity: scene.continuity ?? null,
  };
  const savedScene = await scopedDb.scenes.create(
    { sequenceId, orderIndex: 0 },
    narrative,
    { createdBy: actorId }
  );
  await scopedDb.sceneScriptVersions.write({
    sceneId: savedScene.id,
    content: scene.originalScript,
    narrative,
    source: 'split',
  });
  const mapping = [];
  for (const shotNumber of [1, 2]) {
    const shot = await scopedDb.shots.create({
      sequenceId,
      sceneId: savedScene.id,
      shotNumber,
      durationMs: 3000,
    });
    await scopedDb.shots.ensureAnchorFrames([shot]);
    const anchor = (await scopedDb.frames.getAnchorsByShots([shot.id])).get(
      shot.id
    );
    if (!anchor) throw new Error('Missing anchor');
    mapping.push({
      analysisSceneId: scene.sceneId,
      shotId: shot.id,
      frameId: anchor.id,
      shotNumber,
    });
  }
  await createCastRecords(toWorkflowScopedDb(scopedDb), {
    sequenceId,
    cast: [],
    characterBible: [character],
    locationBible: [location],
    elementBible: [],
    talentMatches: [],
    locationMatches: [],
    existingElements: [],
  });
  // Twice: a replayed step must not append a second spec or prompt.
  for (const _replay of [1, 2]) {
    for (const item of shotWorkItems([scene], mapping)) {
      const written = await persistShotSpec(
        toWorkflowScopedDb(scopedDb),
        item,
        {
          styleConfig,
          characterBible: [character],
          locationBible: [location],
          elementBible: [],
          aspectRatio: '16:9',
          analysisModel: DEFAULT_ANALYSIS_MODEL,
          referenceOnly: false,
        }
      );
      expect(written).toEqual({ stillPrompt: true });
    }
  }
  const specRows = await db.select().from(shotSpecVersions);
  expect(specRows).toHaveLength(2);
  // Key order is not identity: a reordered copy of the selected spec is a replay.
  const first = specRows[0];
  if (!first) throw new Error('Missing spec row');
  const reordered = {
    soundCue: first.spec.soundCue,
    direction: first.spec.direction,
    cameraMovement: first.spec.cameraMovement,
    action: first.spec.action,
    framing: first.spec.framing,
  };
  const replayed = await scopedDb.shotSpecVersions.write({
    shotId: first.shotId,
    spec: reordered,
    source: 'analysis',
    inputHash: first.inputHash,
    createdBy: null,
  });
  expect(replayed.id).toBe(first.id);
  // A changed spec appends a version and moves the pointer to it.
  const changed = await scopedDb.shotSpecVersions.write({
    shotId: first.shotId,
    spec: { ...first.spec, action: 'changed' },
    source: 'analysis',
    inputHash: first.inputHash,
    createdBy: null,
  });
  expect(changed.id).not.toBe(first.id);
  const [moved] = await db
    .select()
    .from(shots)
    .where(eq(shots.id, first.shotId));
  expect(moved?.selectedSpecVersionId).toBe(changed.id);
  // Restore so the assertions below still see the persisted spec selected.
  await db
    .update(shots)
    .set({ selectedSpecVersionId: first.id })
    .where(eq(shots.id, first.shotId));
  for (const m of mapping) {
    const [shot] = await db.select().from(shots).where(eq(shots.id, m.shotId));
    const spec = specRows.find((row) => row.shotId === m.shotId);
    expect(shot?.selectedSpecVersionId).toBe(spec?.id);
    const motion = await db
      .select()
      .from(shotPromptVersions)
      .where(eq(shotPromptVersions.shotId, m.shotId));
    expect(motion.map((row) => [row.source, row.specVersionId])).toEqual([
      ['derived', spec?.id],
    ]);
    const still = await db
      .select()
      .from(framePromptVersions)
      .where(eq(framePromptVersions.frameId, m.frameId));
    expect(still.map((row) => [row.source, row.specVersionId])).toEqual([
      ['derived', spec?.id],
    ]);
  }
  const units = await computeGenerationPlan(scopedDb, sequenceId);
  expect(
    units.filter((u) => u.kind.startsWith('prompt:')).map((u) => u.state)
  ).toEqual(['done', 'done', 'done', 'done']);
  expect(
    units.filter((u) => u.kind.startsWith('sheet:')).map((u) => u.state)
  ).toEqual(['missing', 'missing']);
  const plan = await computePlan({
    scopedDb,
    sequenceId,
    userId: actorId,
    units: mapping.map((m) => ({ kind: 'still', id: m.shotId })),
  });
  expect(plan.promptContext?.characterBible).toHaveLength(1);
  expect(plan.promptContext?.locationBible).toHaveLength(1);
  const cast = await scopedDb.characters.list(sequenceId);
  const places = await scopedDb.sequenceLocations.list(sequenceId);
  expect(plan.targets[0]?.referenceIds).toHaveLength(2);
  expect(plan.targets[0]?.referenceIds).toEqual(
    expect.arrayContaining([cast[0]?.id, places[0]?.id])
  );
  expect(
    plan.targets.every((target) => !target.regenVisual && !target.regenMotion)
  ).toBe(true);
  await createCastRecords(toWorkflowScopedDb(scopedDb), {
    sequenceId,
    cast: [],
    characterBible: [{ ...character, standardClothing: 'red armor' }],
    locationBible: [location],
    elementBible: [],
    talentMatches: [],
    locationMatches: [],
    existingElements: [],
  });
  const edited = await computeGenerationPlan(scopedDb, sequenceId);
  expect(
    edited
      .filter((u) => u.kind.startsWith('prompt:'))
      .every((u) => u.state === 'stale')
  ).toBe(true);
  // Restore the bible first so the following assertion isolates a style edit.
  await createCastRecords(toWorkflowScopedDb(scopedDb), {
    sequenceId,
    cast: [],
    characterBible: [character],
    locationBible: [location],
    elementBible: [],
    talentMatches: [],
    locationMatches: [],
    existingElements: [],
  });
  expect(
    (await computeGenerationPlan(scopedDb, sequenceId))
      .filter((u) => u.kind.startsWith('prompt:'))
      .every((u) => u.state === 'done')
  ).toBe(true);
  await db
    .update(styles)
    .set({
      config: {
        ...styleConfig,
        look: { ...styleConfig.look, colorPalette: ['red'] },
      },
    })
    .where(eq(styles.id, styleId));
  const changedStyle = await computeGenerationPlan(scopedDb, sequenceId);
  expect(
    changedStyle
      .filter((u) => u.kind.startsWith('prompt:'))
      .every((u) => u.state === 'stale')
  ).toBe(true);
});
