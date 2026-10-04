/**
 * "Update all" (#1077/#1085) — durable server-side regeneration of the
 * out-of-date artifacts in scope (a shot, a scene, or the whole sequence),
 * at a user-chosen cascade depth (src/shots/update-stale-depth.ts):
 *
 *   'prompts'  → stale visual/motion prompts only, nothing renders
 *   'images'   → + stale stills, and stills whose visual prompt regenerates
 *                in this run (cascade); never a FIRST still
 *   'dialogue' → + existing dialogue readings whose voice or lines moved;
 *                never a FIRST recording. Video is left for the next tick.
 *   'video'    → + existing videos whose upstream changed in this run or
 *                whose manifest already diverged; never a FIRST video
 *   'music'    → + the sequence music prompt, and the existing track behind
 *                a successful prompt regen; never a FIRST generation
 *
 * Per shot the dependency order is visual-prompt → image → video, with the
 * motion prompt alongside (video waits on it too). Chained stages never run
 * from an upstream the run failed to replace.
 *
 * Concurrency model — no locks, self-correcting via input hashes + pending
 * claims (#1085):
 *
 *   - The PLAN (which shots, which artifacts, what gets billed) is computed by
 *     `updateStaleShotsFn` and arrives on the payload: frozen at the click,
 *     immutable, identical across replays. Edits made after it can't add or
 *     remove targets — they simply produce new staleness that the indicators
 *     surface after the run. The plan holds ids, flags and prompt text; scene
 *     bodies stay in `load-scene-context`, with its own 1 MiB budget; render
 *     references and compact motion scene headers are frozen in the plan. The script
 *     term grows with script length, so folding it into the payload would put
 *     a user-supplied input against the same cap as everything else.
 *   - `claim-targets` pre-creates a pending version row per prompt/image
 *     artifact, so in-flight work reads 'updating' and duplicate enqueues
 *     no-op. (Video/music ride their existing status columns instead.)
 *   - Each prompt child gets its inputs snapshotted in its own
 *     `prepare-prompt-*` step (#991 — leaves never read the DB mid-run) and
 *     stamps the hash of the inputs it actually used, so a mid-run script
 *     edit leaves the new prompt honestly stale again rather than silently
 *     wrong.
 *   - A chained image consumes the prompt its OWN dependency claim produced
 *     (see `spawnImage`), so a post-click edit cannot leak into the run; the
 *     video stage reads the returned claim rows and packs eligible siblings.
 *
 * Failures are per-shot and per-stage: one child failing (including an
 * insufficient-credits preflight) leaves that artifact out of date and
 * visible; siblings proceed, and downstream stages of the failed artifact
 * are skipped, not rendered from stale inputs.
 */

import { withLookSheet } from '@/cast/character-looks';
import { sheetLookId } from '@/cast/server/workflows/sheet-snapshots';
import { generateId } from '@/platform/id';
import {
  DEFAULT_MUSIC_MODEL,
  supportsDraftMode,
  type AudioModel,
  type TextToImageModel,
} from '@/models/models';
import { DRAFT_RESOLUTION } from '@/motion/draft-mode';
import { resolveVideoModel } from '@/models/resolve-asset-models';
import type { Scene } from '@/shots/scene-analysis.schema';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { estimateVideoCost, gateEstimate } from '@/billing/cost-estimation';
import { estimateTtsCost } from '@/billing/elevenlabs-pricing';
import { addMicros } from '@/billing/money';
import {
  matchingDialogueClips,
  modelTakesDialogueAudio,
  ttsCharacterCount,
  voicedDialogueLines,
} from '@/motion/dialogue-tts';
import { requireCredits } from '@/billing/server/preflight';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { isInsufficientCreditsError } from '@/platform/errors';
import { buildMotionReferenceImages } from '@/motion/server/build-motion-references';
import {
  buildMotionRender,
  type MotionRenderShot,
} from '@/motion/server/build-motion-render';
import { packPayloadDurationSeconds } from '@/motion/server/pack-motion-jobs';
import {
  motionPromptFromVersion,
  resolveMotionPromptFromVersion,
} from '@/motion/server/resolve-motion-prompt';
import type {
  FramePromptVersion,
  FrameVariant,
  ShotPromptVersion,
} from '@/platform/server/db/schema';
import { getLogger } from '@/platform/logger';
import { reinforceInstrumentalTags } from '@/audio/server/music-prompt';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
  type SceneContext,
} from '@/shots/server/scene-script';
import {
  prepareShotImageWorkflowInput,
  type ShotImageRefs,
} from '@/shots/server/shot-image-input';
import {
  claimTargets,
  findTargetMissingStartFrameMode,
  type MusicPlan,
  type PlanTarget,
  type ShotClaims,
  type SkippedShot,
} from '@/shots/server/update-stale-plan';
import { bindPendingVoices } from '@/shots/server/pending-voices';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import { shotVariantDedupId } from '@/platform/server/workflow/dedup-ids';
import { spawnAndAwaitChild } from '@/platform/server/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import {
  isEngineAbortError,
  WorkflowValidationError,
} from '@/platform/server/workflow/errors';
import type {
  CharacterSheetWorkflowInput,
  CharacterSheetWorkflowResult,
  CharacterVoiceWorkflowInput,
  CharacterVoiceWorkflowResult,
  ElementSheetWorkflowInput,
  ElementSheetWorkflowResult,
  LocationSheetWorkflowInput,
  LocationSheetWorkflowResult,
  ImageWorkflowInput,
  ShotSpecRewriteWorkflowInput,
  ShotSpecRewriteWorkflowResult,
  ShotVariantWorkflowInput,
  DialogueAudioWorkflowInput,
  DialogueAudioWorkflowResult,
  MotionWorkflowInput,
  MotionWorkflowResult,
  MusicPromptWorkflowInput,
  MusicPromptWorkflowResult,
  MusicWorkflowInput,
  UpdateStaleShotsWorkflowInput,
} from '@/platform/server/workflow/types';
import {
  getGenerationChannel,
  getShotPromptChannel,
} from '@/platform/realtime';
import { completeDerivedPrompts } from '@/shots/server/rebuild-shot-prompts';
import {
  GENERATION_STAGE_META,
  type GenerationStage,
} from '@/sequences/pipeline';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'update-stale-shots']);

const PARENT_BINDING_NAME = 'UPDATE_STALE_SHOTS_WORKFLOW';

type UpdateStage =
  | 'reference'
  | 'voice'
  | 'spec'
  | 'visual-prompt'
  | 'motion-prompt'
  | 'image'
  | 'dialogue'
  | 'video'
  | 'music-prompt'
  | 'music';

/**
 * `shotId` is the sequence id for the sequence-scoped music stages, and the
 * character / location / element id for the references wave.
 */
type UpdateFailure = { shotId: string; stage: UpdateStage; error: string };

export type UpdateStaleShotsResult = {
  totalShots: number;
  visualPrompts: number;
  motionPrompts: number;
  images: number;
  /** Target shots whose dialogue reading the up-front recording updated. */
  dialogues: number;
  videos: number;
  musicPrompts: number;
  musicTracks: number;
  failures: UpdateFailure[];
  /** Shots the plan could not act on — see `SkippedShot`. */
  skipped: SkippedShot[];
};

type ImageChildOutput = { imageUrl?: string; cancelled?: boolean };

/** A prompt target's scenes, materialised per shot in `prepare-prompt-*`. */
type PromptScenes = {
  /** Script-overlaid scene metadata, the prompt children's primary input. */
  scene: Scene;
  /** Raw neighbour metadata for motion continuity. */
};

export class UpdateStaleShotsWorkflow extends OpenStoryWorkflowEntrypoint<UpdateStaleShotsWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<UpdateStaleShotsWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<UpdateStaleShotsResult> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;
    const { userId, teamId, sequenceId, plan: payloadPlan } = input;
    if (!sequenceId) {
      throw new WorkflowValidationError('Sequence ID is required');
    }
    // ============================================================
    // PHASE 1: the plan — which shots, which artifacts, what gets billed —
    // arrives whole from `updateStaleShotsFn` (domain logic lives in
    // `@/shots/server/update-stale-plan`). An immutable payload is the strongest
    // snapshot available: identical across replays, and bound to the state the
    // user clicked on rather than to run-start state minutes later.
    // ============================================================
    if (!payloadPlan || !Array.isArray(payloadPlan.targets)) {
      // Only reachable for an instance queued by a build that predates the
      // move. Failing loudly beats a run that reports "nothing was stale".
      throw new WorkflowValidationError(
        'Update-all plan missing from payload; re-trigger the update'
      );
    }
    const plan = {
      ...payloadPlan,
      dialogueSpeech:
        payloadPlan.dialogueSpeech ?? payloadPlan.dialogueRecording ?? null,
    };
    // Rationale lives with the plan type: `findTargetMissingStartFrameMode`.
    const untyped = findTargetMissingStartFrameMode(plan);
    if (untyped) {
      throw new WorkflowValidationError(
        `Update-all plan predates the per-shot start-frame switch (shot ${untyped.shotId}); re-trigger the update`
      );
    }

    if (
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- queued pre-1888 payloads lack this required snapshot
      !plan.renderRefs ||
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- plans frozen before per-scene prompts
      !plan.scenePrompts ||
      plan.targets.some((target) => !target.motionRender)
    ) {
      throw new WorkflowValidationError(
        'Update-all plan predates frozen motion sources; re-trigger the update'
      );
    }

    const counters = {
      visualPrompts: 0,
      motionPrompts: 0,
      images: 0,
      dialogues: 0,
      videos: 0,
      musicPrompts: 0,
      musicTracks: 0,
    };
    const failures: UpdateFailure[] = [];
    // A continue runs under the storyboard banner (#1818): it moves through
    // the same stops a fresh run does.
    const announce = (stage: GenerationStage) =>
      step.do(`phase-start-${stage}`, async () => {
        await getGenerationChannel(sequenceId).emit('generation.phase:start', {
          phase: GENERATION_STAGE_META[stage].phase,
          phaseName: GENERATION_STAGE_META[stage].name,
        });
      });
    const completePhase = (stage: GenerationStage) =>
      step.do(`phase-complete-${stage}`, async () => {
        await getGenerationChannel(sequenceId).emit(
          'generation.phase:complete',
          { phase: GENERATION_STAGE_META[stage].phase }
        );
      });
    const freshPhases = input.freshRun && input.announcePhases;
    const musicToRun =
      plan.music && (plan.music.regenPrompt || plan.music.regenTrack)
        ? plan.music
        : null;

    const references = plan.references;
    if (
      plan.targets.length === 0 &&
      musicToRun === null &&
      references === null
    ) {
      return {
        totalShots: 0,
        ...counters,
        failures: [],
        skipped: plan.skipped,
      };
    }

    const promptCommon = plan.promptContext;
    if (plan.targets.length > 0 && !promptCommon) {
      // Targets exist but the prompt context failed to load (e.g. style
      // deleted) — nothing downstream can run.
      throw new NonRetryableError(
        'Prompt context unavailable for stale-shot update',
        'WorkflowValidationError'
      );
    }

    // ============================================================
    // PHASE 1b: claim the targets (#1085) — one pending version row per
    // artifact this run will produce. From here on the run is visible as
    // 'updating' and duplicate enqueues (second click / tab / teammate)
    // no-op server-side. (Video/music have no claim rows — their in-flight
    // state lives on video_variants.status / sequences.musicStatus, which
    // the plan already treats as "leave it alone".)
    // ============================================================
    const claimed =
      plan.targets.length > 0
        ? await step.do('claim-targets', () =>
            claimTargets({
              scopedDb: scopedDb.stalenessPlanning,
              targets: plan.targets,
              sequenceId,
              parentInstanceId,
            })
          )
        : { claimsByShot: {}, skipped: [] };
    const allSkipped = [...plan.skipped, ...claimed.skipped];

    // ============================================================
    // PHASE 1c: the run's shared inputs, resolved ONCE. Every shot of a run
    // must be built from the same script revision and the same
    // cast/locations/elements, and a shot's visual prompt must agree with the
    // still that renders from it — per-stage re-reads gave each shot (and each
    // stage of a shot) its own moment in time. These stay in steps rather than
    // riding the payload: the script term scales with script length, which is
    // user input with no ceiling, and a step gets its own 1 MiB budget.
    // ============================================================
    const sequenceSnapshot = plan.sequence;

    const sceneContextRows =
      plan.targets.length > 0
        ? await step.do('load-scene-context', async () => {
            const byScene = await loadSceneContextBySequence(
              scopedDb.stalenessPlanning,
              sequenceId
            );
            return [...byScene].map(([id, ctx]) => ({ sceneId: id, ...ctx }));
          })
        : [];
    const sceneContext = new Map<string, SceneContext>(
      sceneContextRows.map((row) => [
        row.sceneId,
        { scene: row.scene, script: row.script },
      ])
    );

    // ============================================================
    // PHASE 1d (#1818): the references wave — sheets, element references and
    // voices a continue owes, before any shot renders from them. Payloads
    // were built at the click; the claims are taken here, as the bible
    // workflows take theirs. A reference that fails holds the stills and
    // clips made from it (`referenceIds`) and fails nothing else.
    // ============================================================
    const leftoverGrok = new Set(input.leftoverGrokShotIds ?? []);
    const failedReferenceIds = new Set<string>();
    // character id → the voice this run designed, for `bindPendingVoices`.
    const designedVoices: Record<string, string> = {};
    const generatedCharacters = new Map<string, CharacterSheetWorkflowResult>();
    const generatedLocations = new Map<string, LocationSheetWorkflowResult>();
    const generatedElements = new Map<
      string,
      ElementSheetWorkflowResult['elements'][number]
    >();
    if (references) {
      if (input.announcePhases) await announce('references');
      // Sheets and voices have no preflight of their own (per-shot renders
      // do): check the wave's click-time price before spawning any of it.
      await step.do('gate-references', async () => {
        // One aggregate check covers this wave's simultaneous platform spend.
        // A fal BYOK key covers sheets, but never the platform-only voices.
        const ownSheets = await scopedDb.liveRead.apiKeys.hasUsableKey('fal');
        await requireCredits(
          scopedDb.liveRead,
          ownSheets
            ? references.cost.voices
            : addMicros(references.cost.sheets, references.cost.voices),
          {
            providers: [],
            errorMessage: 'Insufficient credits for references and voices',
            reservationId: input.reservationId,
          }
        );
      });
      const failReference = (
        id: string,
        stage: UpdateStage,
        error: unknown
      ) => {
        failedReferenceIds.add(id);
        failures.push(toFailure(id, stage, error));
      };
      await Promise.allSettled([
        ...references.characterSheets.map(async (payload) => {
          // One sheet per look (#2015). A default look's id is its
          // character's, so a plan frozen before looks replays the same
          // step names.
          const id = sheetLookId(payload);
          let sheetVersionId: string;
          try {
            // Conditional (#1863): the payload was built at the click, and an
            // edit since then found no claim to revoke. The claim is taken
            // only while the look, the bible and the cast it was built from
            // still hold; otherwise the run parks its sheet.
            sheetVersionId = await step.do(
              `claim-character-sheet-${id}`,
              async () =>
                (
                  await scopedDb.characterLooks.claimSheet(
                    id,
                    {
                      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a plan frozen before #2015
                      lookVersionId: payload.lookVersionId ?? id,
                      // Passed as frozen: a plan from before #1600 / #2015
                      // has neither, and `claimSheet` skips what is absent.
                      bibleVersionId: payload.bibleVersionId,
                      talentId: payload.talentId,
                    },
                    { markGenerating: true }
                  )
                ).versionId
            );
          } catch (error) {
            failReference(id, 'reference', error);
            return;
          }
          try {
            const generated = await spawnAndAwaitChild<
              CharacterSheetWorkflowInput,
              CharacterSheetWorkflowResult
            >(step, {
              binding: this.env.CHARACTER_SHEET_WORKFLOW,
              parentBindingName: PARENT_BINDING_NAME,
              parentInstanceId,
              childId: `character-sheet:${id}`,
              childPayload: {
                ...payload,
                sheetVersionId,
                reservationId: input.reservationId,
              },
              spawnStepName: `spawn-character-sheet-${id}`,
              awaitStepName: `await-character-sheet-${id}`,
              timeout: '30 minutes',
            });
            generatedCharacters.set(id, {
              ...generated,
              sheetVersionId: generated.sheetVersionId ?? sheetVersionId,
            });
          } catch (error) {
            failReference(id, 'reference', error);
            // A child that never started has no onFailure to clear the
            // claim; the guarded clear is a no-op when one did.
            await step.do(`fail-character-sheet-claim-${id}`, () =>
              scopedDb.characterLooks.failSheetClaim(
                id,
                sheetVersionId,
                error instanceof Error ? error.message : String(error)
              )
            );
          }
        }),
        ...references.locationSheets.map(async (payload) => {
          const id = payload.locationDbId;
          let referenceVersionId: string;
          try {
            referenceVersionId = await step.do(
              `claim-location-sheet-${id}`,
              () =>
                scopedDb.sequenceLocations.claimReference(id, {
                  markGenerating: true,
                })
            );
          } catch (error) {
            failReference(id, 'reference', error);
            return;
          }
          try {
            const generated = await spawnAndAwaitChild<
              LocationSheetWorkflowInput,
              LocationSheetWorkflowResult
            >(step, {
              binding: this.env.LOCATION_SHEET_WORKFLOW,
              parentBindingName: PARENT_BINDING_NAME,
              parentInstanceId,
              childId: `location-sheet:${id}`,
              childPayload: {
                ...payload,
                referenceVersionId,
                reservationId: input.reservationId,
              },
              spawnStepName: `spawn-location-sheet-${id}`,
              awaitStepName: `await-location-sheet-${id}`,
              timeout: '30 minutes',
            });
            generatedLocations.set(id, {
              ...generated,
              sheetVersionId: generated.sheetVersionId ?? referenceVersionId,
            });
          } catch (error) {
            failReference(id, 'reference', error);
            await step.do(`fail-location-sheet-claim-${id}`, () =>
              scopedDb.sequenceLocations.failReferenceClaim(
                id,
                referenceVersionId,
                error instanceof Error ? error.message : String(error)
              )
            );
          }
        }),
        ...(references.elementSheets
          ? [
              (async (payload: ElementSheetWorkflowInput) => {
                try {
                  const generated = await spawnAndAwaitChild<
                    ElementSheetWorkflowInput,
                    ElementSheetWorkflowResult
                  >(step, {
                    binding: this.env.ELEMENT_SHEET_WORKFLOW,
                    parentBindingName: PARENT_BINDING_NAME,
                    parentInstanceId,
                    childId: `element-sheets:${sequenceId}:${parentInstanceId}`,
                    childPayload: {
                      ...payload,
                      reservationId: input.reservationId,
                    },
                    spawnStepName: 'spawn-element-sheets',
                    awaitStepName: 'await-element-sheets',
                  });
                  for (const element of generated.elements)
                    generatedElements.set(element.id, element);
                } catch (error) {
                  // The child fails as a whole when any entry does.
                  for (const entry of payload.entries)
                    failReference(entry.elementId, 'reference', error);
                }
              })(references.elementSheets),
            ]
          : []),
        // Voices (#1780 §4): every speaking character the plan owes one,
        // through the same husk claim the bible workflow takes.
        ...references.voices.map(async (payload) => {
          const id = payload.characterDbId;
          let huskId: string | undefined;
          try {
            const claim = await step.do(`claim-voice-${id}`, () =>
              scopedDb.characters.createPendingVoiceClaim(id, userId)
            );
            huskId = claim.version.id;
            // Someone else's design is in flight: it is making this voice.
            if (!claim.created && claim.version.workflowRunId) return;
            const designed = await spawnAndAwaitChild<
              CharacterVoiceWorkflowInput,
              CharacterVoiceWorkflowResult
            >(step, {
              binding: this.env.CHARACTER_VOICE_WORKFLOW,
              parentBindingName: PARENT_BINDING_NAME,
              parentInstanceId,
              childId: `character-voice:${id}`,
              childPayload: {
                ...payload,
                targetVersionId: claim.version.id,
                reservationId: input.reservationId,
              },
              spawnStepName: `spawn-character-voice-${id}`,
              awaitStepName: `await-character-voice-${id}`,
              timeout: '30 minutes',
            });
            if (designed.voiceId) designedVoices[id] = designed.voiceId;
          } catch (error) {
            failures.push(toFailure(id, 'voice', error));
            const husk = huskId;
            if (husk) {
              await step.do(`fail-voice-claim-${id}`, () =>
                scopedDb.characters.markVoiceClaimTerminal(
                  husk,
                  'failed',
                  error instanceof Error ? error.message : String(error)
                )
              );
            }
          }
        }),
      ]);
    }

    if (freshPhases && references) await completePhase('references');

    // Speakers whose voice this run designed now speak in it; a shot whose
    // voice did not land is held below, never rendered without it.
    const { plan: voicedPlan, unvoicedShotIds } = bindPendingVoices(
      plan,
      designedVoices
    );

    // Frozen click-time rows, overlaid only with this run's child results.
    // A concurrent sheet selection cannot change a render already requested.
    const renderRefs: ShotImageRefs = {
      // Each sheet this run made lands on its look (#2015), so a scene
      // dressed in that look renders from it.
      characters: plan.renderRefs.characters.map((row) =>
        [...generatedCharacters].reduce(
          (character, [lookId, generated]) =>
            // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: rows frozen before #2015 have no looks; their sheet is under the character's id
            (character.looks ?? []).some((look) => look.id === lookId) ||
            // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: as above
            (character.lookId ?? character.id) === lookId
              ? withLookSheet(character, lookId, {
                  sheetImageUrl: generated.sheetImageUrl,
                  selectedSheetVersionId: generated.sheetVersionId ?? null,
                })
              : character,
          row
        )
      ),
      locations: plan.renderRefs.locations.map((row) => {
        const generated = generatedLocations.get(row.id);
        return generated
          ? {
              ...row,
              referenceImageUrl: generated.referenceImageUrl,
              selectedReferenceVersionId: generated.sheetVersionId ?? null,
            }
          : row;
      }),
      elements: plan.renderRefs.elements.map((row) => ({
        ...row,
        ...generatedElements.get(row.id),
      })),
    };

    const spawnImageModel = async (
      target: PlanTarget,
      claims: ShotClaims,
      /**
       * What the frame-prompt child actually left live this run — its own
       * completed claim, or the identical existing row that claim retired
       * into on the unique-index collision path. Null when no prompt child
       * ran (a direct render) or it persisted nothing.
       */
      promptedVisualVersionId: string | null,
      model: TextToImageModel,
      alternate: boolean
    ): Promise<void> => {
      // The prompt source is deterministic (#1085): a chained render consumes
      // the prompt its OWN dependency row produced — never a re-read of
      // whatever is stored at spawn time — so a post-click edit cannot leak
      // into this run (it re-stales the artifact instead). Direct renders
      // (image stale, prompt not) still read current state; their claim hash
      // self-invalidates on edit.
      // JSON round-trip at the step boundary: `ImageWorkflowInput.style` is
      // typed `Json`, which the step's Serializable constraint rejects even
      // though the value is plain JSON (same pattern as await-child.ts).
      const imageInputJson = await step.do(
        `prepare-image-${target.shotId}${alternate ? `-${model}` : ''}`,
        async (): Promise<string | null> => {
          const [shot, frame] = await Promise.all([
            scopedDb.liveRead.shots.getById(target.shotId),
            scopedDb.liveRead.frames.getAnchorByShot(target.shotId),
          ]);
          if (!shot || !frame) {
            throw new NonRetryableError(
              `Shot ${target.shotId} disappeared mid-update`,
              'WorkflowValidationError'
            );
          }
          let visualPrompt: FramePromptVersion | null = null;
          if (target.regenVisual && claims.visualVersionId) {
            const dep =
              await scopedDb.claims.framePromptVersions.getByIdForFrame(
                claims.visualVersionId,
                frame.id
              );
            // The claim, else the row it retired into on the unique-index
            // collision path — named by the child, read back by explicit id.
            // Never the selection pointer: `inputHash` pins the generation
            // INPUTS, not the text, so a pointer matching `visualLiveHash`
            // could be a different prompt entirely, and it can move between
            // this check and the render either way.
            const resolved =
              dep?.status === 'completed'
                ? dep
                : promptedVisualVersionId
                  ? await scopedDb.claims.framePromptVersions.getByIdForFrame(
                      promptedVisualVersionId,
                      frame.id
                    )
                  : null;
            if (resolved?.status === 'completed') {
              visualPrompt = resolved;
            } else {
              // The upstream prompt didn't land for this run: the user
              // cancelled it, or a post-click edit superseded the mirror.
              // Never render from it — but this is a stand-down, not a run
              // failure (#1095 review). Release the image claim and skip.
              if (claims.imageVariantId) {
                await scopedDb.frameVariants.markTerminal(
                  claims.imageVariantId,
                  'cancelled',
                  'Upstream visual prompt was cancelled or superseded by a newer edit'
                );
              }
              return null;
            }
          } else if (target.visualPromptVersionId) {
            // Direct render (image stale, prompt fresh): the version the PLAN
            // pinned, read back by id rather than carried as text on the
            // payload — `frame_prompt_versions` is append-only, so the row is
            // exactly what the plan hashed. Reading the frame's selection
            // pointer instead would be a current-read, and it can move between
            // plan time and here. An empty/absent row falls through to
            // `prepareShotImageWorkflowInput`'s own resolution, matching the
            // old "no prompt captured at plan time" case.
            const pinned =
              await scopedDb.claims.framePromptVersions.getByIdForFrame(
                target.visualPromptVersionId,
                frame.id
              );
            visualPrompt = pinned?.text ? pinned : null;
          }
          const { scene, script } = resolveSceneForShot(shot, sceneContext);
          try {
            const prepared = await prepareShotImageWorkflowInput({
              scopedDb: scopedDb.stalenessPlanning,
              sequence: {
                ...sequenceSnapshot,
                referenceOnly: !target.usesStartFrame,
              },
              shot,
              frame,
              scene,
              scriptExtract:
                script?.extract ?? scene?.originalScript.extract ?? '',
              userId,
              promptOverride: visualPrompt?.text,
              promptVersionOverride: visualPrompt?.id,
              // The claim row advertises this model; render what it promised.
              modelOverride: model,
              reservationId: input.reservationId,
              refs: renderRefs,
            });
            return JSON.stringify({
              ...prepared,
              targetVariantId: alternate
                ? undefined
                : (claims.imageVariantId ?? undefined),
              variantOnly: alternate,
              reservationId: input.reservationId,
            });
          } catch (error) {
            // Running out of credits is terminal, not transient: retrying
            // burns the step's whole budget on a call that cannot succeed and
            // keeps the run "in flight" long past the point the user could be
            // told why nothing is happening.
            if (isInsufficientCreditsError(error)) {
              throw new NonRetryableError(
                error instanceof Error ? error.message : String(error),
                'InsufficientCreditsError'
              );
            }
            throw error;
          }
        }
      );
      if (imageInputJson === null) {
        // Upstream prompt cancelled/superseded — stood down in prepare.
        logger.info(
          `[UpdateStaleShotsWorkflow] image for shot ${target.shotId} stood down (upstream prompt cancelled or superseded)`
        );
        return;
      }
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the step above serialized exactly this type
      const imageInput = JSON.parse(imageInputJson) as ImageWorkflowInput;
      const output = await spawnAndAwaitChild<
        ImageWorkflowInput,
        ImageChildOutput
      >(step, {
        binding: this.env.IMAGE_WORKFLOW,
        parentBindingName: PARENT_BINDING_NAME,
        parentInstanceId,
        childId: `image:${sequenceId}:${target.shotId}${alternate ? `:${model}` : ''}`,
        childPayload: imageInput,
        spawnStepName: `spawn-image-${target.shotId}${alternate ? `-${model}` : ''}`,
        awaitStepName: `await-image-${target.shotId}${alternate ? `-${model}` : ''}`,
      });
      // A user cancel (before or during the render) is a stand-down, not a
      // failure — and definitely not a render to count (#1095 review).
      if (output.cancelled) {
        logger.info(
          `[UpdateStaleShotsWorkflow] image for shot ${target.shotId} was cancelled by the user; not counted`
        );
        return;
      }
      // ImageWorkflow has a success path that renders nothing — it returns an
      // empty `imageUrl` when its anchor frame vanished mid-run. Counting that
      // as a render would report work the user never got.
      if (!output.imageUrl) {
        throw new Error('Image workflow completed without producing an image');
      }
      const thumbnailUrl = output.imageUrl;
      counters.images += 1;
      if (input.freshRun) {
        // Independent enrichment, as in ShotImagesWorkflow: it can outlive
        // this run and bills its own instance rather than the parent envelope.
        await step.do(`trigger-variant-${target.shotId}-${model}`, async () => {
          const enforcement =
            await scopedDb.liveRead.compliance.listEnforcementFor(
              userId,
              teamId
            );
          await triggerWorkflow<ShotVariantWorkflowInput>(
            '/variant-image',
            {
              userId,
              teamId,
              sequenceId,
              shotId: target.shotId,
              frameId: imageInput.frameId,
              thumbnailUrl,
              scenePrompt: imageInput.prompt,
              promptVersionId: imageInput.promptVersionId,
              referenceImages: imageInput.referenceImages,
              aspectRatio: imageInput.aspectRatio,
              model,
              tileHashInput: imageInput.sceneSnapshot ?? null,
            },
            {
              deduplicationId: shotVariantDedupId(
                parentInstanceId,
                target.shotId,
                model
              ),
              enforcement,
            }
          );
        });
      }
    };

    const spawnImage = async (
      target: PlanTarget,
      claims: ShotClaims,
      promptedVisualVersionId: string | null
    ): Promise<void> => {
      const models = [
        ...new Set(
          plan.renderOptions?.imageModels?.length
            ? plan.renderOptions.imageModels
            : [target.imageModel]
        ),
      ];
      const outcomes = await Promise.allSettled(
        models.map((model, index) =>
          spawnImageModel(
            target,
            claims,
            promptedVisualVersionId,
            model,
            index > 0
          )
        )
      );
      for (const [index, result] of outcomes.entries()) {
        if (result.status === 'rejected') {
          if (index === 0) throw result.reason;
          failures.push(toFailure(target.shotId, 'image', result.reason));
        }
      }
    };

    /**
     * Re-render a shot's video (depth ≥ 'video', #1085). Runs AFTER this run's
     * motion-prompt and image stages, and consumes what THOSE stages produced
     * — resolved by the claim ids this run owns, not by the selection pointers
     * a concurrent edit can repoint underneath it. Otherwise mirrors
     * `generateShotMotionFn`: assembled prompt, video model from the selected
     * version → sequence default, #873 reference images, model-snapped
     * duration, credits preflight.
     */
    const preparedVideos = new Map<string, MotionRenderShot>();
    const prepareVideo = async (
      target: PlanTarget,
      claims: ShotClaims,
      /** @see spawnImage — the motion-prompt child's twin. */
      promptedMotionVersionId: string | null
    ): Promise<void> => {
      const motionInputJson = await step.do(
        `prepare-video-${target.shotId}`,
        async (): Promise<string | null> => {
          const [shot, frame] = await Promise.all([
            scopedDb.liveRead.shots.getById(target.shotId),
            scopedDb.liveRead.frames.getAnchorByShot(target.shotId),
          ]);
          if (!shot || !frame) {
            throw new NonRetryableError(
              `Shot ${target.shotId} disappeared mid-update`,
              'WorkflowValidationError'
            );
          }

          // The still (#1067): this run's own render when the image stage
          // produced one, else the still the shot pointed at when the user
          // clicked (the image stage may have stood down, leaving the previous
          // still as the right input). Both by explicit id — `frame_variants`
          // is append-only, so neither row can change under us, and the
          // selection pointer is never dereferenced here.
          let still: FrameVariant | null = null;
          if (target.regenImage && claims.imageVariantId) {
            const rendered = await scopedDb.claims.frameVariants.getById(
              claims.imageVariantId
            );
            if (rendered?.status === 'completed' && rendered.url) {
              still = rendered;
            }
          }
          if (!still && target.standingImageVariantId) {
            const standing = await scopedDb.claims.frameVariants.getById(
              target.standingImageVariantId
            );
            // `getById` doesn't filter discards the way the selection read did:
            // discarding a still is the user saying "not this one", and it must
            // still mean that after the click pinned it.
            still = standing?.discardedAt ? null : standing;
          }
          // Reference-only sequences never render a still, so demanding one
          // here failed the whole update run — and a mode flip re-stales every
          // motion prompt, which is exactly what sends a reference-only
          // sequence down this path.
          // Per target, not per sequence: a shot may override the sequence's
          // start-frame mode either way, and the plan froze that answer at
          // click time.
          if (!still?.url && target.usesStartFrame) {
            throw new NonRetryableError(
              `Shot ${target.shotId} has no rendered still to animate`,
              'WorkflowValidationError'
            );
          }

          // The motion prompt, resolved the same way the image chain resolves
          // its visual prompt — always by explicit id: this run's own claim
          // when it regenerated the prompt, else the version the plan pinned.
          let motionVersion: ShotPromptVersion | null;
          if (target.regenMotion) {
            const dep = claims.motionVersionId
              ? await scopedDb.claims.shotPromptVersions.getByIdForShot(
                  claims.motionVersionId,
                  shot.id
                )
              : null;
            // This run's own claim, else the row it retired into on the
            // unique-index collision path — named by the motion-prompt child,
            // read back by explicit id. Not the selection pointer: it can move
            // to a different prompt between this step and the render, and an
            // `inputHash` match proves the inputs matched, not the text.
            motionVersion =
              dep?.status === 'completed'
                ? dep
                : promptedMotionVersionId
                  ? await scopedDb.claims.shotPromptVersions.getByIdForShot(
                      promptedMotionVersionId,
                      shot.id
                    )
                  : null;
            // A prompt this run failed to land is never worth billing a
            // render for — stand down rather than animate the old one.
            if (motionVersion?.status !== 'completed') return null;
          } else {
            // Video-only regen: this run never touched the motion prompt, so
            // the prompt the shot pointed at when the user clicked IS what
            // they asked to animate. The plan dereferenced that pointer once;
            // read the row back by id (`shot_prompt_versions` is append-only)
            // rather than following the pointer now, which a concurrent
            // restore could have moved. Only the id rides the payload — the
            // fat fields (components/parameters/dialogue/audio) come from
            // this read.
            motionVersion = target.standingMotionVersionId
              ? await scopedDb.claims.shotPromptVersions.getByIdForShot(
                  target.standingMotionVersionId,
                  shot.id
                )
              : null;
          }
          if (!motionVersion) {
            throw new NonRetryableError(
              `Shot ${target.shotId} has no motion prompt to render from`,
              'WorkflowValidationError'
            );
          }

          // Spawn-time re-check (billing safety): the plan's video gating ran
          // at run START, possibly many minutes ago, and video has no claim
          // rows — a concurrent Update all (second tab, teammate) or a manual
          // render could have started or finished this exact work meanwhile.
          // Skip quietly (null): if a render is in flight it is already
          // producing the fix; if the selected manifest already records the
          // exact inputs resolved above, someone rendered from them; if the
          // selection vanished there is no video to update (never a FIRST
          // render).
          const selectedVideo =
            await scopedDb.liveRead.videoVariants.getSelectedByShot(shot.id);
          // A continue renders the first video (#1818); for Update all a
          // vanished selection means there is nothing to update.
          if (!selectedVideo && !target.createsVideo) return null;
          if (target.motionRender.renderSegmentId) {
            const segmentVersions =
              await scopedDb.liveRead.videoVariants.listBySegment(
                target.motionRender.renderSegmentId
              );
            if (segmentVersions.some((v) => v.status === 'generating')) {
              return null;
            }
          }
          const manifestEntry = selectedVideo?.manifest.find(
            (entry) => entry.shotId === shot.id
          );
          // A shot rendering from references has no frame pointer at all —
          // `null` is the manifest's documented encoding for that. Compare
          // against the same rule the write below uses, or a reference-only
          // shot that HAPPENS to have a still reads as permanently diverged
          // and re-renders on every update-stale run.
          const expectedFrameVersionId = target.usesStartFrame
            ? (still?.id ?? null)
            : null;
          const diverged =
            !manifestEntry ||
            manifestEntry.motionPromptVersionId !== motionVersion.id ||
            manifestEntry.frameVersionId !== expectedFrameVersionId;
          // The plan judged this very clip stale — for any reason, not only
          // the two ids above — so it renders while it is still selected.
          const unchangedSinceClick =
            selectedVideo !== null &&
            selectedVideo.id === target.staleVideoVersionId;
          if (selectedVideo && !diverged && !unchangedSinceClick) return null;
          // Selected-version model → sequence default. (The single-shot fn
          // also consults a last-failed attempt; irrelevant here — a video
          // must already exist for this target to be planned.)
          // A leftover the user sent to Grok renders there at its 1s floor,
          // as the fresh run's batch does.
          const model = leftoverGrok.has(target.shotId)
            ? 'grok_imagine_video_1_5'
            : (plan.renderOptions?.videoModels?.[0] ??
              resolveVideoModel({
                selectedVersionModel: target.motionRender.selectedModel,
                sequenceModel: sequenceSnapshot.videoModel,
              }));
          const prompt = resolveMotionPromptFromVersion(
            motionVersion,
            {
              dialogue: target.dialogue,
              characterTags: target.motionRender.characterTags,
              description: target.motionRender.description,
            },
            model
          );
          if (!prompt) {
            throw new NonRetryableError(
              `Shot ${target.shotId} has no motion prompt to render from`,
              'WorkflowValidationError'
            );
          }
          const referenceImages = buildMotionReferenceImages({
            scene: {
              continuity: {
                characterTags: target.motionRender.characterTags,
                // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a plan frozen before #2015
                characterLooks: target.motionRender.characterLooks ?? undefined,
                elementTags: target.motionRender.elementTags,
                environmentTag: target.motionRender.environmentTag,
              },
              metadata: { location: target.motionRender.location },
              originalScript: { extract: target.motionRender.description },
            },
            characters: renderRefs.characters,
            elements: renderRefs.elements,
            motionPrompt: prompt,
            // With no still the location sheet is the only thing establishing
            // the set — and `renderRefs` already loaded it for the image stage.
            referenceOnly: !target.usesStartFrame,
            locations: renderRefs.locations,
          });
          const duration = packPayloadDurationSeconds(target.durationMs);
          // What the shot says, snapshotted on the target at click time
          // (#1657).
          const voicedLines = modelTakesDialogueAudio(model)
            ? voicedDialogueLines(target.dialogue, voicedPlan.characterVoices)
            : [];
          const audioClips = matchingDialogueClips(
            speechClipsByShotId[target.shotId] ??
              target.motionRender.audioClips,
            voicedLines
          );
          if (voicedLines.length > 0 && audioClips.length === 0) {
            throw new NonRetryableError(
              `Dialogue audio is not ready for shot ${target.shotId}; motion is blocked.`
            );
          }
          const motionInput: MotionRenderShot = {
            shotId: shot.id,
            sceneId: target.motionRender.sceneId,
            renderSegmentId: target.motionRender.renderSegmentId,
            imageUrl: target.usesStartFrame
              ? (still?.url ?? undefined)
              : undefined,
            referenceOnly: !target.usesStartFrame,
            // Same rule as `expectedFrameVersionId` above — a clip rendered
            // from references names no still.
            frameVersionId: target.usesStartFrame ? (still?.id ?? null) : null,
            motionPromptVersionId: motionVersion.id,
            prompt,
            model,
            duration,
            aspectRatio: plan.aspectRatio,
            resolution: plan.resolution,
            draft: plan.sequence.draftMotion,
            sceneTitle: target.motionRender.sceneTitle,
            sequenceTitle: sequenceSnapshot.title,
            referenceImages,
            voicedLines,
            audioClips: audioClips.length > 0 ? audioClips : undefined,
            motionPrompt: motionPromptFromVersion(
              motionVersion,
              target.dialogue
            ),
            characterTags: target.motionRender.characterTags,
            // One shot of a multi-shot scene renders alone here, so it
            // carries the scene header a packed clip states once (#1874).
            packedScene: target.motionRender.packedScene,
            attachSceneHeader: target.attachSceneHeader,
          };
          return JSON.stringify(motionInput);
        }
      );
      if (motionInputJson === null) {
        logger.info(
          `[UpdateStaleShotsWorkflow] video for shot ${target.shotId} no longer needs rendering; skipping`
        );
        return;
      }
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the step above serialized exactly this type
      const motionInput = JSON.parse(motionInputJson) as MotionRenderShot;
      preparedVideos.set(target.shotId, motionInput);
    };

    /**
     * Materialise a prompt target's scenes. Kept out of the plan (see
     * `PlanTarget`) so the plan stays under the 1 MiB step-result cap; one
     * step per shot means each result carries a single shot's scenes.
     * Neighbours resolve through the same scene context, matching
     * regenerateShotPromptFn.
     */
    const loadPromptScenes = (target: PlanTarget): Promise<PromptScenes> =>
      step.do(`prepare-prompt-${target.shotId}`, async () => {
        const shot = await scopedDb.liveRead.shots.getById(target.shotId);
        if (!shot) {
          throw new NonRetryableError(
            `Shot ${target.shotId} disappeared mid-update`,
            'WorkflowValidationError'
          );
        }
        const { scene } = resolveSceneForShot(shot, sceneContext);
        if (!scene) {
          throw new NonRetryableError(
            `Shot ${target.shotId} lost its scene metadata mid-update`,
            'WorkflowValidationError'
          );
        }
        return { scene };
      });

    // Dialogue is recorded ONCE PER SCENE (#1657). Fresh runs record after
    // Images; updates can start immediately. Every video render awaits this
    // result, and `prepare-video` blocks any voiced shot without a matching
    // clip before its motion child is spawned.
    if (!input.freshRun && input.announcePhases && plan.targets.length > 0) {
      await announce(
        plan.targets.some((t) => t.regenVisual || t.regenImage || t.regenMotion)
          ? 'images'
          : plan.targets.some((t) => t.regenDialogue)
            ? 'dialogue'
            : 'motion'
      );
    }
    const hasImageWork =
      plan.targets.some(
        (target) =>
          target.regenVisual || target.regenImage || target.regenMotion
      ) || !!(musicToRun?.regenPrompt && !musicToRun.regenTrack);
    if (freshPhases && hasImageWork) await announce('images');
    const dialogueSpeech = voicedPlan.dialogueSpeech;
    // Same balance gate the per-shot render applies to its own TTS, priced on
    // the whole conversation. Short of it, skip the up-front recording: each
    // shot's own gate then refuses it by name instead of the run failing here.
    const canRecordScenes = dialogueSpeech
      ? await step.do('gate-dialogue-audio', async () => {
          try {
            await requireCredits(
              scopedDb.liveRead,
              estimateTtsCost(
                dialogueSpeech.scenes.reduce(
                  (sum, job) => sum + ttsCharacterCount(job.voiced),
                  0
                )
              ),
              {
                errorMessage: 'Insufficient credits for dialogue audio',
                reservationId: input.reservationId,
              }
            );
            return true;
          } catch (error) {
            if (isInsufficientCreditsError(error)) return false;
            throw error;
          }
        })
      : false;
    // Settles to the recorded clips, or to why the scene audio was not
    // recorded — never rejects, so a render awaiting it is never failed by it.
    let speechClipsByShotId: DialogueAudioWorkflowResult['clipsByShotId'] = {};
    const generateDialogueSpeech = (): Promise<DialogueOutcome> =>
      dialogueSpeech && canRecordScenes
        ? spawnAndAwaitChild<
            DialogueAudioWorkflowInput,
            DialogueAudioWorkflowResult
          >(step, {
            binding: this.env.DIALOGUE_AUDIO_WORKFLOW,
            parentBindingName: PARENT_BINDING_NAME,
            parentInstanceId,
            childId: `dialogue-audio:${sequenceId}:${parentInstanceId}`,
            childPayload: {
              userId,
              teamId,
              sequenceId,
              reservationId: input.reservationId,
              scenes: dialogueSpeech.scenes,
              minDurationSeconds: dialogueSpeech.minDurationSeconds,
              maxDurationSeconds: dialogueSpeech.maxDurationSeconds,
              analysisModelId: plan.promptContext?.analysisModelId,
            },
            spawnStepName: 'spawn-dialogue-audio',
            awaitStepName: 'await-dialogue-audio',
            timeout: '60 minutes',
          }).then(
            (result): DialogueOutcome => ({
              clipsByShotId: (speechClipsByShotId = result.clipsByShotId),
            }),
            (error: unknown): DialogueOutcome => {
              logger.warn(
                '[UpdateStaleShotsWorkflow] Scene dialogue not recorded; its voiced clips will be blocked',
                { sequenceId, err: error }
              );
              return {
                error: error instanceof Error ? error.message : String(error),
              };
            }
          )
        : Promise.resolve<DialogueOutcome>(
            dialogueSpeech
              ? { error: 'Insufficient credits for dialogue audio' }
              : { clipsByShotId: {} }
          );

    let dialogueGenerated = input.freshRun
      ? Promise.resolve<DialogueOutcome>({ clipsByShotId: {} })
      : generateDialogueSpeech();
    const eligibleVideos: Array<{
      target: PlanTarget;
      claims: ShotClaims;
      motionVersionId: string | null;
    }> = [];

    // ============================================================
    // PHASE 2: fan out — one job per shot. A stale spec is rewritten, then
    // its prompts are rebuilt from the new spec. A current spec rebuilds
    // for free, with no LLM. The still waits on the visual prompt. Motion
    // does not wait on the still. The video render waits on both.
    // ============================================================
    // `promptCommon` is provably non-null whenever targets exist (the guard
    // above throws otherwise); the ternary is for the compiler, and yields
    // the same empty job list a target-less (music-only) run needs.
    const jobs = !promptCommon
      ? []
      : voicedPlan.targets.map((target) =>
          (async (): Promise<void> => {
            const claims = claimed.claimsByShot[target.shotId] ?? {
              visualVersionId: null,
              motionVersionId: null,
              imageVariantId: null,
              specClaimId: null,
            };
            // A regen flag without a claim means another run already owns that
            // artifact ('already-in-flight' in `skipped`) — this run stands down.
            const doVisual =
              target.regenVisual && claims.visualVersionId !== null;
            const doMotion =
              target.regenMotion && claims.motionVersionId !== null;
            const specClaimId = claims.specClaimId;
            const doRewrite =
              target.rewriteSpec === true && specClaimId !== null;
            // A sheet / element this run failed to make holds the still and
            // clip made from it (#1818) — never render without it.
            const heldByReference =
              failedReferenceIds.size > 0 &&
              target.referenceIds.some((id) => failedReferenceIds.has(id));
            const doImage =
              !heldByReference &&
              target.regenImage &&
              claims.imageVariantId !== null;

            // Best-effort claim cleanup on a stage failure — a claim must never
            // outlive its run's ability to complete it (the reconciler is the
            // backstop for anything this misses). Inside a step so a replay
            // doesn't re-fire the writes; the catch stays inside it so a failed
            // cleanup never escalates into a run failure.
            const failClaims = (stage: UpdateStage): Promise<null> =>
              step.do(`fail-claim-${stage}-${target.shotId}`, async () => {
                try {
                  if (stage === 'spec') {
                    if (claims.specClaimId) {
                      await scopedDb.shotSpecVersions.clearClaimIf({
                        shotId: target.shotId,
                        claimId: claims.specClaimId,
                      });
                    }
                    if (claims.visualVersionId) {
                      await scopedDb.framePromptVersions.markTerminal(
                        claims.visualVersionId,
                        'failed'
                      );
                      await scopedDb.frameVariants.cancelByDependency(
                        claims.visualVersionId,
                        'Upstream shot rewrite failed'
                      );
                    }
                    if (claims.motionVersionId) {
                      await scopedDb.shotPromptVersions.markTerminal(
                        claims.motionVersionId,
                        'failed'
                      );
                    }
                  }
                  if (stage === 'visual-prompt' && claims.visualVersionId) {
                    await scopedDb.framePromptVersions.markTerminal(
                      claims.visualVersionId,
                      'failed'
                    );
                    await scopedDb.frameVariants.cancelByDependency(
                      claims.visualVersionId,
                      'Upstream visual prompt generation failed'
                    );
                  }
                  if (stage === 'motion-prompt' && claims.motionVersionId) {
                    await scopedDb.shotPromptVersions.markTerminal(
                      claims.motionVersionId,
                      'failed'
                    );
                  }
                  if (stage === 'image' && claims.imageVariantId) {
                    await scopedDb.frameVariants.markTerminal(
                      claims.imageVariantId,
                      'failed',
                      'Image stage failed in Update all'
                    );
                  }
                } catch (err) {
                  logger.warn(
                    `[UpdateStaleShotsWorkflow] failed to clean up claim for shot ${target.shotId}`,
                    { err }
                  );
                }
                return null;
              });

            const needsPrompt = doVisual || doMotion || doRewrite;
            let scenes: PromptScenes | null = null;
            if (needsPrompt) {
              try {
                scenes = await loadPromptScenes(target);
              } catch (error) {
                if (isEngineAbortError(error)) throw error;
                if (doRewrite) {
                  failures.push(toFailure(target.shotId, 'spec', error));
                  await failClaims('spec');
                }
                if (doVisual) {
                  failures.push(
                    toFailure(target.shotId, 'visual-prompt', error)
                  );
                  await failClaims('visual-prompt');
                }
                if (doMotion) {
                  failures.push(
                    toFailure(target.shotId, 'motion-prompt', error)
                  );
                  await failClaims('motion-prompt');
                }
                if (doImage) await failClaims('image');
                if (target.regenVideo) {
                  failures.push({
                    shotId: target.shotId,
                    stage: 'video',
                    error:
                      'Upstream regeneration failed — video not re-rendered',
                  });
                }
                return;
              }
            }

            // Video ordering (#1085 depth ≥ 'video'): the render consumes the
            // regenerated motion prompt AND the regenerated still, so it waits on
            // BOTH stages and only runs when every upstream it depends on landed.
            // Vacuously true for stages this run isn't regenerating.
            const upstream = { motionOk: true, imageOk: true };

            // What each prompt child actually left live, so the chained
            // render resolves its prompt by explicit id (#1067). A selection
            // pointer read here would be a TOCTOU against a concurrent edit.
            const prompted: {
              visualVersionId: string | null;
              motionVersionId: string | null;
            } = { visualVersionId: null, motionVersionId: null };

            const context = promptCommon;
            const canRebuild = Boolean(target.spec && target.specVersionId);

            const notePromptMiss = (
              kind: 'visual' | 'motion',
              error: unknown
            ) => {
              if (kind === 'visual') upstream.imageOk = false;
              else upstream.motionOk = false;
              failures.push(
                toFailure(
                  target.shotId,
                  kind === 'visual' ? 'visual-prompt' : 'motion-prompt',
                  error
                )
              );
            };

            if (doRewrite) {
              if (
                typeof target.specInputHash === 'string' &&
                scenes &&
                context
              ) {
                try {
                  const sceneId = target.motionRender.sceneId;
                  const siblings = (
                    sceneId ? (plan.sceneSpecs?.[sceneId] ?? []) : []
                  )
                    .filter((row) => row.shotId !== target.shotId)
                    .map((row) => ({
                      shotNumber: row.shotNumber,
                      spec: row.spec,
                    }));
                  const rewritten = await spawnAndAwaitChild<
                    ShotSpecRewriteWorkflowInput,
                    ShotSpecRewriteWorkflowResult
                  >(step, {
                    binding: this.env.SHOT_SPEC_REWRITE_WORKFLOW,
                    parentBindingName: PARENT_BINDING_NAME,
                    parentInstanceId,
                    childId: `shot-spec-rewrite:${sequenceId}:${target.shotId}`,
                    childPayload: {
                      userId,
                      teamId,
                      sequenceId,
                      shotId: target.shotId,
                      frameId: target.frameId,
                      claimId: specClaimId,
                      visualClaimId: doVisual ? claims.visualVersionId : null,
                      motionClaimId: doMotion ? claims.motionVersionId : null,
                      visualWritten: target.visualWritten === true,
                      motionWritten: target.motionWritten === true,
                      referenceOnly: !target.usesStartFrame,
                      scene: scenes.scene,
                      siblingSpecs: siblings,
                      characterBible: context.characterBible,
                      locationBible: context.locationBible,
                      elementBible: context.elementBible,
                      styleConfig: context.styleConfig,
                      aspectRatio: plan.aspectRatio,
                      analysisModelId: context.analysisModelId,
                      lines: target.dialogue.lines.map(
                        ({ character, line, tone }) => ({
                          character,
                          line,
                          tone,
                        })
                      ),
                      specInputHash: target.specInputHash,
                      currentSpec: target.spec,
                      dialogue: target.dialogue,
                      emitStreaming: true,
                      reservationId: input.reservationId,
                    },
                    spawnStepName: `spawn-shot-spec-rewrite-${target.shotId}`,
                    awaitStepName: `await-shot-spec-rewrite-${target.shotId}`,
                  });
                  prompted.visualVersionId = rewritten.visualVersionId;
                  prompted.motionVersionId = rewritten.motionVersionId;
                  if (doVisual && !rewritten.visualVersionId) {
                    notePromptMiss(
                      'visual',
                      new Error('Rewrite did not rebuild the still prompt')
                    );
                  } else if (rewritten.visualVersionId) {
                    counters.visualPrompts += 1;
                  }
                  if (doMotion && !rewritten.motionVersionId) {
                    notePromptMiss(
                      'motion',
                      new Error('Rewrite did not rebuild the motion prompt')
                    );
                  } else if (rewritten.motionVersionId) {
                    counters.motionPrompts += 1;
                  }
                } catch (error) {
                  if (isEngineAbortError(error)) throw error;
                  upstream.imageOk = false;
                  upstream.motionOk = false;
                  failures.push(toFailure(target.shotId, 'spec', error));
                  await failClaims('spec');
                }
              } else {
                upstream.imageOk = false;
                upstream.motionOk = false;
                failures.push({
                  shotId: target.shotId,
                  stage: 'spec',
                  error: 'Shot spec is stale and cannot be rewritten',
                });
                await failClaims('spec');
              }
            } else if (
              (doVisual || doMotion) &&
              canRebuild &&
              scenes &&
              context &&
              target.spec &&
              target.specVersionId
            ) {
              const spec = target.spec;
              const specVersionId = target.specVersionId;
              const scene = scenes.scene;
              try {
                const rebuilt = await step.do(
                  `rebuild-prompts-${target.shotId}`,
                  async () => {
                    const result = await completeDerivedPrompts(scopedDb, {
                      spec,
                      specVersionId,
                      scene,
                      styleConfig: context.styleConfig,
                      characterBible: context.characterBible,
                      locationBible: context.locationBible,
                      elementBible: context.elementBible,
                      aspectRatio: plan.aspectRatio,
                      analysisModel: context.analysisModelId,
                      dialogue: target.dialogue,
                      referenceOnly: !target.usesStartFrame,
                      frameId: target.frameId,
                      shotId: target.shotId,
                      visualClaimId: doVisual ? claims.visualVersionId : null,
                      motionClaimId: doMotion ? claims.motionVersionId : null,
                      visualWritten: target.visualWritten === true,
                      motionWritten: target.motionWritten === true,
                      currencyHash: target.specInputHash,
                    });
                    const channel = getShotPromptChannel(target.shotId);
                    if (result.visualVersionId) {
                      await channel.emit('shotPrompt.completed', {
                        promptType: 'visual',
                      });
                    }
                    if (result.motionVersionId) {
                      await channel.emit('shotPrompt.completed', {
                        promptType: 'motion',
                      });
                    }
                    return result;
                  }
                );
                prompted.visualVersionId = rebuilt.visualVersionId;
                prompted.motionVersionId = rebuilt.motionVersionId;
                if (doVisual && !rebuilt.visualVersionId) {
                  notePromptMiss(
                    'visual',
                    new Error('Rebuild did not complete the still prompt')
                  );
                  await failClaims('visual-prompt');
                } else if (rebuilt.visualVersionId) {
                  counters.visualPrompts += 1;
                }
                if (doMotion && !rebuilt.motionVersionId) {
                  notePromptMiss(
                    'motion',
                    new Error('Rebuild did not complete the motion prompt')
                  );
                  await failClaims('motion-prompt');
                } else if (rebuilt.motionVersionId) {
                  counters.motionPrompts += 1;
                }
              } catch (error) {
                if (isEngineAbortError(error)) throw error;
                if (doVisual) {
                  notePromptMiss('visual', error);
                  await failClaims('visual-prompt');
                }
                if (doMotion) {
                  notePromptMiss('motion', error);
                  await failClaims('motion-prompt');
                }
              }
            } else if (doVisual || doMotion) {
              const error = new Error(
                'Shot has no spec to rebuild prompts from'
              );
              if (doVisual) {
                notePromptMiss('visual', error);
                await failClaims('visual-prompt');
              }
              if (doMotion) {
                notePromptMiss('motion', error);
                await failClaims('motion-prompt');
              }
            }

            if (doImage && upstream.imageOk) {
              try {
                await spawnImage(target, claims, prompted.visualVersionId);
              } catch (error) {
                if (isEngineAbortError(error)) throw error;
                upstream.imageOk = false;
                failures.push(toFailure(target.shotId, 'image', error));
                await failClaims('image');
              }
            }

            if (heldByReference && target.regenImage) {
              failures.push({
                shotId: target.shotId,
                stage: 'image',
                error: 'A reference this still needs failed — not rendered',
              });
              await failClaims('image');
            }

            if (target.regenDialogue && unvoicedShotIds.has(target.shotId)) {
              failures.push({
                shotId: target.shotId,
                stage: 'dialogue',
                error: 'A voice these lines need was not made — not recorded',
              });
            }
            if (target.regenVideo) {
              if (unvoicedShotIds.has(target.shotId)) {
                failures.push({
                  shotId: target.shotId,
                  stage: 'video',
                  error: 'A voice this clip needs was not made — not rendered',
                });
              } else if (heldByReference) {
                failures.push({
                  shotId: target.shotId,
                  stage: 'video',
                  error: 'A reference this clip needs failed — not rendered',
                });
              } else if (upstream.motionOk && upstream.imageOk) {
                eligibleVideos.push({
                  target,
                  claims,
                  motionVersionId: prompted.motionVersionId,
                });
              } else {
                // Rendering from the prompt/still the run failed to replace would
                // bill for a video the user didn't ask for.
                failures.push({
                  shotId: target.shotId,
                  stage: 'video',
                  error: 'Upstream regeneration failed — video not re-rendered',
                });
              }
            }
          })()
        );

    // ============================================================
    // Sequence-level music runs alongside update jobs, or after fresh motion.
    // Prompt-only work belongs to Images. The track renders when stale on its
    // own hash or the prompt regeneration cascades into it (see MusicPlan).
    // ============================================================
    const runMusic = musicToRun
      ? async (music: MusicPlan): Promise<void> => {
          // Model stays the workflow default unless the plan chose models —
          // parity with the manual regenerate path. audioModels[0] is primary.
          const models: (AudioModel | undefined)[] = [
            ...new Set(
              plan.renderOptions?.audioModels?.length
                ? plan.renderOptions.audioModels
                : [undefined]
            ),
          ];
          const primaryModel = models[0] ?? DEFAULT_MUSIC_MODEL;

          // The track's row and claim come first (#1130), and only while no
          // other primary track run holds the claim: a concurrent run or a
          // manual regenerate already producing the fix wins, and this run
          // makes neither the prompt nor the track — no double bill. Replaces
          // the live `musicStatus` / `musicPromptInputHash` guards (#1115).
          let trackVariantId: string | null = null;
          if (music.regenTrack) {
            // Minted in its own step so a retried claim step finds the row
            // it already opened instead of reading its own claim as busy.
            const mintedId = await step.do('mint-music-track-id', async () =>
              generateId()
            );
            trackVariantId = await step.do('claim-music-track', async () =>
              scopedDb.sequenceVariants.claimMusic({
                id: mintedId,
                sequenceId,
                model: primaryModel,
                prompt: music.prompt,
                tags: music.tags,
                durationSeconds: music.durationSeconds,
                isPrimary: true,
                workflowRunId: null,
                ifPendingIs: null,
              })
            );
            if (trackVariantId === null) {
              logger.info(
                `[UpdateStaleShotsWorkflow] music track for ${sequenceId} already rendering elsewhere; skipping`
              );
              return;
            }
          }
          const claimedTrack = trackVariantId;
          const failTrackClaim = async (error: unknown) => {
            if (!claimedTrack) return;
            await step.do('fail-music-track-claim', async () => {
              await scopedDb.sequenceVariants.failMusicClaim(
                { sequenceId, variantId: claimedTrack },
                error instanceof Error ? error.message : String(error)
              );
            });
          };

          // What the prompt child actually produced — the track renders from
          // this rather than from the selected prompt, which a concurrent
          // regenerate can move in between.
          let regeneratedPrompt: { prompt: string; tags: string } | null = null;
          if (music.regenPrompt) {
            // ponytail: a prompt-only regeneration has no claim to guard it,
            // so two concurrent runs can both call the LLM; the hash unique
            // index keeps the version write idempotent. Claim the prompt if
            // the duplicate spend ever matters.
            try {
              const musicDesign = await spawnAndAwaitChild<
                MusicPromptWorkflowInput,
                MusicPromptWorkflowResult
              >(step, {
                binding: this.env.MUSIC_PROMPT_WORKFLOW,
                parentBindingName: PARENT_BINDING_NAME,
                parentInstanceId,
                childId: `music-prompt:${sequenceId}`,
                childPayload: {
                  userId,
                  teamId,
                  sequenceId,
                  sceneSummaries: music.sceneSummaries,
                  analysisModelId: music.analysisModelId,
                  promptSource: music.promptSource,
                  reservationId: input.reservationId,
                  musicModel: primaryModel,
                  ...(claimedTrack ? { musicVariantId: claimedTrack } : {}),
                },
                spawnStepName: 'spawn-music-prompt',
                awaitStepName: 'await-music-prompt',
              });
              regeneratedPrompt = {
                prompt: musicDesign.prompt,
                // The child stores reinforced tags; reinforce here too so the
                // render and the stored version describe the same track.
                tags: reinforceInstrumentalTags(musicDesign.tags),
              };
              counters.musicPrompts += 1;
            } catch (error) {
              failures.push(toFailure(sequenceId, 'music-prompt', error));
              if (music.regenTrack) {
                // Never regenerate the track from the prompt the run
                // failed to replace.
                failures.push({
                  shotId: sequenceId,
                  stage: 'music',
                  error: 'Upstream music prompt failed — track not regenerated',
                });
                await failTrackClaim(error);
              }
              return;
            }
          }

          if (!claimedTrack) return;
          try {
            // A track stale on its OWN hash (#1657) renders from the prompt
            // frozen in the plan — there was no prompt child to take it from.
            const prompt = regeneratedPrompt?.prompt ?? music.prompt;
            const tags = regeneratedPrompt?.tags ?? music.tags;
            if (!prompt || !tags) {
              throw new NonRetryableError(
                'Sequence has no music prompt to regenerate from',
                'WorkflowValidationError'
              );
            }
            await Promise.all(
              models.map(async (model, index) => {
                const suffix = index > 0 ? `-${model}` : '';
                await spawnAndAwaitChild<MusicWorkflowInput, unknown>(step, {
                  binding: this.env.MUSIC_WORKFLOW,
                  parentBindingName: PARENT_BINDING_NAME,
                  parentInstanceId,
                  childId: `music:${sequenceId}${suffix}`,
                  childPayload: {
                    userId,
                    teamId,
                    sequenceId,
                    prompt,
                    tags,
                    duration: music.durationSeconds,
                    model,
                    isPrimary: index === 0,
                    // The primary renders into the row claimed above; the
                    // other models open their own.
                    ...(index === 0 ? { variantId: claimedTrack } : {}),
                    reservationId: input.reservationId,
                  },
                  spawnStepName: `spawn-music-track${suffix}`,
                  awaitStepName: `await-music-track${suffix}`,
                });
                counters.musicTracks += 1;
              })
            );
          } catch (error) {
            failures.push(toFailure(sequenceId, 'music', error));
            // A child that ran failed its own row; this covers one that never
            // started. Only a still-pending row is touched.
            await failTrackClaim(error);
          }
        }
      : null;

    const musicJob =
      runMusic && musicToRun && (!input.freshRun || !musicToRun.regenTrack)
        ? runMusic(musicToRun)
        : null;
    await Promise.allSettled([...jobs, ...(musicJob ? [musicJob] : [])]);
    if (freshPhases && hasImageWork) await completePhase('images');
    if (input.freshRun) {
      if (freshPhases && dialogueSpeech) await announce('dialogue');
      dialogueGenerated = generateDialogueSpeech();
    }
    await dialogueGenerated;
    if (freshPhases && dialogueSpeech) await completePhase('dialogue');
    if (freshPhases && eligibleVideos.length > 0) await announce('motion');
    await Promise.all(
      eligibleVideos.map(async ({ target, claims, motionVersionId }) => {
        try {
          await prepareVideo(target, claims, motionVersionId);
        } catch (error) {
          failures.push(toFailure(target.shotId, 'video', error));
        }
      })
    );
    // Prepare every eligible target before any video child can claim a segment.
    // Preserve plan order despite concurrent prompt/image completion.
    const heldSegments = new Set(
      plan.targets.flatMap((target) =>
        target.regenVideo &&
        target.motionRender.renderSegmentId &&
        (!preparedVideos.has(target.shotId) ||
          target.motionRender.siblingShotIds?.some(
            (id) => !preparedVideos.has(id)
          ))
          ? [target.motionRender.renderSegmentId]
          : []
      )
    );
    const renderShots = plan.targets.flatMap((target) => {
      if (
        target.motionRender.renderSegmentId &&
        heldSegments.has(target.motionRender.renderSegmentId)
      ) {
        if (preparedVideos.has(target.shotId))
          failures.push({
            shotId: target.shotId,
            stage: 'video',
            error: 'A sibling in this clip could not render — clip held',
          });
        return [];
      }
      const shot = preparedVideos.get(target.shotId);
      return shot ? [shot] : [];
    });
    const renderJobs = plan.renderOptions?.videoModels?.length
      ? [
          ...buildMotionRender({
            userId,
            teamId,
            sequenceId,
            reservationId: input.reservationId,
            shots: renderShots
              .filter((shot) => !leftoverGrok.has(shot.shotId))
              // The explicit leftover partition owns fallback identity;
              // every other shot uses the full requested model list.
              .map((shot) => ({ ...shot, model: undefined })),
            videoModels: plan.renderOptions.videoModels,
          }),
          ...buildMotionRender({
            userId,
            teamId,
            sequenceId,
            reservationId: input.reservationId,
            shots: renderShots.filter((shot) => leftoverGrok.has(shot.shotId)),
          }),
        ]
      : buildMotionRender({
          userId,
          teamId,
          sequenceId,
          reservationId: input.reservationId,
          shots: renderShots,
        });
    await Promise.all(
      renderJobs.map(async ({ input }) => {
        const shotId = input.shotId;
        const variant =
          !!plan.renderOptions?.videoModels?.length &&
          !leftoverGrok.has(shotId) &&
          input.model !== plan.renderOptions.videoModels[0];
        input.variantOnly = variant;
        const suffix = variant ? `-${input.model}` : '';
        try {
          const model = input.model;
          const voicedLines = input.voicedLines ?? [];
          const audioClips = input.audioClips ?? [];
          await step.do(`preflight-video-${shotId}${suffix}`, async () => {
            const ttsChars =
              audioClips.length > 0 ? 0 : ttsCharacterCount(voicedLines);
            await requireCredits(
              scopedDb.liveRead,
              addMicros(
                gateEstimate(
                  estimateVideoCost(model, input.duration ?? 3, {
                    pricing: await getEffectiveFalPricing(),
                    resolution:
                      input.draft && supportsDraftMode(model)
                        ? DRAFT_RESOLUTION
                        : input.resolution,
                    referenceOnly: input.referenceOnly,
                    hasReferenceImages:
                      (input.referenceImages?.length ?? 0) > 0,
                  }),
                  { model, operation: 'update-stale-shots:video' }
                ),
                estimateTtsCost(ttsChars)
              ),
              {
                errorMessage: 'Insufficient credits for video generation',
                reservationId: input.reservationId,
              }
            );
          });
          await spawnAndAwaitChild<MotionWorkflowInput, MotionWorkflowResult>(
            step,
            {
              binding: this.env.MOTION_WORKFLOW,
              parentBindingName: PARENT_BINDING_NAME,
              parentInstanceId,
              childId: `motion:${sequenceId}:${shotId}${suffix}`,
              childPayload: input,
              spawnStepName: `spawn-video-${shotId}${suffix}`,
              awaitStepName: `await-video-${shotId}${suffix}`,
              timeout: '90 minutes',
            }
          );
          counters.videos += 1;
        } catch (error) {
          for (const member of input.coveredShots ?? [{ shotId }]) {
            failures.push(toFailure(member.shotId, 'video', error));
          }
        }
      })
    );
    if (freshPhases && eligibleVideos.length > 0) await completePhase('motion');
    if (input.freshRun && runMusic && musicToRun?.regenTrack) {
      if (freshPhases) await announce('music');
      await runMusic(musicToRun);
      if (freshPhases) await completePhase('music');
    }
    const dialogue = dialogueTargetOutcome(
      voicedPlan.targets,
      dialogueSpeech,
      await dialogueGenerated
    );
    counters.dialogues = dialogue.updated;
    failures.push(...dialogue.failures);

    // A user-initiated action that partly failed is a production issue, not a
    // warning — `error` is the only severity that surfaces in error tracking.
    if (failures.length > 0) {
      logger.error(
        `[UpdateStaleShotsWorkflow] ${failures.length} stage failure(s) across ${plan.targets.length} shots`,
        { failures }
      );
    }
    if (allSkipped.length > 0) {
      logger.error(
        `[UpdateStaleShotsWorkflow] ${allSkipped.length} shot(s) skipped by the plan`,
        { skipped: allSkipped }
      );
    }

    return {
      totalShots: plan.targets.length,
      ...counters,
      failures,
      skipped: allSkipped,
    };
  }
}

type DialogueOutcome =
  | { clipsByShotId: Record<string, readonly unknown[]> }
  | { error: string };

/**
 * What the up-front recording did for the targets that asked for dialogue.
 * A target counts when the recording returned its audio; neighbours that
 * came back with the scene do not. A target without audio fails at
 * `dialogue` when no video render follows; otherwise `prepare-video` blocks
 * the motion child before fan-out.
 */
export function dialogueTargetOutcome(
  targets: ReadonlyArray<
    Pick<PlanTarget, 'shotId' | 'regenDialogue' | 'regenVideo'>
  >,
  recording: {
    scenes: ReadonlyArray<{ voiced: ReadonlyArray<{ shotId: string }> }>;
  } | null,
  outcome: DialogueOutcome
): { updated: number; failures: UpdateFailure[] } {
  const recordedShotIds = new Set(
    recording?.scenes.flatMap((job) => job.voiced.map((line) => line.shotId))
  );
  let updated = 0;
  const failures: UpdateFailure[] = [];
  for (const target of targets) {
    if (!target.regenDialogue || !recordedShotIds.has(target.shotId)) continue;
    if ('clipsByShotId' in outcome) {
      if ((outcome.clipsByShotId[target.shotId]?.length ?? 0) > 0) {
        updated += 1;
        continue;
      }
      if (!target.regenVideo) {
        failures.push({
          shotId: target.shotId,
          stage: 'dialogue',
          error: 'Dialogue not recorded for this shot',
        });
      }
    } else if (!target.regenVideo) {
      failures.push({
        shotId: target.shotId,
        stage: 'dialogue',
        error: outcome.error,
      });
    }
  }
  return { updated, failures };
}

function toFailure(
  shotId: string,
  stage: UpdateStage,
  error: unknown
): UpdateFailure {
  return {
    shotId,
    stage,
    error: error instanceof Error ? error.message : String(error),
  };
}
