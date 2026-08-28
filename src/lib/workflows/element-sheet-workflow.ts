/**
 * Element sheet workflow — auto-generates reference images for recurring
 * products/objects detected during scene split that have no user-uploaded
 * element (#835).
 *
 * Mirrors the character treatment: characters detected in a script get an
 * auto-generated reference sheet that anchors their look across shots;
 * this workflow gives detected elements (the element bible already models
 * them) the same anchor. Each entry is generated from its bible description,
 * uploaded to the ELEMENTS bucket, and ingested as a `sequence_elements` row
 * with `visionStatus: 'completed'` (the bible entry already carries the
 * description + consistencyTag that vision would have produced), so the rest
 * of the pipeline — scene matching, reference attachment, replace-element —
 * treats it exactly like an uploaded element.
 *
 * All entries run concurrently and every pipeline runs to completion before
 * failures are surfaced: if any entry fails after its durable steps exhaust
 * their retries, the whole run fails (and with it the parent analysis) rather
 * than silently rendering the affected shots unanchored. Entries that
 * completed are already persisted, so a retried run skips them via the
 * idempotency guard.
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type { ElementBibleEntry } from '@/lib/ai/scene-analysis.schema';
import {
  deductWorkflowCredits,
  extractImageCost,
  recordFalUsageStep,
} from '@/lib/billing/workflow-deduction';
import { generateId } from '@/lib/db/id';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { SequenceElement, SequenceElementMinimal } from '@/lib/db/schema';
import type { ImageGenerationParams } from '@/lib/image/image-generation';
import { recordProvenance } from '@/lib/compliance/provenance';
import { buildElementSheetPrompt } from '@/lib/prompts/element-prompt';
import { rejectionReasonMessage } from '@/lib/workflows/replace-element-workflow';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { uploadResponse } from '@/lib/storage/upload-response';
import { contentRejectionSummary } from '@/lib/ai/content-rejection';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { generateImageSoftening } from '@/lib/workflows/content-soften';
import type {
  ElementSheetWorkflowInput,
  ElementSheetWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'element-sheet']);

/**
 * Upper bound on auto-generated element references per run. The scene-split
 * prompt asks the model to detect at most 3; this guards against a chatty
 * model burning image credits on incidental props.
 */
const MAX_AUTO_ELEMENTS = 3;

/**
 * Element bible entries that have no matching uploaded/ingested element row.
 * Uploaded elements always win — the bible echoes their tokens back, so any
 * token already present in `existing` is covered by a real reference image.
 */
function toMinimalElement(
  row: Pick<
    SequenceElement,
    'id' | 'token' | 'description' | 'imageUrl' | 'consistencyTag'
  >
): SequenceElementMinimal {
  return {
    id: row.id,
    token: row.token,
    description: row.description,
    imageUrl: row.imageUrl,
    consistencyTag: row.consistencyTag,
  };
}

export function findMissingElementEntries(
  elementBible: ElementBibleEntry[],
  existing: Array<Pick<SequenceElementMinimal, 'token'>>
): ElementBibleEntry[] {
  const existingTokens = new Set(existing.map((el) => el.token));
  return elementBible.filter((entry) => !existingTokens.has(entry.token));
}

/**
 * Reduce the per-entry settled outcomes to the generated elements, failing
 * loudly when any entry failed: a dropped reference would silently render the
 * affected shots unanchored, so surface the failure instead of degrading.
 */
export function collectElementResults(
  settled: Array<PromiseSettledResult<SequenceElementMinimal>>,
  entries: Array<Pick<ElementBibleEntry, 'token'>>
): SequenceElementMinimal[] {
  const failures: { name: string; reason: string }[] = [];
  const elements: SequenceElementMinimal[] = [];
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === 'rejected') {
      failures.push({
        name: entries[index]?.token ?? `index ${index}`,
        reason: rejectionReasonMessage(outcome.reason),
      });
      continue;
    }
    elements.push(outcome.value);
  }
  if (failures.length > 0) {
    throw new Error(
      contentRejectionSummary(failures) ??
        `Element reference generation failed for ${failures.length}/${settled.length} element(s) — ${failures.map((f) => `${f.name}: ${f.reason}`).join('; ')}`
    );
  }
  return elements;
}

export class ElementSheetWorkflow extends OpenStoryWorkflowEntrypoint<ElementSheetWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<ElementSheetWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<ElementSheetWorkflowResult> {
    const input = event.payload;
    const { sequenceId, styleConfig } = input;
    const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;

    const entries = input.entries.slice(0, MAX_AUTO_ELEMENTS);
    if (input.entries.length > entries.length) {
      logger.warn(
        `[ElementSheetWorkflow:cf] Capping auto-generated elements at ${MAX_AUTO_ELEMENTS} (got ${input.entries.length}) for sequence ${sequenceId}`
      );
    }
    if (entries.length === 0) {
      return { elements: [] };
    }

    logger.info(
      `[ElementSheetWorkflow:cf] Generating ${entries.length} element reference(s) for sequence ${sequenceId}: ${entries.map((e) => e.token).join(', ')}`
    );

    // One pipeline per entry, run concurrently. allSettled so every entry
    // runs to completion (successful entries persist their rows) before any
    // failure is surfaced — a retried run then skips the completed entries
    // via the idempotency guard.
    const settled = await Promise.allSettled(
      entries.map(async (entry, index) => {
        // Idempotency guard: a replayed run (or a token the user uploaded
        // mid-flight) must not violate the (sequenceId, token) unique index.
        // The id lookup comes first and is the one that survives a rename —
        // `entry.elementId` is allocated at the spawn and is what `create`
        // below writes, whereas the token can be rewritten (by the user, or by
        // the vision auto-rename) between attempts. The token lookup stays as
        // the uniqueness guard against a concurrent upload of the same token.
        const existing = await step.do(
          `check-existing-element-${index}`,
          async () => {
            const row =
              (await scopedDb.liveRead.sequenceElements.getById(
                entry.elementId
              )) ??
              (await scopedDb.liveRead.sequenceElements.getByToken(
                sequenceId,
                entry.token
              ));
            return row ? toMinimalElement(row) : null;
          }
        );
        if (existing) {
          logger.info(
            `[ElementSheetWorkflow:cf] Element ${entry.token} already exists for sequence ${sequenceId}; skipping generation`
          );
          return existing;
        }

        const builtParams: ImageGenerationParams = {
          model: imageModel,
          prompt: buildElementSheetPrompt(entry, styleConfig),
          // Square reference: the object fills the shot regardless of the
          // sequence aspect ratio; placement happens at shot-generation time.
          imageSize: 'square_hd' as const,
          numImages: 1,
        };

        // Reseeds on a content flag, then one softened prompt (#1293).
        const generation = await generateImageSoftening({
          step,
          scopedDb,
          workflowRunId: event.instanceId,
          userId: input.userId,
          sequenceId,
          reservationId: input.reservationId,
          kind: 'element-sheet',
          logTag: '[ElementSheetWorkflow:cf]',
          subject: `element ${entry.token}`,
          stepName: `generate-element-image-${index}`,
          params: builtParams,
          meta: { elementId: entry.elementId },
        });
        const imageResult = generation.result;
        const generationParams = generation.params;

        // Before the deduction guard — see recordFalUsageStep (#1069).
        const falUsage = await recordFalUsageStep(
          step,
          scopedDb,
          imageResult.metadata,
          `record-fal-usage-${index}`
        );

        await step.do(`deduct-credits-${index}`, async () => {
          await deductWorkflowCredits({
            scopedDb,
            costMicros: extractImageCost(imageResult.metadata),
            usedOwnKey: imageResult.metadata.usedOwnKey,
            description: `Element reference (${generationParams.model})`,
            idempotencyKey: `${event.instanceId}:element-ref-${index}`,
            reservationId: input.reservationId,
            metadata: {
              ...falUsage,
              model: generationParams.model,
              token: entry.token,
              sequenceId,
            },
            workflowName: 'ElementSheetWorkflow',
          });
        });

        const generatedUrl = imageResult.imageUrls[0];
        if (!generatedUrl) {
          throw new Error(
            `Element reference generation returned no image URL for ${entry.token}`
          );
        }

        const storageResult = await step.do(
          `upload-element-image-${index}`,
          async () => {
            const response = await fetch(generatedUrl);
            if (!response.ok) {
              throw new Error(
                `Failed to fetch generated element image: ${response.status}`
              );
            }
            // Same path shape as user uploads: {teamId}/{sequenceId}/{id}.png
            const storagePath = `${input.teamId}/${sequenceId}/${generateId()}.png`;
            const result = await uploadResponse(
              response,
              STORAGE_BUCKETS.ELEMENTS,
              storagePath,
              { contentType: 'image/png' }
            );
            return { url: result.publicUrl, path: result.path };
          }
        );

        await step.do(`record-provenance-${index}`, async () => {
          await recordProvenance(scopedDb.provenance, {
            teamId: input.teamId,
            userId: input.userId,
            assetKind: 'element_sheet',
            assetId: entry.elementId,
            storageKey: storageResult.path,
            provider: 'fal',
            model: generationParams.model,
            providerRequestId: falUsage.requestId ?? null,
            workflowRunId: event.instanceId,
            prompt: generationParams.prompt,
            sequenceId,
          });
        });

        return await step.do(`ingest-element-${index}`, async () => {
          // Re-check inside the durable step: this step's own retry would hit
          // the primary key, and the unique (sequenceId, token) index makes a
          // race with a concurrent upload a hard failure — prefer the existing
          // row over our generated one either way.
          const raced =
            (await scopedDb.liveRead.sequenceElements.getById(
              entry.elementId
            )) ??
            (await scopedDb.liveRead.sequenceElements.getByToken(
              sequenceId,
              entry.token
            ));
          if (raced) {
            return toMinimalElement(raced);
          }

          const created = await scopedDb.sequenceElements.create({
            id: entry.elementId,
            sequenceId,
            uploadedFilename: `generated-${entry.token.toLowerCase()}.png`,
            token: entry.token,
            imageUrl: storageResult.url,
            imagePath: storageResult.path,
            // The bible entry already carries what vision would produce —
            // mark completed so the analyze-script vision gate passes on
            // regeneration runs.
            description: entry.description,
            consistencyTag: entry.consistencyTag,
            visionStatus: 'completed',
            visionGeneratedAt: new Date(),
            firstMentionSceneId: entry.firstMention.sceneId,
            firstMentionText: entry.firstMention.text,
            firstMentionLine: entry.firstMention.lineNumber,
          });

          return toMinimalElement(created);
        });
      })
    );

    // Log full rejection objects (stack traces) before the aggregate throw
    // reduces them to messages.
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'rejected') {
        logger.error(
          `[ElementSheetWorkflow:cf] Reference generation failed for ${entries[index]?.token ?? `index ${index}`}:`,
          { err: outcome.reason }
        );
      }
    }
    const elements = collectElementResults(settled, entries);

    logger.info(
      `[ElementSheetWorkflow:cf] Completed: ${elements.length}/${entries.length} element reference(s) for sequence ${sequenceId}`
    );

    return { elements };
  }

  protected override onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<ElementSheetWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): void {
    // No row to mark failed — sequence_elements rows are only created on
    // success. The parent analysis surfaces this failure to the user.
    logger.error(
      `[ElementSheetWorkflow:cf] Element reference generation failed for sequence ${event.payload.sequenceId}: ${error}`
    );
  }
}
