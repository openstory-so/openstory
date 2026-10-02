/**
 * Shot dialogue readings (#1657): the time ranges of speeches that spoke a
 * shot's lines.
 *
 * Picking a reading cuts its file and puts that clip on the shot — the clip
 * is the working set, so moving the pointer alone would leave the shot
 * playing a different reading than the one marked current.
 */

import { estimateDialogueTakeCost } from '@/billing/elevenlabs-pricing';
import { voiceProviderOf } from '@/cast/seed-voice';
import { isElevenLabsConfigured } from '@/models/server/elevenlabs-config';
import { isSeedVoiceConfigured } from '@/models/server/seed-speech-config';
import {
  AUDIO_MIN_PAD_SLACK_SECONDS,
  isSilentWav,
  pcmToWav,
  wavDurationSeconds,
} from '@/motion/server/pad-dialogue-audio';
import { base64ToBytes } from '@/platform/base64';
import { generateId } from '@/platform/id';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { uploadFile } from '#storage';
import {
  releaseReservationOnThrow,
  reserveRunCredits,
} from '@/billing/server/preflight';
import {
  dialogueAudioMaxSeconds,
  dialogueAudioMinSeconds,
  dialogueFitBudget,
} from '@/motion/dialogue-tts';
import { safeImageToVideoModel } from '@/models/models';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type { DialogueTakeWorkflowInput } from '@/platform/server/workflow/types';
import { storedMotionDialogueSchema } from '@/shots/scene-analysis.schema';
import { shotAccessMiddleware } from '@/shots/shot-access.fn';
import {
  cancelShotDialogueClaim,
  listShotDialogueClaims,
  regenerateShotDialogue,
  currentSourceKeys,
  discardShotDialogueSection,
  listShotDialogueReadings,
  selectShotDialogueSection,
  selectShotDialogueVersion,
} from '@/shots/server/dialogue-edit';
import { sequenceAccessMiddleware } from '@/platform/middleware.fn';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

const shotInput = z.object({ sequenceId: ulidSchema, shotId: ulidSchema });

/**
 * The key a reading must carry to speak this shot's lines as they stand.
 * What the shot says now, by the one resolver every reader uses. Empty when
 * nothing is voiced — no reading matches that.
 */
/** This shot's readings, newest first; discarded ones omitted. */
export const listShotDialogueSectionsFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotInput))
  .handler(async ({ context }) => listShotDialogueReadings(context));

/**
 * Make a reading the shot's current one and put its cut file on the shot —
 * pointer and clip in one batch (`selectSection`). The cut comes first: it is
 * a deterministic cache write, so a failure there changes nothing. The event
 * comes last and is logged, not thrown: both writes already landed.
 */
export const selectShotDialogueSectionFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotInput.extend({ sectionId: ulidSchema })))
  .handler(async ({ context, data }) =>
    selectShotDialogueSection(context, data.sectionId)
  );

/** Every authored version of this shot's lines, newest first. */
export const listShotDialogueVersionsFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotInput))
  .handler(
    async ({ context }) =>
      await context.scopedDb.shotDialogue.listVersions(context.shot.id)
  );

/**
 * Edit what this shot says (#1773): character, words, tone. Appends a
 * `user-edit` version of THIS shot's lines and nothing else — no prompt row,
 * no other shot. `write` hands back the selected row when nothing moved.
 */
export const saveShotDialogueFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(
    zodValidator(
      shotInput.extend({ lines: storedMotionDialogueSchema.shape.lines })
    )
  )
  .handler(async ({ context, data }) => {
    const version = await context.scopedDb.shotDialogue.write(
      context.shot.id,
      data.lines,
      'user-edit',
      { createdBy: context.user.id }
    );
    return { versionId: version?.id ?? null };
  });

/**
 * Point the shot back at an earlier set of lines. The pointer is the whole
 * change (#1657): every reader resolves what a shot says from the selected
 * version. The shot's current reading stops matching, so the next render
 * records; a reading of the restored wording can be picked again with Use.
 */
export const selectShotDialogueVersionFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotInput.extend({ versionId: ulidSchema })))
  .handler(async ({ context, data }) =>
    selectShotDialogueVersion(context, data.versionId)
  );

/**
 * "Regenerate dialogue": another reading of this shot's lines, on demand. The same
 * per-scene recorder every batch uses — the whole conversation is spoken so
 * the turn is acted in context — with this shot forced to adopt even though
 * its clip still matches. It lands through a claim like any other speech,
 * so the panel shows "Generating…" with Cancel. `scope: 'scene'` forces every
 * voiced shot of the shot's scene to adopt, so the scene is one take again.
 */
export const regenerateShotDialogueFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(
    zodValidator(shotInput.extend({ scope: z.enum(['shot', 'scene']) }))
  )
  .handler(({ context, data }) => regenerateShotDialogue(context, data.scope));

/**
 * The files of these speeches (#1802): a scene recorded as one take plays
 * its speech whole, not shot by shot.
 */
export const getDialogueSpeechUrlsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        speechIds: z.array(ulidSchema).max(200),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const speeches = await context.scopedDb.shotDialogue.listSpeeches(
      data.speechIds
    );
    return Object.fromEntries(
      [...speeches].map(([id, speech]) => [id, speech.url])
    );
  });

/** A mic take's limits: Seed takes a reference up to 30 s, and 10 MB. */
const TAKE_MAX_SECONDS = 30;
const TAKE_MIN_SECONDS = 0.3;
const TAKE_MAX_BASE64_CHARS = Math.ceil((10 * 1024 * 1024 * 4) / 3);

/**
 * Record one line at the mic (#1802): the take becomes the speaker's voice
 * with the user's delivery, spliced into the shot's current reading. Lands
 * through a claim like every speech, as a `mic` reading.
 *
 * The take arrives as the browser's 16-bit mono PCM; it is wrapped as a WAV
 * and parked in R2 here so the run carries only its key. Everything that
 * would fail the run — a silent take, a live claim, a take too long to fit —
 * is refused here, before any credit is reserved.
 */
export const recordShotDialogueLineFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(
    zodValidator(
      shotInput.extend({
        lineIndex: z.number().int().min(0),
        /** 16-bit LE mono PCM, as the browser captured it. */
        pcmBase64: z.string().min(1).max(TAKE_MAX_BASE64_CHARS),
        sampleRate: z.number().int().min(8000).max(48_000),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { scopedDb, shot, sequence, user } = context;
    if (!isElevenLabsConfigured()) {
      throw new Error('Recording a line needs ElevenLabs, which is not set up');
    }
    const take = pcmToWav(base64ToBytes(data.pcmBase64), data.sampleRate);
    const takeSeconds = wavDurationSeconds(take) ?? 0;
    if (takeSeconds < TAKE_MIN_SECONDS || takeSeconds > TAKE_MAX_SECONDS) {
      throw new Error(
        `A take runs ${TAKE_MIN_SECONDS}–${TAKE_MAX_SECONDS}s; this one is ${takeSeconds.toFixed(1)}s`
      );
    }
    if (isSilentWav(take)) {
      throw new Error('No sound was heard in the take — check the microphone');
    }

    const [{ key: sourceKey, voiced }, version, sections, liveClaims] =
      await Promise.all([
        currentSourceKeys(scopedDb, shot.id, sequence.id),
        scopedDb.shotDialogue.getSelected(shot.id),
        scopedDb.shotDialogue.listSections(shot.id),
        scopedDb.shotDialogue.listLiveClaims(shot.id),
      ]);
    // The take's claim would collide with the running one and be dropped.
    if (liveClaims.length > 0) {
      throw new Error(
        "This shot's dialogue is being recorded — try the take again when it lands"
      );
    }
    const line = voiced.find((row) => row.index === data.lineIndex);
    if (!line) {
      throw new Error('This line has no voice to record it in');
    }
    const provider = voiceProviderOf(line.voiceId);
    if (provider === 'seed' && !isSeedVoiceConfigured()) {
      throw new Error('Recording a line in a Seed voice needs Seed Speech');
    }

    // The line goes into the reading the shot plays now — only while that
    // reading still speaks the shot's lines as they stand.
    const current = sections.find(
      (section) => section.selectedAt != null && section.sourceKey === sourceKey
    );
    const speech = current
      ? (await scopedDb.shotDialogue.getSectionById(current.id))?.speech
      : undefined;
    let base: DialogueTakeWorkflowInput['base'] = null;
    if (current && speech) {
      const turns = speech.turns.filter((turn) => turn.shotId === shot.id);
      const lineTurn = turns.find((turn) => turn.index === line.index);
      if (!lineTurn) {
        throw new Error('The current reading does not hold this line');
      }
      base = {
        storageKey: speech.storageKey,
        fromSeconds: current.fromSeconds,
        toSeconds: current.toSeconds,
        lineStartSeconds: lineTurn.startSeconds,
        lineEndSeconds: lineTurn.endSeconds,
        turns,
        spokenLines: current.spokenLines,
      };
    } else if (voiced.length > 1) {
      throw new Error(
        'Generate dialogue for this shot first — a line is recorded into its current reading'
      );
    }

    const model = safeImageToVideoModel(sequence.videoModel);
    // The run checks the converted file; the raw take is close to it (Voice
    // Changer keeps its timing), so a take that cannot fit is refused now.
    const minDurationSeconds = dialogueAudioMinSeconds([model]);
    const maxDurationSeconds = dialogueAudioMaxSeconds([model]);
    const keptSeconds = base
      ? base.toSeconds -
        base.fromSeconds -
        (base.lineEndSeconds - base.lineStartSeconds)
      : 0;
    const fileSeconds = Math.max(
      keptSeconds + takeSeconds,
      minDurationSeconds + AUDIO_MIN_PAD_SLACK_SECONDS
    );
    const { limitSeconds } = dialogueFitBudget({
      maxSeconds: maxDurationSeconds,
    });
    if (fileSeconds > limitSeconds) {
      throw new Error(
        `With this take the shot's dialogue runs ${fileSeconds.toFixed(1)}s and has to fit ${limitSeconds.toFixed(1)}s. Record it a little faster, or pick a video model that takes longer audio.`
      );
    }
    const reservationId = await reserveRunCredits(
      scopedDb,
      estimateDialogueTakeCost(takeSeconds, provider),
      {
        errorMessage: 'Insufficient credits to record this line',
        sequenceId: sequence.id,
      }
    );
    return releaseReservationOnThrow(scopedDb, reservationId, async () => {
      const uploaded = await uploadFile(
        STORAGE_BUCKETS.AUDIO,
        `${sequence.teamId}/${sequence.id}/dialogue-takes/${generateId()}.wav`,
        take,
        { contentType: 'audio/wav' }
      );
      const input: DialogueTakeWorkflowInput = {
        userId: user.id,
        teamId: sequence.teamId,
        sequenceId: sequence.id,
        shotId: shot.id,
        reservationId,
        ownsReservation: true,
        takeStorageKey: uploaded.fullPath,
        line: {
          index: line.index,
          voiceId: line.voiceId,
          character: line.character,
          text: line.text,
          tone: line.tone,
        },
        sourceKey,
        dialogueVersionId: version?.id ?? null,
        base,
        minDurationSeconds,
        maxDurationSeconds,
      };
      return {
        workflowRunId: await triggerWorkflow('/dialogue-take', input),
      };
    });
  });

/** Discard a reading. Discarding the current one leaves the shot with no clip. */
export const discardShotDialogueSectionFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotInput.extend({ sectionId: ulidSchema })))
  .handler(async ({ context, data }) =>
    discardShotDialogueSection(context, data.sectionId)
  );

/** This shot's dialogue speeches in flight (#1657) — the "Generating…" rows. */
export const listShotDialogueClaimsFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotInput))
  .handler(({ context }) => listShotDialogueClaims(context));

/**
 * Stop a speech in flight from becoming this shot's audio. The run is not
 * terminated — it records the scene for other shots too — and its reading for
 * this shot lands in the list, unselected.
 */
export const cancelShotDialogueClaimFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotInput.extend({ claimId: ulidSchema })))
  .handler(({ context, data }) =>
    cancelShotDialogueClaim(context, data.claimId)
  );
