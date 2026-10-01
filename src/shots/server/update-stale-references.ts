import { reusesTalentSheet } from '@/cast/server/talent/reuse-talent-sheet';
/**
 * The references wave of a plan run (#1818): the sheets, element references
 * and voices a continue owes, each as the payload its per-entity workflow
 * takes — built HERE, at the click, from the same builders the cast page's
 * regenerate buttons use. The run takes the claims and spawns; it never reads
 * the rows these came from.
 */

import { buildRegenerateCharacterSheetPayload } from '@/cast/server/sheets/character-sheet-trigger';
import { buildRegenerateLocationSheetPayload } from '@/cast/server/sheets/location-sheet-trigger';
import { characterToBible } from '@/cast/server/bibles-from-scoped';
import { resolveSequenceStyleConfig } from '@/look/style-config';
import { SEED_VOICE_DEFAULT_TAKES } from '@/cast/seed-voice';
import { newVoiceProvider } from '@/models/server/seed-speech-config';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/models/models.config';
import { DEFAULT_IMAGE_MODEL, safeTextToImageModel } from '@/models/models';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence } from '@/platform/server/db/schema';
import type {
  CharacterSheetWorkflowInput,
  CharacterVoiceWorkflowInput,
  ElementSheetWorkflowInput,
  LocationSheetWorkflowInput,
} from '@/platform/server/workflow/types';
import type { PlanUnitRef } from '@/sequences/generation-plan';
import { estimateReferenceSheetCost } from '@/billing/cost-estimation';
import { VOICE_ESTIMATE_COST } from '@/billing/elevenlabs-pricing';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { multiplyMicros, type Microdollars } from '@/billing/money';

export type PlanReferences = {
  characterSheets: Omit<CharacterSheetWorkflowInput, 'sheetVersionId'>[];
  locationSheets: Omit<LocationSheetWorkflowInput, 'referenceVersionId'>[];
  /** Null when no element reference is owed. */
  elementSheets: ElementSheetWorkflowInput | null;
  voices: Omit<CharacterVoiceWorkflowInput, 'targetVersionId'>[];
  /**
   * The wave's price at the click. Its children have no preflight of their
   * own, so the run checks the balance against this before it spawns them.
   * Split because a team's fal key pays for sheets, never for voices.
   */
  cost: { sheets: Microdollars; voices: Microdollars };
};

export async function buildPlanReferences(args: {
  scopedDb: ScopedDb;
  sequence: Sequence;
  userId: string;
  units: readonly PlanUnitRef[];
}): Promise<PlanReferences | null> {
  const { scopedDb, sequence, userId, units } = args;
  const idsOf = (kind: PlanUnitRef['kind']) =>
    new Set(units.filter((u) => u.kind === kind).map((u) => u.id));
  const sheetIds = idsOf('sheet:character');
  const voiceIds = idsOf('voice');
  const locationIds = idsOf('sheet:location');
  const elementIds = idsOf('ref:element');
  if (
    sheetIds.size + voiceIds.size + locationIds.size + elementIds.size ===
    0
  ) {
    return null;
  }

  const [characters, locations, elements] = await Promise.all([
    sheetIds.size + voiceIds.size > 0
      ? scopedDb.characters.list(sequence.id)
      : Promise.resolve([]),
    locationIds.size > 0
      ? scopedDb.sequenceLocations.list(sequence.id)
      : Promise.resolve([]),
    elementIds.size > 0
      ? scopedDb.sequenceElements.list(sequence.id)
      : Promise.resolve([]),
  ]);
  const context = {
    scopedDb,
    userId,
    teamId: scopedDb.teamId,
    sequence,
  };

  const characterSheets = await Promise.all(
    characters
      .filter((c) => sheetIds.has(c.id) && !c.voiceOnly)
      .map(async (character) => {
        const payload = await buildRegenerateCharacterSheetPayload({
          ...context,
          character,
        });
        // A first sheet can copy the matched talent. An existing sheet's
        // regeneration must apply the edited bible instead.
        if (!character.selectedSheetVersionId) {
          payload.reuseTalentSheet = reusesTalentSheet(character, {
            sheetImageUrl: payload.referenceImageUrl,
            sheetMetadata: payload.talentMetadata,
            talentDescription: payload.castTalentDescription,
          });
        }
        return payload;
      })
  );
  const locationSheets = await Promise.all(
    locations
      .filter((l) => locationIds.has(l.id))
      .map((location) =>
        buildRegenerateLocationSheetPayload({ ...context, location })
      )
  );

  const owedElements = elements.filter((el) => elementIds.has(el.id));
  let elementSheets: ElementSheetWorkflowInput | null = null;
  if (owedElements.length > 0) {
    const style =
      sequence.styleConfig == null && sequence.styleId
        ? await scopedDb.styles.getById(sequence.styleId)
        : null;
    elementSheets = {
      userId,
      teamId: scopedDb.teamId,
      sequenceId: sequence.id,
      entries: owedElements.map((el) => ({
        elementId: el.id,
        token: el.token,
        description: el.description ?? '',
        consistencyTag: el.consistencyTag ?? '',
        firstMention: {
          sceneId: el.firstMentionSceneId ?? '',
          text: el.firstMentionText ?? '',
          lineNumber: el.firstMentionLine ?? 0,
        },
      })),
      imageModel: safeTextToImageModel(
        sequence.imageModel,
        DEFAULT_IMAGE_MODEL
      ),
      styleConfig:
        sequence.styleConfig != null || style
          ? resolveSequenceStyleConfig({
              snapshot: sequence.styleConfig,
              live: style?.config,
            })
          : undefined,
    };
  }

  const analysisModelId =
    getAnalysisModelById(sequence.analysisModel)?.id ?? DEFAULT_ANALYSIS_MODEL;
  const voices = characters
    .filter((c) => voiceIds.has(c.id))
    .map((character): Omit<CharacterVoiceWorkflowInput, 'targetVersionId'> => ({
      userId,
      teamId: scopedDb.teamId,
      sequenceId: sequence.id,
      characterDbId: character.id,
      characterBible: characterToBible(character),
      voiceDescription: character.voiceDescription ?? '',
      analysisModelId,
      voiceProvider: newVoiceProvider(),
      takes: SEED_VOICE_DEFAULT_TAKES,
    }));

  const cost = {
    sheets: estimateReferenceSheetCost({
      imageModel: safeTextToImageModel(
        sequence.imageModel,
        DEFAULT_IMAGE_MODEL
      ),
      characterSheets: characterSheets.filter(
        (sheet) => !sheet.reuseTalentSheet
      ).length,
      locationSheets: locationSheets.length,
      elementSheets: owedElements.length,
      pricing: await getEffectiveFalPricing(),
    }),
    voices: multiplyMicros(VOICE_ESTIMATE_COST, voices.length),
  };

  return { characterSheets, locationSheets, elementSheets, voices, cost };
}
