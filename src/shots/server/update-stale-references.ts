import { reusesTalentSheet } from '@/cast/server/talent/reuse-talent-sheet';
/**
 * The references wave of a plan run (#1818): the sheets, element references
 * and voices a continue owes, each as the payload its per-entity workflow
 * takes — built HERE, at the click, from the same builders the cast page's
 * regenerate buttons use. The run takes the claims and spawns; it never reads
 * the rows these came from.
 */

import {
  buildCharacterSheetDraft,
  buildRegenerateCharacterSheetPayload,
} from '@/cast/server/sheets/character-sheet-trigger';
import type { CharacterSheetDraft } from '@/cast/server/workflows/sheet-snapshots';
import {
  computeCharacterSheetHashFromDtoBefore2065,
  finishCharacterSheetPayload,
} from '@/cast/server/workflows/sheet-snapshots';
import { characterSheetInputHash } from '@/shots/input-hash';
import type {
  CharacterSheetInputHash,
  LegacyStylingParts,
} from '@/shots/input-hash';
import { buildRegenerateLocationSheetPayload } from '@/cast/server/sheets/location-sheet-trigger';
import {
  characterToBible,
  legacyStylingParts,
} from '@/cast/server/bibles-from-scoped';
import { wearLook } from '@/cast/character-looks';
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

/**
 * A sheet the plan reuses instead of drawing (#2017): a finished sheet of
 * the same look, by the same model, from the same inputs, that some sequence
 * of the team already has. The run points this sequence's cast look at that
 * row through the ordinary claim; nothing is generated and nothing is copied.
 */
export type ReusedCharacterSheet = {
  /** The payload a draw would have taken — what the hash was computed from. */
  payload: Omit<CharacterSheetWorkflowInput, 'sheetVersionId'>;
  /** The `character_sheet_variants` row to point at. */
  sheetVersionId: string;
  /**
   * The digest that row is stamped with: the payload's own, or the
   * `pre-2065` shape of the same inputs for a sheet drawn before #2065. The
   * run's adopt is conditional on the row still carrying it.
   */
  matchedInputHash: CharacterSheetInputHash;
  url: string;
  storagePath: string;
};

export type PlanReferences = {
  characterSheets: Omit<CharacterSheetWorkflowInput, 'sheetVersionId'>[];
  /** Sheets found finished elsewhere and priced at zero (#2017). */
  reusedSheets: ReusedCharacterSheet[];
  /**
   * Looks other than the default whose default sheet this run also makes
   * (#2015): the second references wave. Each is a draft with no face; the
   * run finishes it with the default sheet it lands, so one run makes every
   * look a script uses.
   */
  lookSheetsAfterDefault: CharacterSheetDraft[];
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

  // A `sheet:character` unit names a LOOK (#2015): one sheet per look some
  // scene uses. A character an older worker wrote has no look row yet; its
  // default look answers to the character's own id (`lookId`).
  const owedLooks = characters
    .filter((c) => !c.voiceOnly)
    .flatMap((character) =>
      (character.looks.length > 0
        ? character.looks.map((look) => wearLook(character, look))
        : [character]
      )
        .filter((dressed) => sheetIds.has(dressed.lookId))
        .map((dressed) => ({ character, dressed }))
    );
  // A look other than the default is drawn from the default look's sheet.
  // When this run makes that sheet too, the look waits for it: drafted here,
  // finished with the sheet the run lands (`lookSheetsAfterDefault`).
  const afterDefault = ({ character, dressed }: (typeof owedLooks)[number]) =>
    dressed.lookId !== character.id && sheetIds.has(character.id);
  // A finished sheet of the look from the same inputs, in any sequence of
  // the team, is pointed at instead of drawn (#2017). Decided here, by id;
  // the run adopts that id through the claim. Wins over the talent copy: it
  // is the look's own sheet in this style.
  const characterSheets: Omit<CharacterSheetWorkflowInput, 'sheetVersionId'>[] =
    [];
  const reusedSheets: ReusedCharacterSheet[] = [];
  const reuseOrDraw = async (
    payload: Omit<CharacterSheetWorkflowInput, 'sheetVersionId'>,
    /** The look's stored parts, for the digest a pre-#2065 sheet carries. */
    legacy: LegacyStylingParts
  ) => {
    const find = (inputHash: CharacterSheetInputHash) =>
      scopedDb.characterSheetVariants.findReusable({
        lookId: payload.lookId,
        model: payload.imageModel ?? DEFAULT_IMAGE_MODEL,
        inputHash,
      });
    let matchedInputHash = payload.snapshotInputHash;
    let existing = await find(matchedInputHash);
    if (!existing) {
      // A sheet drawn before #2065 is stamped in the `pre-2065` shape: the
      // same inputs, so the same image, and a live verify reads it fresh.
      // Missing it would redraw every such sheet once (credits, and a
      // BytePlus portrait slot each). Delete with `LEGACY_HASH_UNTIL`.
      matchedInputHash = characterSheetInputHash(
        await computeCharacterSheetHashFromDtoBefore2065(payload, legacy)
      );
      existing = await find(matchedInputHash);
    }
    if (existing) {
      reusedSheets.push({
        payload,
        sheetVersionId: existing.id,
        matchedInputHash,
        url: existing.url,
        storagePath: existing.storagePath,
      });
    } else {
      characterSheets.push(payload);
    }
    return existing;
  };
  // Default look → the face its other looks are drawn from, when reused.
  const reusedDefaults = new Map<string, { url: string; versionId: string }>();
  await Promise.all(
    owedLooks
      .filter((owed) => !afterDefault(owed))
      .map(async ({ character, dressed }) => {
        const payload = await buildRegenerateCharacterSheetPayload({
          ...context,
          character,
          lookId: dressed.lookId,
        });
        // A first sheet of the default look can copy the matched talent.
        // Any other look is drawn from the default look's sheet, never
        // from the talent image. An existing sheet's regeneration must
        // apply the edited look instead.
        if (
          dressed.lookId === character.id &&
          !dressed.selectedSheetVersionId
        ) {
          payload.reuseTalentSheet = reusesTalentSheet(dressed, {
            sheetImageUrl: payload.referenceImageUrl,
            sheetMetadata: payload.talentMetadata,
            talentDescription: payload.castTalentDescription,
          });
        }
        const existing = await reuseOrDraw(
          payload,
          legacyStylingParts(dressed)
        );
        if (existing && dressed.lookId === character.id) {
          reusedDefaults.set(character.id, {
            url: existing.url,
            versionId: existing.id,
          });
        }
      })
  );
  // A look whose default sheet this run REUSES has its face now: it is
  // finished here and checked for reuse like the rest, so a series whose
  // default is reused reuses its other looks too. One whose default this
  // run draws waits for it.
  const lookSheetsAfterDefault: CharacterSheetDraft[] = [];
  await Promise.all(
    owedLooks.filter(afterDefault).map(async ({ character, dressed }) => {
      const { draft } = await buildCharacterSheetDraft({
        ...context,
        character,
        lookId: dressed.lookId,
      });
      const face = reusedDefaults.get(character.id);
      if (face) {
        await reuseOrDraw(
          await finishCharacterSheetPayload(draft, face),
          legacyStylingParts(dressed)
        );
      } else lookSheetsAfterDefault.push(draft);
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
      characterSheets:
        characterSheets.filter((sheet) => !sheet.reuseTalentSheet).length +
        lookSheetsAfterDefault.length,
      locationSheets: locationSheets.length,
      elementSheets: owedElements.length,
      pricing: await getEffectiveFalPricing(),
    }),
    voices: multiplyMicros(VOICE_ESTIMATE_COST, voices.length),
  };

  return {
    characterSheets,
    reusedSheets,
    lookSheetsAfterDefault,
    locationSheets,
    elementSheets,
    voices,
    cost,
  };
}
