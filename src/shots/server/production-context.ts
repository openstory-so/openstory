import type { ScopedDb } from '@/platform/server/db/scoped';
import { pageRows, readPage } from '@/platform/server/read-page';
import type { PageInput } from '@/platform/server/read-page';
import { productionAccess } from '@/sequences/server/production-access';
import type { Frame, Shot } from '@/platform/server/db/schema';
import { loadSceneFacets } from './scene-facets';
import { resolveSceneForShot } from './scene-script';
import {
  computeShotStaleness,
  loadShotStalenessBatch,
  UNTRACKED_STALENESS,
} from './shot-staleness';
import { z } from 'zod';

type ReadPageInput = PageInput & { sequenceId: string };

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
async function loadInspectionShot(
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
const facetIds = (
  facets: Awaited<ReturnType<typeof loadSceneFacets>>,
  kind: ReferenceKind
) =>
  ({
    character: facets.characterIdsByShot,
    location: facets.locationIdsByShot,
    element: facets.elementIdsByShot,
  })[kind];

/** What a shot uses, answered from the inspector's own facet resolution. */
export async function listShotReferences(
  scopedDb: ScopedDb,
  input: ReadPageInput & { shotId: string; kind: ReferenceKind }
) {
  const access = productionAccess(scopedDb);
  const sequence = await access.sequence(input.sequenceId);
  const shot = await access.shot(sequence.id, input.shotId);
  const facets = await loadSceneFacets(scopedDb, sequence);
  const used = new Set(facetIds(facets, input.kind)[shot.id]);
  const rows =
    input.kind === 'element'
      ? facets.elements.map((row) => ({ id: row.id, name: row.token }))
      : (input.kind === 'character' ? facets.characters : facets.locations).map(
          (row) => ({ id: row.id, name: row.name })
        );
  const page = await readPage(
    input,
    [sequence.id, input.kind, `shot:${shot.id}`],
    pageRows(rows.filter((row) => used.has(row.id)))
  );
  return { references: page.items, nextCursor: page.nextCursor };
}

/** The shots using one entity — the same facet resolution, read the other way. */
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
  await access[input.kind](sequence.id, input.entityId);
  const scene = input.sceneId
    ? await access.scene(sequence.id, input.sceneId)
    : null;
  const facets = await loadSceneFacets(scopedDb, sequence);
  const ids = facetIds(facets, input.kind);
  const page = await readPage(
    input,
    [
      sequence.id,
      'usages',
      input.sceneId ?? '',
      `${input.kind}:${input.entityId}`,
    ],
    pageRows(
      facets.shots.filter(
        (shot) =>
          (!scene || shot.sceneId === scene.id) &&
          ids[shot.id]?.includes(input.entityId)
      )
    )
  );
  return {
    usages: page.items.map((shot) => ({
      shotId: shot.id,
      sceneId: shot.sceneId,
      shotNumber: shot.shotNumber,
    })),
    nextCursor: page.nextCursor,
  };
}

type StalenessInputs = Pick<
  Parameters<typeof computeShotStaleness>[0],
  'sequence' | 'shot' | 'selectedImage' | 'scene' | 'refs'
> & { frame: Frame | null };

/** A shot with no anchor frame has no image surface to compare: untracked. */
async function shotStaleness(scopedDb: ScopedDb, inputs: StalenessInputs) {
  const { frame, ...rest } = inputs;
  const result = frame
    ? await computeShotStaleness({ scopedDb, frame, ...rest })
    : UNTRACKED_STALENESS;
  return {
    shotId: inputs.shot.id,
    frameId: frame?.id ?? null,
    thumbnail: result.thumbnail,
    visualPrompt: result.visualPrompt,
    motionPrompt: result.motionPrompt,
    causes: result.causes,
  };
}

export async function readShotStaleness(
  scopedDb: ScopedDb,
  sequenceId: string,
  shotId: string
) {
  const access = productionAccess(scopedDb);
  const sequence = await access.sequence(sequenceId);
  const shot = await access.shot(sequenceId, shotId);
  const ctx = await loadInspectionShot(scopedDb, sequenceId, shot);
  const selected = ctx.frame
    ? await scopedDb.frameVariants.getSelected(ctx.frame.id)
    : null;
  return shotStaleness(scopedDb, {
    sequence,
    shot,
    frame: ctx.frame,
    selectedImage:
      selected?.sequenceId === sequenceId && selected.frameId === ctx.frame?.id
        ? selected
        : null,
    scene: ctx.scene,
  });
}

/**
 * The editor's batched staleness read (`getShotStalenessBatchFn`) for one page
 * of shots, without its anchor-frame repair: an MCP read never writes.
 */
export async function listShotStaleness(
  scopedDb: ScopedDb,
  input: ReadPageInput & { sceneId?: string }
) {
  const access = productionAccess(scopedDb);
  const sequence = await access.sequence(input.sequenceId);
  const scene = input.sceneId
    ? await access.scene(sequence.id, input.sceneId)
    : null;
  const page = await readPage(
    input,
    [sequence.id, 'shots', input.sceneId ?? '', 'staleness'],
    (next) =>
      scopedDb.shots.listBySequence(sequence.id, {
        sceneId: scene?.id,
        page: next,
      })
  );
  if (!page.items.length) return { shots: [], nextCursor: page.nextCursor };
  const batch = await loadShotStalenessBatch(scopedDb, sequence);
  const shots = await Promise.all(
    page.items.map((shot) => {
      const frame = batch.anchorsByShot.get(shot.id) ?? null;
      return shotStaleness(scopedDb, {
        sequence,
        shot,
        frame,
        selectedImage: frame
          ? (batch.selectedByFrame.get(frame.id) ?? null)
          : null,
        scene: resolveSceneForShot(shot, batch.sceneContext).scene,
        refs: batch.refs,
      });
    })
  );
  return { shots, nextCursor: page.nextCursor };
}
