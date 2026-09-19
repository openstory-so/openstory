import type { ScopedDb } from '@/platform/server/db/scoped';
import { readPage } from '@/platform/server/read-page';
import type { PageInput } from '@/platform/server/read-page';
import { productionAccess } from '@/sequences/server/production-access';
import type {
  Character,
  SequenceLocation,
  SequenceElement,
  Shot,
} from '@/platform/server/db/schema';
import {
  matchCharactersToScene,
  matchLocationsToScene,
  matchElementsToShot,
} from '@/shots/scene-matching';
import { resolveSceneForShot } from './scene-script';
import {
  rendersReferenceOnly,
  type StartFrameSequence,
} from '@/shots/use-start-frame';
import { isElementVoiceToken } from '@/motion/dialogue-tts';
import {
  computeShotStaleness,
  UNTRACKED_STALENESS,
  type ShotStalenessRefs,
} from './shot-staleness';
import { z } from 'zod';

type ReadPageInput = PageInput & { sequenceId: string };

/** Page a sequence's live shots by id, optionally within one scene. */
async function pageShots(
  scopedDb: ScopedDb,
  input: ReadPageInput & { sceneId?: string },
  scope: string
) {
  const scene = input.sceneId
    ? await productionAccess(scopedDb).scene(input.sequenceId, input.sceneId)
    : null;
  return readPage(
    input,
    [input.sequenceId, 'shots', input.sceneId ?? '', scope],
    (page) =>
      scopedDb.shots.listBySequence(input.sequenceId, {
        sceneId: scene?.id,
        page,
      })
  );
}

export const referenceKindSchema = z.enum(['character', 'location', 'element']);
export type ReferenceKind = z.infer<typeof referenceKindSchema>;
export const artifactStalenessSchema = z.enum([
  'fresh',
  'stale',
  'updating',
  'generating',
  'untracked',
  'unknown',
]);
export const shotStalenessSchema = z.object({
  shotId: z.string(),
  frameId: z.string().nullable(),
  thumbnail: artifactStalenessSchema,
  visualPrompt: artifactStalenessSchema,
  motionPrompt: artifactStalenessSchema,
  causes: z.array(z.string()),
});

/** This loader never invokes editor middleware that repairs missing anchor frames. */
export async function loadInspectionShot(
  scopedDb: ScopedDb,
  sequenceId: string,
  shot: Shot
) {
  const scene = shot.sceneId
    ? await productionAccess(scopedDb).scene(sequenceId, shot.sceneId)
    : null;
  const script = scene
    ? await scopedDb.sceneScriptVersions.getSelected(scene.id)
    : null;
  const anchor = await scopedDb.frames.getAnchorByShot(shot.id);
  const frame = anchor?.sequenceId === sequenceId ? anchor : null;
  const visual = frame
    ? await scopedDb.framePromptVersions.getSelected(frame.id)
    : null;
  const motion = await scopedDb.shotPromptVersions.getSelectedMotion(shot.id);
  return {
    shot,
    frame,
    scene: resolveSceneForShot(
      shot,
      scene
        ? {
            scene,
            script: script?.sceneId === scene.id ? script.content : null,
          }
        : null
    ).scene,
    visual: visual?.frameId === frame?.id ? visual : null,
    motion: motion?.shotId === shot.id ? motion : null,
  };
}
function matchReferences(
  ctx: Awaited<ReturnType<typeof loadInspectionShot>>,
  sequence: StartFrameSequence
) {
  const scene = ctx.scene;
  return {
    characters: (rows: Character[]) =>
      matchCharactersToScene(rows, scene?.continuity?.characterTags ?? []),
    locations: (rows: SequenceLocation[]) =>
      matchLocationsToScene(
        rows,
        scene?.continuity?.environmentTag ?? '',
        scene?.metadata?.location ?? '',
        scene?.originalScript.extract
      ),
    elements: (rows: SequenceElement[]) =>
      matchElementsToShot(rows, {
        visualPrompt: ctx.visual?.text,
        motionPrompt: ctx.motion?.text,
        elementTags: scene?.continuity?.elementTags,
        sceneExtract: scene?.originalScript.extract,
        voiceTokens: ctx.motion?.dialogue?.lines.flatMap((line) =>
          isElementVoiceToken(line.voiceToken) ? [line.voiceToken] : []
        ),
        referenceOnly: rendersReferenceOnly(ctx.shot, sequence),
      }),
  };
}

/** Filter a bounded candidate page. An empty result may still have a continuation. */
export async function listShotReferences(
  scopedDb: ScopedDb,
  input: ReadPageInput & { shotId: string; kind: ReferenceKind }
) {
  const access = productionAccess(scopedDb);
  const sequence = await access.sequence(input.sequenceId);
  const shot = await access.shot(sequence.id, input.shotId);
  const match = matchReferences(
    await loadInspectionShot(scopedDb, sequence.id, shot),
    sequence
  );
  const scope = [sequence.id, input.kind, `shot:${shot.id}`];
  switch (input.kind) {
    case 'character': {
      const page = await readPage(input, scope, (next) =>
        scopedDb.characters.list(sequence.id, next)
      );
      const matched = match.characters(page.items);
      return {
        references: matched.map((row) => ({ id: row.id, name: row.name })),
        examined: page.items.length,
        nextCursor: page.nextCursor,
      };
    }
    case 'location': {
      const page = await readPage(input, scope, (next) =>
        scopedDb.sequenceLocations.list(sequence.id, next)
      );
      const matched = match.locations(page.items);
      return {
        references: matched.map((row) => ({ id: row.id, name: row.name })),
        examined: page.items.length,
        nextCursor: page.nextCursor,
      };
    }
    case 'element': {
      const page = await readPage(input, scope, (next) =>
        scopedDb.sequenceElements.list(sequence.id, next)
      );
      return {
        references: match
          .elements(page.items)
          .map((row) => ({ id: row.id, name: row.token })),
        examined: page.items.length,
        nextCursor: page.nextCursor,
      };
    }
  }
}
export async function listEntityUsages(
  scopedDb: ScopedDb,
  input: ReadPageInput & {
    kind: ReferenceKind;
    entityId: string;
    sceneId?: string;
  }
) {
  const access = productionAccess(scopedDb);
  const sequence = await access.sequence(input.sequenceId);
  const entity =
    input.kind === 'character'
      ? {
          kind: 'character' as const,
          row: await access.character(sequence.id, input.entityId),
        }
      : input.kind === 'location'
        ? {
            kind: 'location' as const,
            row: await access.location(sequence.id, input.entityId),
          }
        : {
            kind: 'element' as const,
            row: await access.element(sequence.id, input.entityId),
          };
  const page = await pageShots(
    scopedDb,
    input,
    `${input.kind}:${input.entityId}`
  );
  const usages: {
    shotId: string;
    sceneId: string | null;
    shotNumber: number | null;
  }[] = [];
  for (const shot of page.items) {
    const match = matchReferences(
      await loadInspectionShot(scopedDb, sequence.id, shot),
      sequence
    );
    const matches =
      entity.kind === 'character'
        ? match.characters([entity.row])
        : entity.kind === 'location'
          ? match.locations([entity.row])
          : match.elements([entity.row]);
    if (matches.length)
      usages.push({
        shotId: shot.id,
        sceneId: shot.sceneId,
        shotNumber: shot.shotNumber,
      });
  }
  return { usages, examined: page.items.length, nextCursor: page.nextCursor };
}
export async function readShotStaleness(
  scopedDb: ScopedDb,
  sequenceId: string,
  shotId: string,
  refs?: ShotStalenessRefs
) {
  const access = productionAccess(scopedDb);
  const sequence = await access.sequence(sequenceId);
  const shot = await access.shot(sequenceId, shotId);
  const ctx = await loadInspectionShot(scopedDb, sequenceId, shot);
  const selected = ctx.frame
    ? await scopedDb.frameVariants.getSelected(ctx.frame.id)
    : null;
  const result = ctx.frame
    ? await computeShotStaleness({
        scopedDb,
        sequence,
        shot,
        frame: ctx.frame,
        selectedImage:
          selected?.sequenceId === sequenceId &&
          selected.frameId === ctx.frame.id
            ? selected
            : null,
        scene: ctx.scene,
        refs,
      })
    : UNTRACKED_STALENESS;
  return {
    shotId,
    frameId: ctx.frame?.id ?? null,
    thumbnail: result.thumbnail,
    visualPrompt: result.visualPrompt,
    motionPrompt: result.motionPrompt,
    causes: result.causes,
  };
}

/** Load sequence reference dependencies once per page, not once per shot. */
export async function listShotStaleness(
  scopedDb: ScopedDb,
  input: ReadPageInput & { sceneId?: string }
) {
  const sequence = await productionAccess(scopedDb).sequence(input.sequenceId);
  const page = await pageShots(scopedDb, input, 'staleness');
  if (!page.items.length) return { shots: [], nextCursor: page.nextCursor };
  const [characters, locations, elements, style] = await Promise.all([
    scopedDb.characters.listWithSheets(sequence.id),
    scopedDb.sequenceLocations.listWithReferences(sequence.id),
    scopedDb.sequenceElements.list(sequence.id),
    scopedDb.styles.getById(sequence.styleId),
  ]);
  const refs = { characters, locations, elements, style };
  const shots = [];
  for (const shot of page.items)
    shots.push(await readShotStaleness(scopedDb, sequence.id, shot.id, refs));
  return { shots, nextCursor: page.nextCursor };
}
