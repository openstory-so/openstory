import type { FreshPlanSequenceOverrides } from '@/shots/server/update-stale-plan';
/**
 * Load the generation plan (#1816) from live D1: the rows, the existing
 * staleness verdicts and the claims, one read per table, compared in memory
 * (the shape of `getShotStalenessBatchFn`, #1795). The graph and cascade are
 * the pure half in `@/sequences/generation-plan`.
 */

import { matchSpeaker, usesVoice } from '@/cast/voice';
import {
  locationSheetStaleness,
  lookSheetStaleness,
} from '@/cast/server/production-staleness';
import { castTalentFields } from '@/cast/server/sheets/character-sheet-trigger';
import { sequenceStyleFromRow } from '@/cast/server/sheets/sequence-style';
import {
  computeStyleConfigHash,
  resolveSceneShotImageReferences,
} from '@/cast/server/workflows/sheet-snapshots';
import { readMusicPromptStaleness } from '@/audio/server/music-staleness';
import type { StyleConfig } from '@/look/style-config';
import { NotFoundError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence } from '@/platform/server/db/schema';
import { resolveStopAt } from '@/sequences/pipeline';
import {
  artifactVerdict,
  planUnits,
  type ArtifactVerdict,
  type PlanShot,
  type PlanUnit,
} from '@/sequences/generation-plan';
import { resolveSceneForShot } from '@/shots/server/scene-script';
import { loadShotMediaStates } from '@/shots/server/shot-media-staleness';
import {
  computeShotStaleness,
  loadShotStalenessBatch,
  loadShotStalenessReads,
  UNTRACKED_STALENESS,
  type ShotStalenessResult,
} from '@/shots/server/shot-staleness';
import { readinessImageStatus } from '@/shots/shot-view';
import { usesStartFrame } from '@/shots/use-start-frame';

const logger = getLogger(['openstory', 'sequences', 'generation-plan']);

/** A sheet's verdict: the compare (`lookSheetStaleness`, `locationSheetStaleness`) only runs on a sheet that exists. */
async function sheetVerdict(
  exists: boolean,
  inFlight: boolean,
  read: () => Promise<{ status: string }>
): Promise<ArtifactVerdict> {
  if (inFlight) return 'running';
  if (!exists) return 'missing';
  try {
    const { status } = await read();
    return artifactVerdict({
      exists,
      staleness: status === 'stale' ? 'stale' : 'fresh',
      inFlight: status === 'generating',
    });
  } catch (error) {
    logger.warn('sheet staleness uncomputable', { err: error });
    return 'unknown';
  }
}

/**
 * `flags` asks "what would the plan be with Start frames / Voices set like
 * this" — the footer's switches and the continue guard, before either saves.
 */
export async function computeGenerationPlan(
  scopedDb: ScopedDb,
  sequenceId: string,
  flags?: Partial<
    Pick<Sequence, 'generateStartFrames' | 'generateVoices' | 'includeMusic'>
  >,
  options?: {
    ignoreOwnProcessing?: boolean;
    sequenceOverrides?: FreshPlanSequenceOverrides;
  }
): Promise<PlanUnit[]> {
  const row = await scopedDb.sequences.getById(sequenceId);
  if (!row) throw new NotFoundError(`Sequence ${sequenceId} not found`);
  const sequence = {
    ...row,
    ...options?.sequenceOverrides,
    generateStartFrames: flags?.generateStartFrames ?? row.generateStartFrames,
    generateVoices: flags?.generateVoices ?? row.generateVoices,
    includeMusic: flags?.includeMusic ?? row.includeMusic,
    status: options?.ignoreOwnProcessing ? ('completed' as const) : row.status,
  };
  const shots = await scopedDb.shots.listBySequence(sequenceId);
  // Script is the root, not a unit: nothing to plan until it made shots.
  if (shots.length === 0) return [];
  const units = planUnits(
    await loadPlanInput(scopedDb, sequence, shots),
    sequenceId
  );
  return units;
}

async function loadPlanInput(
  scopedDb: ScopedDb,
  sequence: Sequence,
  shots: Awaited<ReturnType<ScopedDb['shots']['listBySequence']>>
) {
  // No anchor backfill: a read does not write. A frameless shot's prompt and
  // still read `missing`, which is what a fresh anchor would say too.
  const { anchorsByShot, sceneContext, selectedByFrame, refs } =
    await loadShotStalenessBatch(scopedDb, sequence);
  const frameIds = [...anchorsByShot.values()].map((frame) => frame.id);
  const shotIds = shots.map((shot) => shot.id);

  // The cast and locations are the batch's `refs`: the same read, once (#2082).
  const { characters, locations } = refs;
  const [reads, media, liveDialogue, music, primaryImageByFrame] =
    await Promise.all([
      loadShotStalenessReads(
        scopedDb,
        sequence.id,
        shots,
        shotIds,
        frameIds,
        sceneContext
      ),
      loadShotMediaStates(scopedDb, sequence, shots),
      scopedDb.shotDialogue.listShotIdsWithLiveClaim(shotIds),
      sequence.includeMusic
        ? readMusicPromptStaleness(scopedDb, sequence)
        : Promise.resolve(null),
      scopedDb.frameVariants.getPrimaryByFrameIds(frameIds),
    ]);

  // In parallel, as `getShotStalenessBatchFn` does: the reads are shared,
  // the hashing is per shot. Null = an uncomputable compare.
  const stalenessByShot = new Map(
    await Promise.all(
      shots.map(async (shot): Promise<[string, ShotStalenessResult | null]> => {
        const frame = anchorsByShot.get(shot.id) ?? null;
        try {
          return [
            shot.id,
            await computeShotStaleness({
              scopedDb,
              sequence,
              shot,
              frame,
              selectedImage: frame
                ? (selectedByFrame.get(frame.id) ?? null)
                : null,
              scene: resolveSceneForShot(shot, sceneContext).scene,
              refs,
              reads,
              dialogue: reads.dialogueOf(shot),
            }),
          ];
        } catch (error) {
          logger.warn(`shot ${shot.id} staleness uncomputable`, {
            err: error,
          });
          return [shot.id, null];
        }
      })
    )
  );

  const planShots: PlanShot[] = [];
  const speakers = new Set<string>();
  for (const shot of shots) {
    const frame = anchorsByShot.get(shot.id);
    const { scene } = resolveSceneForShot(shot, sceneContext);
    const selectedImage = frame
      ? (selectedByFrame.get(frame.id) ?? null)
      : null;
    const selectedPrompt = frame
      ? (reads.selectedPromptByFrame.get(frame.id) ?? null)
      : null;
    const imageStatus = readinessImageStatus({
      selectedImageUrl: selectedImage?.url ?? null,
      primaryImageStatus: frame
        ? (primaryImageByFrame.get(frame.id)?.status ?? null)
        : null,
    });
    const dialogue = reads.dialogueOf(shot);
    const computed = stalenessByShot.get(shot.id) ?? null;
    const unknown = computed === null;
    const staleness = computed ?? UNTRACKED_STALENESS;
    const verdictOf = (v: ArtifactVerdict) => (unknown ? 'unknown' : v);

    const matched = resolveSceneShotImageReferences({
      scene,
      visualPrompt: selectedPrompt?.text ?? null,
      characters,
      locations,
      elements: refs.elements,
    });

    const speakerIds = new Set<string>();
    if (dialogue.dialogue.presence) {
      for (const line of dialogue.dialogue.lines) {
        if (line.voiceToken || !line.line.trim()) continue;
        const character = matchSpeaker(line.character, characters);
        if (character && usesVoice(character, sequence)) {
          speakerIds.add(character.id);
          speakers.add(character.id);
        }
      }
    }

    const shotMedia = media.get(shot.id)?.staleness;
    const hasAudio = (shot.audioClips?.length ?? 0) > 0;
    planShots.push({
      id: shot.id,
      usesStartFrame: usesStartFrame(shot, sequence),
      references: {
        lookIds: matched.characters.map((c) => c.lookId),
        locationIds: matched.locations.map((l) => l.id),
        elementIds: matched.elements.map((e) => e.id),
      },
      speakerIds: [...speakerIds],
      visualPrompt: verdictOf(
        artifactVerdict({
          exists: selectedPrompt != null,
          staleness: staleness.visualPrompt,
          inFlight:
            !selectedPrompt &&
            (reads.liveVisualClaimsByFrame.get(frame?.id ?? '')?.length ?? 0) >
              0,
        })
      ),
      still: verdictOf(
        artifactVerdict({
          exists: !!selectedImage?.url,
          staleness: staleness.thumbnail,
          inFlight:
            !selectedImage?.url &&
            (frame?.pendingPromoteVersionId != null ||
              imageStatus === 'generating' ||
              (reads.liveImageClaimsByFrame.get(frame?.id ?? '')?.length ?? 0) >
                0),
        })
      ),
      spec: verdictOf(
        staleness.spec === 'untracked'
          ? 'missing'
          : artifactVerdict({
              exists: true,
              staleness: staleness.spec,
              inFlight: shot.pendingSpecVersionId != null,
            })
      ),
      visualWritten: selectedPrompt?.source === 'user-edit',
      motionWritten:
        reads.selectedMotionByShot.get(shot.id)?.source === 'user-edit',
      motionPrompt: verdictOf(
        artifactVerdict({
          exists: reads.selectedMotionByShot.has(shot.id),
          staleness: staleness.motionPrompt,
          inFlight:
            !reads.selectedMotionByShot.has(shot.id) &&
            (reads.liveMotionClaimsByShot.get(shot.id)?.length ?? 0) > 0,
        })
      ),
      dialogue:
        speakerIds.size > 0 || hasAudio
          ? artifactVerdict({
              exists: hasAudio,
              staleness: shotMedia?.dialogue,
              inFlight: liveDialogue.has(shot.id),
            })
          : null,
      clip: artifactVerdict({
        exists:
          shotMedia?.video !== undefined && shotMedia.video !== 'untracked',
        staleness: shotMedia?.video,
        inFlight: media.get(shot.id)?.clipInFlight,
      }),
    });
  }

  // Every sheet's verdict from rows read once per sequence (#2082): the
  // cast talent, the live sheet versions, the location photos and the style.
  // The compare is the detail page's (`lookSheetStaleness`,
  // `locationSheetStaleness`), which reads nothing — except a character
  // with no default look row yet, where `requireCharacterLook` backfills
  // it (one read and one write per such character).
  // One sheet per look some scene uses (#2015): a character's default look
  // always, any other only once a live scene picks it. A look nobody wears
  // gets a sheet when someone asks for one, not from the plan.
  const pickedLookIds = new Set(
    [...sceneContext.values()].flatMap((ctx) =>
      Object.values(ctx.scene.continuity?.characterLooks ?? {})
    )
  );
  // Each entry's `look` is its row; null is a default look a character an
  // older worker wrote has no row for yet. The character itself wears that
  // look, so its fields stand in, and the row is made only when the sheet
  // exists to compare.
  const wornLooks = characters
    .filter((c) => !c.voiceOnly)
    .flatMap((owner) => [
      { owner, look: owner.looks.find((look) => look.isDefault) ?? null },
      ...owner.looks
        // A removed look a scene still picks is still worn, so it still
        // owes its sheet: the shots that wear it wait on this unit.
        .filter((look) => !look.isDefault && pickedLookIds.has(look.id))
        .map((look) => ({ owner, look })),
    ]);
  const unique = (ids: (string | null)[]) => [
    ...new Set(ids.filter((id): id is string => id !== null)),
  ];
  const [talents, sheetVersions, locationVersions, photos] = await Promise.all([
    scopedDb.talent.getWithSheetsByIds(
      unique(wornLooks.map(({ owner }) => owner.talentId))
    ),
    scopedDb.characterSheetVariants.getByIds(
      unique(
        wornLooks.map(
          ({ owner, look }) => (look ?? owner).selectedSheetVersionId
        )
      )
    ),
    scopedDb.locationSheetVariants.getByIds(
      unique(locations.map((l) => l.selectedReferenceVersionId))
    ),
    scopedDb.locations.listPhotosByLocationIds(locations.map((l) => l.id)),
  ]);
  const talentById = new Map(talents.map((t) => [t.id, t]));
  const sheetVersionById = new Map(sheetVersions.map((v) => [v.id, v]));
  const locationVersionById = new Map(locationVersions.map((v) => [v.id, v]));
  // Parsed once, inside the first verdict's read: a snapshot that fails to
  // parse makes every sheet `unknown` through `sheetVerdict`'s catch, as a
  // per-row read did, instead of failing the plan.
  let style: Promise<{ config: StyleConfig | null; hash: string }> | undefined;
  const sequenceStyle = () =>
    (style ??= (async () => {
      const config = sequenceStyleFromRow(sequence, refs.style) ?? null;
      return { config, hash: await computeStyleConfigHash(config) };
    })());
  const [characterSheets, locationSheets] = await Promise.all([
    Promise.all(
      wornLooks.map(async ({ owner, look }) => {
        const worn = look ?? owner;
        return {
          id: look ? look.id : owner.lookId,
          // A look other than the default is drawn from this character's
          // default sheet (the look whose id is the character's).
          characterId: owner.id,
          sheet: await sheetVerdict(
            !!worn.sheetImageUrl,
            worn.sheetStatus === 'generating' ||
              worn.pendingPromoteSheetVersionId != null,
            async () =>
              lookSheetStaleness({
                scopedDb,
                sequence,
                owner,
                lookId: look ? look.id : owner.lookId,
                styleConfigHash: (await sequenceStyle()).hash,
                rows: {
                  cast: castTalentFields(
                    owner.talentId ? talentById.get(owner.talentId) : undefined
                  ),
                  liveVersion: worn.selectedSheetVersionId
                    ? (sheetVersionById.get(worn.selectedSheetVersionId) ??
                      null)
                    : null,
                },
              })
          ),
        };
      })
    ),
    Promise.all(
      locations.map(async (l) => ({
        id: l.id,
        sheet: await sheetVerdict(
          !!l.referenceImageUrl,
          l.referenceStatus === 'generating' ||
            l.pendingPromoteReferenceVersionId != null,
          async () =>
            locationSheetStaleness({
              scopedDb,
              sequence,
              location: l,
              styleConfig: (await sequenceStyle()).config,
              rows: {
                liveVersion: l.selectedReferenceVersionId
                  ? (locationVersionById.get(l.selectedReferenceVersionId) ??
                    null)
                  : null,
                photos: photos.filter((p) => p.locationId === l.id),
              },
            })
        ),
      }))
    ),
  ]);

  return {
    processing: sequence.status === 'processing',
    runStopAt: resolveStopAt({
      generationStopAt: sequence.generationStopAt,
    }),
    characterSheets,
    locationSheets,
    // Element references have no staleness or status of their own: an image
    // is the whole story.
    elementRefs: refs.elements.map((e) => ({
      id: e.id,
      ref: artifactVerdict({ exists: !!e.imageUrl }),
    })),
    voices: characters
      .filter((c) => speakers.has(c.id))
      .map((c) => ({
        id: c.id,
        voice: artifactVerdict({
          exists: !!c.voiceId,
          inFlight: !c.voiceId && c.pendingPromoteVoiceVersionId != null,
        }),
      })),
    shots: planShots,
    // The Music switch (`includeMusic`): off, the sequence owes no music.
    music: music && {
      prompt: artifactVerdict({
        exists: !!sequence.musicPrompt,
        staleness: music.musicPrompt,
      }),
      track: artifactVerdict({
        exists: !!sequence.musicUrl,
        staleness: music.musicTrack,
        inFlight: sequence.musicStatus === 'generating',
      }),
    },
  };
}
