/**
 * Version moves (#2017): a sequence that pins an older version of a character
 * than the current one is "behind". Moving it is a pointer write
 * (`characters.moveCastToCurrent`); what it costs is shown first, as an
 * upper bound from shot counts, because the planner cannot answer "what if".
 * The exact plan and price come afterwards through the sequence's own
 * "Inputs changed" banner and Update all, which do the re-render.
 */
import {
  estimateImageCost,
  estimateVideoCost,
} from '@/billing/cost-estimation';
import { addMicros, ZERO_MICROS, type Microdollars } from '@/billing/money';
import type { EffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import {
  characterBibleChanged,
  pickCharacterBible,
} from '@/cast/server/db/bible-versions';
import { NotFoundError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { LOOK_FIELDS } from '@/platform/server/db/schema';
import { safeImageToVideoModel, safeTextToImageModel } from '@/models/models';
import { CHARACTER_SHEET_BIBLE_FIELDS } from '@/shots/input-hash';

/** Fallback clip length for video pricing; the shots' own are not read here. */
const DEFAULT_VIDEO_DURATION_SECONDS = 5;

export type VersionMovePreviewRow = {
  sequenceId: string;
  title: string;
  /** Pinned at the current versions already: nothing to move. */
  behind: boolean;
  /** Plain words for what the move changes: "age", "clothing (Gala)", "voice", "talent". */
  moved: string[];
  /** Shots wearing the character in that sequence: the re-render upper bound. */
  shotCount: number;
  /** Looks whose sheet inputs move and that have a sheet to redraw. */
  sheetCount: number;
  /** Upper-bound re-render cost (sheets, a still and a clip per shot); null when unpriced. */
  costMicros: Microdollars | null;
};

const sum = (parts: (Microdollars | null)[]): Microdollars | null =>
  parts.reduce<Microdollars | null>(
    (acc, part) => (acc == null || part == null ? null : addMicros(acc, part)),
    ZERO_MICROS
  );

/**
 * What moving each live sequence to the character's current version would
 * change and cost, at most. A sequence that is not behind is listed with
 * nothing to move, so a list can show every episode.
 */
export async function previewVersionMove(
  scopedDb: ScopedDb,
  characterId: string,
  pricing: Record<string, EffectiveFalPricing>
): Promise<VersionMovePreviewRow[]> {
  const casts = await scopedDb.characters.listCastOfCharacter(characterId);
  const rows: VersionMovePreviewRow[] = [];
  // ponytail: every behind sequence's shots and scene context are loaded in one request; page it when a character is in hundreds of episodes.
  for (const cast of casts) {
    if (!cast.behind) {
      rows.push({
        sequenceId: cast.sequenceId,
        title: cast.title,
        behind: false,
        moved: [],
        shotCount: 0,
        sheetCount: 0,
        costMicros: ZERO_MICROS,
      });
      continue;
    }
    const character = await scopedDb.characters.getById(
      cast.sequenceId,
      characterId
    );
    if (!character) throw new NotFoundError('Character not found');
    const moved: string[] = [];
    let sheetsTouched = false;
    if (character.currentBibleVersionId === null) {
      throw new Error(
        `Character ${characterId} has no current bible version to move to`
      );
    }
    if (character.selectedBibleVersionId !== character.currentBibleVersionId) {
      const current = await scopedDb.characters.getBibleVersion(
        character.currentBibleVersionId
      );
      const fields = characterBibleChanged(
        pickCharacterBible(character),
        pickCharacterBible(current)
      );
      moved.push(...fields);
      if (current.talentId !== character.talentId) moved.push('talent');
      sheetsTouched =
        current.talentId !== character.talentId ||
        fields.some((field) =>
          (CHARACTER_SHEET_BIBLE_FIELDS as readonly string[]).includes(field)
        );
    }
    if (
      character.selectedVoiceVersionId !== character.currentVoiceVersionId &&
      character.currentVoiceVersionId !== null
    ) {
      moved.push('voice');
    }
    let sheetCount = 0;
    for (const look of character.looks) {
      if (look.deletedAt) continue;
      let lookTouched = false;
      if (look.lookVersionId !== look.currentLookVersionId) {
        const versions = await scopedDb.characterLooks.listVersions(look.id);
        const current = versions.find(
          (v) => v.id === look.currentLookVersionId
        );
        if (!current) {
          throw new Error(
            `Look ${look.id} points at version ${look.currentLookVersionId}, which does not exist`
          );
        }
        const fields = LOOK_FIELDS.filter(
          (key) => (look[key] ?? null) !== (current[key] ?? null)
        );
        moved.push(
          ...fields.map((field) =>
            look.isDefault ? field : `${field} (${look.name})`
          )
        );
        lookTouched = fields.some((f) => f === 'clothing' || f === 'styling');
      }
      if ((sheetsTouched || lookTouched) && look.selectedSheetVersionId) {
        sheetCount += 1;
      }
    }
    const shotIds = await scopedDb.characters.getShotIdsForCharacter(
      cast.sequenceId,
      characterId
    );
    const sequence = await scopedDb.sequences.getForUser({
      sequenceId: cast.sequenceId,
    });
    const imageModel = safeTextToImageModel(sequence.imageModel);
    const videoModel = safeImageToVideoModel(sequence.videoModel);
    const costMicros = sum([
      sheetCount > 0
        ? estimateImageCost(imageModel, '16:9', sheetCount, { pricing })
        : ZERO_MICROS,
      shotIds.length > 0
        ? estimateImageCost(imageModel, sequence.aspectRatio, shotIds.length, {
            pricing,
            resolution: sequence.resolution,
          })
        : ZERO_MICROS,
      ...shotIds.map(() =>
        estimateVideoCost(videoModel, DEFAULT_VIDEO_DURATION_SECONDS, {
          pricing,
          resolution: sequence.resolution,
        })
      ),
    ]);
    rows.push({
      sequenceId: cast.sequenceId,
      title: cast.title,
      behind: true,
      moved: [...new Set(moved)],
      shotCount: shotIds.length,
      sheetCount,
      costMicros,
    });
  }
  return rows;
}

/**
 * Move the chosen sequences to the character's current version, one batch
 * each ("Move many"). Nothing starts a re-render: each moved sequence reads
 * stale and is updated from its own banner, so one click never launches
 * fifty runs.
 */
export async function moveCastsToCurrent(
  scopedDb: ScopedDb,
  actor: { userId: string },
  characterId: string,
  sequenceIds: readonly string[]
): Promise<{ sequenceId: string; moved: boolean }[]> {
  const results: { sequenceId: string; moved: boolean }[] = [];
  for (const sequenceId of sequenceIds) {
    const { moved } = await scopedDb.characters.moveCastToCurrent(
      sequenceId,
      characterId,
      { actorId: actor.userId }
    );
    results.push({ sequenceId, moved });
  }
  return results;
}
