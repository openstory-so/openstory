/**
 * Load the generation plan (#1816) from live D1: the rows, the existing
 * staleness verdicts and the claims, one read per table, compared in memory
 * (the shape of `getShotStalenessBatchFn`, #1795). The graph and cascade are
 * the pure half in `@/sequences/generation-plan`.
 */

import { matchSpeaker, usesVoice } from '@/cast/voice';
import { readReferenceStaleness } from '@/cast/server/production-staleness';
import { resolveSceneShotImageReferences } from '@/cast/server/workflows/sheet-snapshots';
import { readMusicPromptStaleness } from '@/audio/server/music-staleness';
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
import { usesStartFrame } from '@/shots/use-start-frame';

const logger = getLogger(['openstory', 'sequences', 'generation-plan']);

/** A sheet's verdict: `readReferenceStaleness` only runs on a sheet that exists. */
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
  flags?: Partial<Pick<Sequence, 'generateStartFrames' | 'generateVoices'>>
): Promise<PlanUnit[]> {
  const row = await scopedDb.sequences.getById(sequenceId);
  if (!row) throw new NotFoundError(`Sequence ${sequenceId} not found`);
  const sequence = {
    ...row,
    generateStartFrames: flags?.generateStartFrames ?? row.generateStartFrames,
    generateVoices: flags?.generateVoices ?? row.generateVoices,
  };
  const shots = await scopedDb.shots.listBySequence(sequenceId);
  // Script is the root, not a unit: nothing to plan until it made shots.
  if (shots.length === 0) return [];
  return planUnits(await loadPlanInput(scopedDb, sequence, shots), sequenceId);
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

  const [characters, locations, reads, media, liveDialogue, music] =
    await Promise.all([
      scopedDb.characters.list(sequence.id),
      scopedDb.sequenceLocations.list(sequence.id),
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
        characterIds: matched.characters.map((c) => c.id),
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
              frame?.imageStatus === 'generating' ||
              (reads.liveImageClaimsByFrame.get(frame?.id ?? '')?.length ?? 0) >
                0),
        })
      ),
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

  // ponytail: one staleness read per existing sheet (the detail-page verdict,
  // verbatim); a batched sheet-hash read if casts grow past a handful.
  const [characterSheets, locationSheets] = await Promise.all([
    Promise.all(
      characters
        .filter((c) => !c.voiceOnly)
        .map(async (c) => ({
          id: c.id,
          sheet: await sheetVerdict(
            !!c.sheetImageUrl,
            c.sheetStatus === 'generating' ||
              c.pendingPromoteSheetVersionId != null,
            () =>
              readReferenceStaleness(scopedDb, sequence.id, 'character', c.id)
          ),
        }))
    ),
    Promise.all(
      locations.map(async (l) => ({
        id: l.id,
        sheet: await sheetVerdict(
          !!l.referenceImageUrl,
          l.referenceStatus === 'generating' ||
            l.pendingPromoteReferenceVersionId != null,
          () => readReferenceStaleness(scopedDb, sequence.id, 'location', l.id)
        ),
      }))
    ),
  ]);

  return {
    processing: sequence.status === 'processing',
    runStopAt: resolveStopAt({
      generationStopAt: sequence.generationStopAt,
      autoGenerateMotion: sequence.autoGenerateMotion,
      autoGenerateMusic: sequence.autoGenerateMusic,
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
