/**
 * A recording of a scene's whole conversation becomes its dialogue (#2264),
 * from the app ("Upload recording") and MCP (`set_scene_dialogue_from_upload`).
 *
 * Everything the run would fail on that can be known now is refused here,
 * before credits are reserved: a file that is not a PCM WAV, a line with no
 * voice to key the reading on, a shot recording already.
 */

import { scribeCost } from '@/billing/elevenlabs-pricing';
import {
  releaseReservationOnThrow,
  reserveRunCredits,
} from '@/billing/server/preflight';
import { safeImageToVideoModel } from '@/models/models';
import { isElevenLabsConfigured } from '@/models/server/elevenlabs-config';
import {
  dialogueAudioMaxSeconds,
  dialogueAudioMinSeconds,
} from '@/motion/dialogue-tts';
import {
  parseWavHeader,
  wavFrameMath,
} from '@/motion/server/pad-dialogue-audio';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence } from '@/platform/server/db/schema';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type { DialogueUploadWorkflowInput } from '@/platform/server/workflow/types';
import { readStorageObject, storageObjectSize } from '#storage';
import { loadSceneDialogueJob } from './dialogue-edit';
import { requireUploadedStoragePath } from './media-upload';
import { MAX_DIALOGUE_UPLOAD_BYTES } from '@/motion/server/place-uploaded-dialogue';

const HEADER_PROBE_BYTES = 4096;

export async function uploadSceneDialogue(
  context: {
    scopedDb: ScopedDb;
    sequence: Pick<Sequence, 'id' | 'organizationId' | 'videoModel'>;
    user: { id: string };
  },
  input: { sceneId: string; publicUrl: string }
): Promise<{ workflowRunId: string }> {
  const { scopedDb, sequence, user } = context;
  if (!isElevenLabsConfigured()) {
    throw new ValidationError(
      'Uploading dialogue needs ElevenLabs to transcribe it, which is not set up'
    );
  }
  const storageKey = `${STORAGE_BUCKETS.AUDIO}/${requireUploadedStoragePath(
    input.publicUrl,
    STORAGE_BUCKETS.AUDIO,
    sequence.organizationId
  )}`;
  const [size, probe] = await Promise.all([
    storageObjectSize(storageKey),
    readStorageObject(storageKey, { offset: 0, length: HEADER_PROBE_BYTES }),
  ]);
  if (size == null || !probe) {
    throw new NotFoundError('The uploaded recording was not found');
  }
  if (size > MAX_DIALOGUE_UPLOAD_BYTES) {
    throw new ValidationError(
      `The recording is ${(size / 1024 / 1024).toFixed(0)} MB; the limit is ${MAX_DIALOGUE_UPLOAD_BYTES / 1024 / 1024} MB. Send it as 16-bit mono.`
    );
  }
  const fmt = parseWavHeader(probe.bytes);
  if (!fmt) {
    throw new ValidationError(
      'The recording must be a PCM WAV (MP3 and other formats are not converted on the server yet)'
    );
  }
  const { bytesPerSecond } = wavFrameMath(fmt, fmt.dataSize);
  const seconds = Math.min(fmt.dataSize, size - fmt.dataStart) / bytesPerSecond;

  const anchor = (await scopedDb.shots.listBySequence(sequence.id)).find(
    (shot) => shot.sceneId === input.sceneId && !shot.deletedAt
  );
  if (!anchor) throw new NotFoundError('Scene not found, or it has no shots');
  const { job, shots, dialogueOf } = await loadSceneDialogueJob(
    scopedDb,
    sequence,
    anchor.id,
    () => undefined
  );
  if (!job) throw new ValidationError('This scene has no voiced lines');

  // The reading is keyed on the voiced lines, so every line has to be one:
  // an unvoiced line's words would sit in a neighbour's section.
  const sceneShots = shots
    .filter((shot) => shot.sceneId === input.sceneId && !shot.deletedAt)
    .sort((a, b) => (a.shotNumber ?? 0) - (b.shotNumber ?? 0));
  for (const [at, shot] of sceneShots.entries()) {
    for (const [index, line] of dialogueOf(shot).lines.entries()) {
      if (!line.line.trim()) continue;
      const voiced = job.voiced.some(
        (turn) => turn.shotId === shot.id && turn.index === index
      );
      if (!voiced) {
        const who = line.character.trim() || 'An unattributed speaker';
        throw new ValidationError(
          `Shot ${at + 1}: ${who}'s line "${line.line.trim().slice(0, 80)}" has no generated voice to match the recording to. Give the speaker a voice, or set the shot's audio to Generated.`
        );
      }
    }
  }

  const claims = await scopedDb.shotDialogue.listLiveClaimsBySequence(
    sequence.id
  );
  if (claims.some((claim) => sceneShots.some((s) => s.id === claim.shotId))) {
    throw new ConflictError(
      "This scene's dialogue is being recorded. Upload the recording when it lands."
    );
  }

  const model = safeImageToVideoModel(sequence.videoModel);
  const reservationId = await reserveRunCredits(scopedDb, scribeCost(seconds), {
    errorMessage: 'Insufficient credits to transcribe this recording',
    sequenceId: sequence.id,
  });
  return releaseReservationOnThrow(scopedDb, reservationId, async () => {
    const payload: DialogueUploadWorkflowInput = {
      userId: user.id,
      organizationId: sequence.organizationId,
      sequenceId: sequence.id,
      reservationId,
      ownsReservation: true,
      storageKey,
      voiced: job.voiced,
      dialogueVersionIdByShotId: job.dialogueVersionIdByShotId,
      sceneShotNumberByShotId: Object.fromEntries(
        sceneShots.map((shot, at) => [shot.id, at + 1])
      ),
      minDurationSeconds: dialogueAudioMinSeconds([model]),
      maxDurationSeconds: dialogueAudioMaxSeconds([model]),
    };
    return {
      workflowRunId: await triggerWorkflow('/dialogue-upload', payload),
    };
  });
}
