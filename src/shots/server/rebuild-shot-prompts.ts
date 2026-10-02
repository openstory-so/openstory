/**
 * Rebuild a shot's still and motion prompts from its spec (#1923).
 * Derivation is pure — no LLM. A written (`user-edit`) side is left alone.
 * Completes pending claims in place; a manual regenerate writes through
 * `prompt-variants.fn.ts` instead.
 */

import type { StyleConfig } from '@/platform/server/db/schema/libraries';
import type { FramePromptVersion } from '@/platform/server/db/schema/frame-prompt-versions';
import type { ShotPromptVersion } from '@/platform/server/db/schema/shot-prompt-versions';
import {
  hashMotionPromptInput,
  hashVisualPromptInput,
  type MotionPromptHashInput,
  type MotionPromptInputHash,
  type VisualPromptInputHash,
} from '@/shots/input-hash';
import { narrowShotPromptContext } from '@/shots/server/prompt-context';
import type {
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
  MotionDialogue,
  Scene,
} from '@/shots/scene-analysis.schema';
import {
  deriveMotionPrompt,
  deriveStillPrompt,
} from '@/shots/shot-list.derive';
import type { StoredShotSpec } from '@/shots/shot-list.schema';

type CompleteVisual = {
  versionId: string;
  frameId: string;
  text: string;
  inputHash?: VisualPromptInputHash;
  stampHash?: VisualPromptInputHash;
  analysisModel: string;
  source?: 'derived';
  specVersionId?: string;
};

type CompleteMotion = {
  versionId: string;
  shotId: string;
  text: string;
  audio?: { ambientSound: string; soundEffects: string[] } | null;
  usesStartFrame: boolean;
  inputHash?: MotionPromptInputHash;
  stampHash?: MotionPromptInputHash;
  analysisModel: string;
  source?: 'derived';
  specVersionId?: string;
};

export type DerivedPromptDb = {
  framePromptVersions: {
    completePendingAiVersion: (
      input: CompleteVisual
    ) => Promise<FramePromptVersion | null>;
  };
  shotPromptVersions: {
    completePendingAiVersion: (
      input: CompleteMotion
    ) => Promise<ShotPromptVersion | null>;
  };
  shotSpecVersions: {
    stampInputHashIfEmpty: (
      versionId: string,
      inputHash: string
    ) => Promise<void>;
  };
};

export type CompleteDerivedPromptsInput = {
  spec: StoredShotSpec;
  specVersionId: string;
  scene: Scene;
  styleConfig: StyleConfig;
  characterBible: readonly CharacterBibleEntry[];
  locationBible: readonly LocationBibleEntry[];
  elementBible: readonly ElementBibleEntry[];
  aspectRatio: string;
  analysisModel: string;
  dialogue: MotionDialogue;
  referenceOnly: boolean;
  frameId: string | null;
  shotId: string;
  visualClaimId: string | null;
  motionClaimId: string | null;
  visualWritten: boolean;
  motionWritten: boolean;
  /** Fills a null currency stamp on the spec row. A set stamp is left alone. */
  currencyHash?: string | null;
  /**
   * Rewrite stamps the digest of the spec it just wrote. Rebuild leaves this
   * unset so the claim's pending hash (the spec the click saw) wins.
   */
  stampHashes?: boolean;
};

export async function completeDerivedPrompts(
  db: DerivedPromptDb,
  input: CompleteDerivedPromptsInput
): Promise<{
  visualVersionId: string | null;
  motionVersionId: string | null;
}> {
  if (input.currencyHash) {
    await db.shotSpecVersions.stampInputHashIfEmpty(
      input.specVersionId,
      input.currencyHash
    );
  }

  const narrowed = narrowShotPromptContext({
    scene: input.scene,
    styleConfig: input.styleConfig,
    characterBible: input.characterBible,
    locationBible: input.locationBible,
    elementBible: input.elementBible,
    aspectRatio: input.aspectRatio,
    analysisModel: input.analysisModel,
    startingFrameImageUrl: null,
    dialogue: input.dialogue,
    referenceOnly: input.referenceOnly,
    spec: input.spec,
  } satisfies MotionPromptHashInput);

  const visualHash = await hashVisualPromptInput(narrowed);
  const motionHash = await hashMotionPromptInput(narrowed);
  const stamp = input.stampHashes === true;

  let visualVersionId: string | null = null;
  const writeStill =
    !input.referenceOnly &&
    !input.visualWritten &&
    input.frameId !== null &&
    input.visualClaimId !== null;
  if (writeStill && input.frameId && input.visualClaimId) {
    const completed = await db.framePromptVersions.completePendingAiVersion({
      versionId: input.visualClaimId,
      frameId: input.frameId,
      text: deriveStillPrompt(input.spec, input.scene, input.styleConfig),
      inputHash: visualHash,
      ...(stamp ? { stampHash: visualHash } : {}),
      analysisModel: input.analysisModel,
      source: 'derived',
      specVersionId: input.specVersionId,
    });
    visualVersionId = completed?.id ?? null;
  }

  let motionVersionId: string | null = null;
  if (!input.motionWritten && input.motionClaimId) {
    const motion = deriveMotionPrompt(input.spec, {
      referenceOnly: input.referenceOnly,
    });
    const completed = await db.shotPromptVersions.completePendingAiVersion({
      versionId: input.motionClaimId,
      shotId: input.shotId,
      text: motion.text,
      audio: motion.audio,
      usesStartFrame: !input.referenceOnly,
      inputHash: motionHash,
      ...(stamp ? { stampHash: motionHash } : {}),
      analysisModel: input.analysisModel,
      source: 'derived',
      specVersionId: input.specVersionId,
    });
    motionVersionId = completed?.id ?? null;
  }

  return { visualVersionId, motionVersionId };
}
