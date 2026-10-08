/**
 * Version moves (#2017): a sequence that pins an older version of a character
 * than the current one is "behind". Moving it is a pointer write
 * (`characters.moveCastToCurrent`); what it costs is shown first, as an
 * upper bound from shot counts, because the planner cannot answer "what if".
 * The exact plan and price come afterwards through the sequence's own
 * "Inputs changed" banner and Update all, which do the re-render.
 *
 * Every move — one sequence, many, or the ones a recast applies to — goes
 * through {@link moveSequenceToCurrent} / {@link moveCastsToCurrent} here,
 * so the access check and the voice release are the same on every path.
 */
import {
  estimateImageCost,
  estimateVideoCost,
} from '@/billing/cost-estimation';
import {
  estimateTtsCost,
  TYPICAL_DIALOGUE_CHARS_PER_SHOT,
} from '@/billing/elevenlabs-pricing';
import { addMicros, ZERO_MICROS, type Microdollars } from '@/billing/money';
import type { EffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import {
  characterBibleChanged,
  pickCharacterBible,
} from '@/cast/server/db/bible-versions';
import { effectiveStyling } from '@/cast/character-looks';
import { keepLockedCharacterAPerson } from '@/cast/server/person-lock';
import { releaseReplacedVoice } from '@/cast/server/voice/release-voice';
import { durationGridForModel } from '@/motion/model-capabilities';
import { NotFoundError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { LOOK_FIELDS } from '@/platform/server/db/schema';
import { safeImageToVideoModel, safeTextToImageModel } from '@/models/models';
import { CHARACTER_SHEET_BIBLE_FIELDS } from '@/shots/input-hash';

export type VersionMovePreviewRow = {
  sequenceId: string;
  title: string;
  /** Pinned at the current versions already: nothing to move. */
  behind: boolean;
  /** Plain words for what the move changes: "age", "clothing (Gala)", "voice", "talent". */
  moved: string[];
  /** Live looks the sequence has no cast look for yet: the move adds them, sheet-less. */
  looksToAdd: number;
  /** Shots wearing the character in that sequence: the re-render upper bound. */
  shotCount: number;
  /** Sheets the move may redraw: every look whose inputs move, and every look added. */
  sheetCount: number;
  /**
   * Upper-bound re-render cost: the sheets, a still and a clip at the video
   * model's longest length per shot, and a dialogue re-record per shot when
   * the voice moves. Null when unpriced.
   */
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
 * nothing to move, so a list can show every sequence.
 */
export async function previewVersionMove(
  scopedDb: ScopedDb,
  characterId: string,
  pricing: Record<string, EffectiveFalPricing>
): Promise<VersionMovePreviewRow[]> {
  const casts = await scopedDb.characters.listCastOfCharacter(characterId);
  const rows: VersionMovePreviewRow[] = [];
  // ponytail: every behind sequence's shots and scene context are loaded in one request; page it when a character is in hundreds of sequences.
  for (const cast of casts) {
    if (!cast.behind) {
      rows.push({
        sequenceId: cast.sequenceId,
        title: cast.title,
        behind: false,
        moved: [],
        looksToAdd: 0,
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
    // The legacy features of the bible version the move lands on (#2065):
    // the default look's styling there is its own joined with them.
    let featuresAfter = character.legacyDistinguishingFeatures;
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
      featuresAfter = current.legacyDistinguishingFeatures;
      if (current.talentId !== character.talentId) moved.push('talent');
      sheetsTouched =
        current.talentId !== character.talentId ||
        fields.some((field) =>
          (CHARACTER_SHEET_BIBLE_FIELDS as readonly string[]).includes(field)
        );
    }
    const voiceMoved =
      character.selectedVoiceVersionId !== character.currentVoiceVersionId;
    if (voiceMoved) moved.push('voice');
    // Every look the move may redraw: one whose own inputs move, every one
    // when a sheet input of the bible moves (a pointer-less legacy sheet
    // counts: it has a sheet to redraw), and every look the move adds.
    let sheetCount = cast.looksToAdd;
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
        // As the look read resolves it, on both sides.
        const after = {
          ...current,
          styling: look.isDefault
            ? effectiveStyling(current.styling, featuresAfter)
            : current.styling,
        };
        const fields = LOOK_FIELDS.filter(
          (key) => (look[key] ?? null) !== (after[key] ?? null)
        );
        moved.push(
          ...fields.map((field) =>
            look.isDefault ? field : `${field} (${look.name})`
          )
        );
        lookTouched = fields.some((f) => f === 'clothing' || f === 'styling');
      }
      if (sheetsTouched || lookTouched) sheetCount += 1;
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
    // The longest clip the sequence's video model renders: the shots' own
    // lengths are not read here, so every shot is priced at the top.
    const longestClipSeconds = Math.max(...durationGridForModel(videoModel));
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
        estimateVideoCost(videoModel, longestClipSeconds, {
          pricing,
          resolution: sequence.resolution,
        })
      ),
      // A voice move re-records every shot's lines.
      voiceMoved
        ? estimateTtsCost(shotIds.length * TYPICAL_DIALOGUE_CHARS_PER_SHOT)
        : ZERO_MICROS,
    ]);
    rows.push({
      sequenceId: cast.sequenceId,
      title: cast.title,
      behind: true,
      moved: [...new Set(moved)],
      looksToAdd: cast.looksToAdd,
      shotCount: shotIds.length,
      sheetCount,
      costMicros,
    });
  }
  return rows;
}

/**
 * Every named sequence must be the team's (the check
 * `sequenceAccessMiddleware` / `productionAccess` make) and must cast the
 * character through a live link. An id outside that set refuses the whole
 * call with NotFoundError. Called before anything is written, so a many-
 * sequence move and a range recast never move some and stop.
 */
export async function assertMovableSequences(
  scopedDb: ScopedDb,
  characterId: string,
  sequenceIds: readonly string[]
): Promise<void> {
  const live = new Set(
    (await scopedDb.characters.listCastOfCharacter(characterId)).map(
      (cast) => cast.sequenceId
    )
  );
  for (const sequenceId of sequenceIds) {
    if (
      !live.has(sequenceId) ||
      (await scopedDb.sequences.getById(sequenceId)) === null
    ) {
      throw new NotFoundError('Sequence not found');
    }
  }
}

/**
 * Before any sequence moves to the current version (#2065): the lock is the
 * character's, in every sequence, so a sequence whose sheet is a real
 * person's photo must not land on a version stored as not a person. A
 * locked character's current version is written a person first, and the
 * move goes to that.
 */
async function keepCurrentVersionAPerson(
  scopedDb: ScopedDb,
  actor: { userId: string },
  characterId: string
): Promise<void> {
  const current = await scopedDb.characters.getCurrent(characterId);
  if (current) {
    await keepLockedCharacterAPerson(scopedDb, actor, null, current);
  }
}

/**
 * Move ONE sequence to the character's current version ("Update this
 * sequence"): the pointer write, then the release of the voice its pin let
 * go of, when nothing holds it any more (`releaseReplacedVoice`: provider
 * first, row second; a failed release is logged and the id stays on its
 * history row for a later release to retry). Nothing starts a re-render.
 */
export async function moveSequenceToCurrent(
  scopedDb: ScopedDb,
  actor: { userId: string },
  sequenceId: string,
  characterId: string
): Promise<{ moved: boolean }> {
  const before = await scopedDb.characters.getById(sequenceId, characterId);
  if (!before) throw new NotFoundError('Character not found');
  await keepCurrentVersionAPerson(scopedDb, actor, characterId);
  const { moved, character } = await scopedDb.characters.moveCastToCurrent(
    sequenceId,
    characterId,
    { actorId: actor.userId }
  );
  if (moved) {
    await releaseReplacedVoice(scopedDb, before.voiceId, character.voiceId);
  }
  return { moved };
}

/**
 * Move the chosen sequences to the character's current version in ONE
 * batch ("Move sequences", and what a range recast applies): a failure
 * part-way moves none. Every id is checked first
 * ({@link assertMovableSequences}); the voices the pins let go of are
 * released after the batch. Nothing starts a re-render: each moved sequence
 * reads stale and is updated from its own banner, so one click never
 * launches fifty runs.
 */
export async function moveCastsToCurrent(
  scopedDb: ScopedDb,
  actor: { userId: string },
  characterId: string,
  sequenceIds: readonly string[]
): Promise<{ sequenceId: string; moved: boolean }[]> {
  await assertMovableSequences(scopedDb, characterId, sequenceIds);
  await keepCurrentVersionAPerson(scopedDb, actor, characterId);
  const moves = await scopedDb.characters.moveCastsToCurrent(
    sequenceIds,
    characterId,
    { actorId: actor.userId }
  );
  for (const move of moves) {
    if (move.moved) {
      await releaseReplacedVoice(
        scopedDb,
        move.before.voiceId,
        move.character.voiceId
      );
    }
  }
  return moves.map(({ sequenceId, moved }) => ({ sequenceId, moved }));
}
