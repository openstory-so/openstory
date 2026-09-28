/**
 * Automatic style derivation (#1213), run by analyze-script in parallel with
 * scene-split. Runs one billed LLM call over the snapshotted script, writes the
 * recipe onto the sequence-bound style row and the sequence's own snapshot,
 * and hands the resolved `StyleConfig` back for every child payload.
 */
import type { AnalysisModelId } from '@/models/models.config';
import type { AspectRatio } from '@/models/aspect-ratios';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { getLogger } from '@/platform/logger';
import { getGenerationChannel } from '@/platform/realtime';
import {
  autoStyleDraftFromResponse,
  autoStyleResponseSchema,
  STYLE_CATEGORIES,
  type AutoStyleDraft,
} from '@/look/auto-style';
import { STYLE_PACE_VALUES, type StyleConfig } from '@/look/style-config';
import {
  durableLLMCallCf,
  type DurableLLMCallContext,
} from '@/models/server/llm-call-helper';
import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'auto-style']);

/** The billed style call plus the two writes that store its recipe. */
type AutoStyleDb = NonNullable<DurableLLMCallContext['scopedDb']> & {
  styles: Pick<WorkflowScopedDb['styles'], 'setGeneratedForSequence'>;
  sequences: Pick<WorkflowScopedDb['sequences'], 'snapshotAutoStyle'>;
};

const _autoStyleDbAcceptsWorkflow: WorkflowScopedDb extends AutoStyleDb
  ? true
  : never = true;
void _autoStyleDbAcceptsWorkflow;

export async function deriveAutoStyle(
  step: WorkflowStep,
  params: {
    scopedDb: AutoStyleDb;
    workflowRunId: string;
    sequenceId: string;
    styleId: string;
    script: string;
    aspectRatio: AspectRatio;
    analysisModelId: AnalysisModelId;
    reservationId?: string;
  }
): Promise<StyleConfig> {
  const { scopedDb, sequenceId, styleId } = params;

  const response = await durableLLMCallCf(
    step,
    {
      name: 'automatic-style',
      phase: { number: 1, name: 'Analyzing script & deriving a style…' },
      promptName: 'phase/automatic-style-chat',
      promptVariables: {
        script: params.script,
        aspectRatio: params.aspectRatio,
        categories: STYLE_CATEGORIES.join(', '),
        paces: STYLE_PACE_VALUES.join(', '),
      },
      modelId: params.analysisModelId,
      responseSchema: autoStyleResponseSchema,
      additionalMetadata: { styleId },
      reasoning: true,
    },
    {
      sequenceId,
      workflowRunId: params.workflowRunId,
      scopedDb,
      reservationId: params.reservationId,
    }
  );

  // The LLM result is a cached durable step, so a coercion failure here replays
  // identically on every engine retry — surface it as non-retryable instead of
  // letting the instance spin.
  let draft: AutoStyleDraft;
  try {
    draft = autoStyleDraftFromResponse(response);
  } catch (error) {
    throw new NonRetryableError(
      `Automatic style for sequence ${sequenceId} was unsalvageable: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  await step.do('save-automatic-style', async () => {
    const bound = await scopedDb.styles.setGeneratedForSequence({
      styleId,
      sequenceId,
      draft,
    });
    if (!bound) {
      // Promoted between the trigger and this step — a library row must never
      // be rewritten by a run.
      throw new NonRetryableError(
        `Automatic style ${styleId} is no longer bound to sequence ${sequenceId}`
      );
    }
    // Reads the row just written in this step; scoped to the sequence still
    // pointing at this style, so a library pick made mid-run wins.
    const snapshotted = await scopedDb.sequences.snapshotAutoStyle({
      id: sequenceId,
      styleId,
    });
    if (!snapshotted) {
      logger.warn('[AutoStyle:cf] sequence re-styled mid-run; snapshot kept', {
        sequenceId,
        styleId,
      });
    }
    await getGenerationChannel(sequenceId).emit('generation.style:ready', {
      styleId,
      name: draft.name,
    });
    logger.info('[AutoStyle:cf] derived style saved', {
      sequenceId,
      styleId,
      name: draft.name,
    });
  });

  return draft.config;
}
