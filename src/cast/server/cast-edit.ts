/**
 * Cast edits shared by the editor's server fns and the MCP tools (#1979):
 * characters, locations and elements of one sequence — create, bible edits,
 * soft delete / restore, voice switch and history, sheet version picks,
 * element description and token. No generation starts here.
 *
 * Every function takes the sequence id the caller authorised and refuses a
 * row of another sequence (live or soft-deleted rows both pass, so restore
 * can reach them). The `…TeamCharacter…` ones are the Characters page's
 * (#2065): no sequence, scoped to the team.
 */
import { renderingOfStyle } from '@/cast/rendering';
import { resolveSequenceStyle } from '@/cast/server/sheets/sequence-style';
import type { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import { castChannelId } from '@/cast/cast-channel';
import { getGenerationChannel } from '@/platform/realtime';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type {
  CastCharacterWithSheet,
  CharacterWithSheet,
} from '@/platform/server/db/schema';
import {
  requireCharacterLook,
  requireLiveLook,
} from '@/cast/server/character-look';
import type { CharacterBibleUpdate } from '@/cast/server/db/characters';
import type { LocationBibleUpdate } from '@/cast/server/db/sequence-locations';
import {
  identityToken,
  nextIdentityToken,
  slugifyTag,
  type characterBibleFieldsSchema,
  type locationBibleFieldsSchema,
} from '@/cast/bible-field';
import { effectiveStyling } from '@/cast/character-looks';
import {
  keepLockedCharacterAPerson,
  lockedPersonEdit,
  requirePersonEditStillAllowed,
} from '@/cast/server/person-lock';
import { LOOK_TEXT_MAX } from '@/cast/look-field';
import { deriveTokenFromFilename } from '@/cast/derive-token';
import {
  releaseCharacterVoice,
  releaseReplacedVoice,
} from '@/cast/server/voice/release-voice';

const logger = getLogger(['openstory', 'cast', 'cast-edit']);

type Actor = { userId: string };
type CharacterBibleFields = z.output<typeof characterBibleFieldsSchema>;
type LocationBibleFields = z.output<typeof locationBibleFieldsSchema>;
/** The deprecated input the API and MCP may still send (#2065). */
type LegacyFeaturesInput = Pick<CharacterBibleFields, 'distinguishingFeatures'>;

/** Realtime emits only bust caches; a failed one must not fail the write. */
async function emitQuietly(emit: () => Promise<unknown>) {
  try {
    await emit();
  } catch (error) {
    logger.error('realtime emit failed', { err: error });
  }
}

// ── Characters ──────────────────────────────────────────────────────────────

/**
 * `distinguishingFeatures` on a character input (#2065, kept for the API and
 * MCP): the default look's styling owns that text, so it is appended there
 * unless the styling already holds it. Blank is ignored: there is no field
 * left to clear. `sequenceId` null writes the look's current version.
 * Refused when the joined text would pass the look's own limit: this write
 * does not go through `lookFieldsSchema`, and repeated calls would otherwise
 * grow the styling without bound.
 */
async function foldFeaturesIntoDefaultLook(
  scopedDb: Pick<ScopedDb, 'characterLooks'>,
  actor: Actor,
  sequenceId: string | null,
  defaultLook: { id: string; styling: string | null },
  features: string | null | undefined
): Promise<void> {
  const text = features?.trim();
  // Already there: one of the styling's lines, wherever an earlier call put
  // it. Whole lines, so "scar" is not held by "red scarf".
  if (!text || `\n${defaultLook.styling ?? ''}\n`.includes(`\n${text}\n`)) {
    return;
  }
  const styling = effectiveStyling(defaultLook.styling, text);
  if (styling !== null && styling.length > LOOK_TEXT_MAX) {
    throw new ValidationError(
      `Hair, makeup, injuries would pass ${LOOK_TEXT_MAX} characters. Edit the default look instead.`
    );
  }
  const opts = { source: 'edit' as const, actorId: actor.userId };
  if (sequenceId === null) {
    await scopedDb.characterLooks.update(
      null,
      defaultLook.id,
      { styling },
      opts
    );
  } else {
    await scopedDb.characterLooks.update(
      sequenceId,
      defaultLook.id,
      { styling },
      opts
    );
  }
}

/** The default look of a character read; every character has one. */
function defaultLookOf<
  L extends { id: string; isDefault: boolean },
>(character: { id: string; looks: readonly L[] }): L {
  const look = character.looks.find((candidate) => candidate.isDefault);
  if (!look) throw new Error(`Character ${character.id} has no default look`);
  return look;
}

/**
 * The character, when it belongs to this sequence (live or soft-deleted),
 * or, from no sequence (null), one of the team's at its current version
 * (#2017). Only a read through a sequence carries the link.
 */
export async function requireCharacter(
  scopedDb: Pick<ScopedDb, 'characters'>,
  sequenceId: string,
  characterId: string
): Promise<CastCharacterWithSheet>;
export async function requireCharacter(
  scopedDb: Pick<ScopedDb, 'characters'>,
  sequenceId: string | null,
  characterId: string
): Promise<CharacterWithSheet>;
export async function requireCharacter(
  scopedDb: Pick<ScopedDb, 'characters'>,
  sequenceId: string | null,
  characterId: string
): Promise<CharacterWithSheet> {
  const character =
    sequenceId === null
      ? await scopedDb.characters.getCurrent(characterId)
      : await scopedDb.characters.getById(sequenceId, characterId);
  if (!character) throw new NotFoundError('Character not found');
  return character;
}

/**
 * Create a character by hand (no storyboard run) — starts sheet-less
 * (`sheetStatus: 'pending'`). `characterId` is a shortened name
 * (`char_maya`) uniqued against existing rows on the `(sequenceId,
 * characterId)` index, which covers soft-deleted rows too.
 */
export async function createCharacter(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  {
    name,
    distinguishingFeatures,
    ...bible
  }: CharacterBibleFields & { name: string }
) {
  const base = identityToken('char', name);
  const taken = new Set<string>();
  let characterId = base;
  while (await scopedDb.characters.getByCharacterId(sequenceId, characterId)) {
    taken.add(characterId);
    characterId = nextIdentityToken(base, taken);
  }
  // Rendered as the sequence's style says, unless the caller said (#2017).
  const sequence = await scopedDb.sequences.getById(sequenceId);
  if (!sequence) throw new NotFoundError('Sequence not found');
  const rendering =
    bible.rendering ??
    renderingOfStyle(await resolveSequenceStyle(scopedDb, sequence));
  const character = await scopedDb.characters.create(
    {
      sequenceId,
      characterId,
      name,
      ...bible,
      rendering,
      consistencyTag:
        bible.consistencyTag ?? `${characterId}: ${slugifyTag(name)}`,
      sheetStatus: 'pending',
    },
    { source: 'edit', createdBy: actor.userId }
  );
  await foldFeaturesIntoDefaultLook(
    scopedDb,
    actor,
    sequenceId,
    defaultLookOf(character),
    distinguishingFeatures
  );
  await scopedDb.sequenceEvents.record({
    sequenceId,
    actorId: actor.userId,
    kind: 'character.created',
    targetType: 'character',
    targetId: character.id,
    summary: `Added character ${name}`,
    data: { name, characterId },
  });
  return character;
}

/**
 * Make a character with no sequence (#2065, the Characters page). It has a
 * bible and a default look and nothing else: a sequence casts it later with
 * `@` or Add Character, and draws its sheet and designs its voice
 * then, so no voice field is taken here. No event is recorded: events are
 * per sequence.
 */
export async function createTeamCharacter(
  scopedDb: ScopedDb,
  actor: Actor,
  {
    name,
    standardClothing,
    distinguishingFeatures,
    ...bible
  }: Omit<CharacterBibleFields, 'voiceDescription'> & { name: string }
) {
  const character = await scopedDb.characters.createForTeam(
    {
      name,
      ...bible,
      rendering: bible.rendering ?? null,
      standardClothing: standardClothing ?? null,
      // {@link createCharacter} prefixes the tag with the sequence's script
      // id. With no sequence there is none, so the prefix is the id a
      // hand-added character would get from the same name.
      consistencyTag:
        bible.consistencyTag ??
        `${identityToken('char', name)}: ${slugifyTag(name)}`,
    },
    { createdBy: actor.userId }
  );
  if (!distinguishingFeatures?.trim()) return character;
  await foldFeaturesIntoDefaultLook(
    scopedDb,
    actor,
    null,
    defaultLookOf(character),
    distinguishingFeatures
  );
  return await requireCurrentCharacter(scopedDb, character.id);
}

async function requireCurrentCharacter(
  scopedDb: Pick<ScopedDb, 'characters'>,
  characterId: string
) {
  const character = await scopedDb.characters.getCurrent(characterId);
  if (!character) throw new NotFoundError('Character not found');
  return character;
}

/**
 * Edit the bible of a character from no sequence (#2065): a new version and
 * the character's current pointer. A sequence that casts it keeps the
 * version it pinned and reads "not the current version".
 */
export async function updateTeamCharacter(
  scopedDb: ScopedDb,
  actor: Actor,
  characterId: string,
  {
    distinguishingFeatures,
    ...update
  }: CharacterBibleUpdate & LegacyFeaturesInput
) {
  const before = await requireCurrentCharacter(scopedDb, characterId);
  const character = await scopedDb.characters.updateBible(
    null,
    characterId,
    await lockedPersonEdit(scopedDb, update, before),
    { actorId: actor.userId, source: 'edit' }
  );
  await requirePersonEditStillAllowed(scopedDb, update, character, () =>
    scopedDb.characters.updateBible(
      null,
      characterId,
      { isPerson: true },
      { actorId: actor.userId, source: 'edit' }
    )
  );
  if (!distinguishingFeatures?.trim()) return character;
  await foldFeaturesIntoDefaultLook(
    scopedDb,
    actor,
    null,
    defaultLookOf(character),
    distinguishingFeatures
  );
  return await requireCurrentCharacter(scopedDb, characterId);
}

/**
 * Cast a team character into a sequence (#2050): the `@` picker and the
 * cast panel's Add Character. One link pinning her current version, a cast
 * look per look; nothing is copied and no generation starts. Refused while a
 * live cast member has her name (`characters.attach`).
 */
export async function attachLibraryCharacter(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  characterId: string
) {
  return await scopedDb.characters.attach(sequenceId, characterId, {
    actorId: actor.userId,
  });
}

/**
 * Edit a character's bible fields. Only the sent fields change; the sheet and
 * prompts that project them re-stale by hash derivation. `isPerson: false`
 * is refused while the character must be a person, and any other edit of
 * such a character writes a person (#2065, `person-lock.ts`).
 */
export async function updateCharacter(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  characterId: string,
  {
    distinguishingFeatures,
    ...update
  }: CharacterBibleUpdate & LegacyFeaturesInput
) {
  const before = await requireCharacter(scopedDb, sequenceId, characterId);
  const character = await scopedDb.characters.updateBible(
    sequenceId,
    characterId,
    await lockedPersonEdit(scopedDb, update, before),
    {
      actorId: actor.userId,
      source: 'edit',
    }
  );
  await requirePersonEditStillAllowed(scopedDb, update, character, () =>
    scopedDb.characters.updateBible(
      sequenceId,
      characterId,
      { isPerson: true },
      { actorId: actor.userId, source: 'edit' }
    )
  );
  await foldFeaturesIntoDefaultLook(
    scopedDb,
    actor,
    sequenceId,
    defaultLookOf(before),
    distinguishingFeatures
  );
  return character;
}

/**
 * Soft-remove a character from the sequence (undoable). Scene continuity
 * tags are kept, so a restore is lossless. The character, its voice
 * included, is the team's and stays as it is (#2017).
 */
export async function deleteCharacter(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  characterId: string
) {
  const existing = await requireCharacter(scopedDb, sequenceId, characterId);
  const deletedAt = await scopedDb.characters.softDelete(
    sequenceId,
    characterId,
    { actorId: actor.userId }
  );
  return { characterId, name: existing.name, deletedAt };
}

export async function restoreCharacter(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  characterId: string
) {
  await requireCharacter(scopedDb, sequenceId, characterId);
  return await scopedDb.characters.restore(sequenceId, characterId, {
    actorId: actor.userId,
  });
}

const STILL_CAST_MESSAGE = 'Remove it from its sequences first.';

/**
 * Delete one of the team's characters (#2065). Soft: it leaves the
 * Characters page and the `@` picker, and `restoreTeamCharacter` brings it
 * back. Refused while a sequence, archived ones included, still casts it;
 * the db write carries the same condition, so a sequence that casts it
 * between the check and the write still stops it. A voice it still points
 * at is released first, provider before row (`releaseCharacterVoice`), so a
 * failed release leaves the character. Restoring does not bring the voice
 * back.
 */
export async function deleteTeamCharacter(
  scopedDb: ScopedDb,
  actor: Actor,
  characterId: string
) {
  if (await scopedDb.characters.getCastInAnySequenceOrArchive(characterId)) {
    throw new ConflictError(STILL_CAST_MESSAGE);
  }
  await releaseCharacterVoice(
    scopedDb,
    await scopedDb.characters.getVoice(characterId),
    actor.userId
  );
  if (!(await scopedDb.characters.softDeleteForTeam(characterId))) {
    throw new ConflictError(STILL_CAST_MESSAGE);
  }
  return { characterId };
}

export async function restoreTeamCharacter(
  scopedDb: ScopedDb,
  characterId: string
) {
  if (!(await scopedDb.characters.restoreForTeam(characterId))) {
    throw new NotFoundError('Character not found');
  }
  return { characterId };
}

/**
 * Per-character voice switch (#1553): an explicit override of the sequence
 * default. Off releases the saved voice.
 */
export async function setCharacterVoiceEnabled(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string | null,
  characterId: string,
  enabled: boolean
) {
  const character = await requireCharacter(scopedDb, sequenceId, characterId);
  await scopedDb.characters.updateVoice(
    character.id,
    { useVoice: enabled },
    enabled ? 'user-edit' : 'disabled',
    actor.userId
  );
  if (!enabled) {
    await releaseCharacterVoice(scopedDb, character, actor.userId);
  }
  return { characterId: character.id, name: character.name, useVoice: enabled };
}

/**
 * Point the character back at an earlier voice (#1657): the pointer moves
 * first, then the voice the row was holding is released if nothing else uses
 * it. A released voice can never be selected again.
 */
export async function selectCharacterVoiceVersion(
  scopedDb: ScopedDb,
  sequenceId: string | null,
  characterId: string,
  versionId: string
) {
  const character = await requireCharacter(scopedDb, sequenceId, characterId);
  const updated = await scopedDb.characters.selectVoiceVersion(
    character.id,
    versionId
  );
  await releaseReplacedVoice(scopedDb, character.voiceId, updated.voiceId);
  return {
    characterId: character.id,
    name: character.name,
    voiceId: updated.voiceId,
  };
}

export async function selectCharacterSheetVersion(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string | null,
  characterId: string,
  versionId: string
) {
  const character = await requireCharacter(scopedDb, sequenceId, characterId);
  const version = await scopedDb.characterSheetVariants.select(
    sequenceId,
    character.id,
    versionId,
    { actorId: actor.userId }
  );
  // The sheet now worn may be an uploaded photo of a real person: the lock
  // reads it, and a character stored as not a person is written one, as
  // the upload itself did (#2065).
  await keepLockedCharacterAPerson(scopedDb, actor, sequenceId, character);
  await emitQuietly(() =>
    getGenerationChannel(castChannelId(sequenceId, character.id)).emit(
      'generation.character-sheet:progress',
      {
        characterId: character.id,
        lookId: version.lookId ?? character.id,
        status: 'completed',
      }
    )
  );
  return {
    versionId: version.id,
    characterId: character.id,
    name: character.name,
  };
}

/** A sheet version of a character of this sequence. */
async function requireCharacterSheetVersion(
  scopedDb: ScopedDb,
  sequenceId: string | null,
  versionId: string
) {
  const variant = await scopedDb.characterSheetVariants.getById(versionId);
  if (!variant) throw new NotFoundError('Character sheet variant not found');
  await requireCharacter(scopedDb, sequenceId, variant.characterId);
  return variant;
}

export async function discardCharacterSheetVersion(
  scopedDb: ScopedDb,
  sequenceId: string | null,
  versionId: string
) {
  const variant = await requireCharacterSheetVersion(
    scopedDb,
    sequenceId,
    versionId
  );
  const discardedAt = await scopedDb.characterSheetVariants.discard(variant.id);
  return { variantId: variant.id, discardedAt };
}

export async function undiscardCharacterSheetVersion(
  scopedDb: ScopedDb,
  sequenceId: string | null,
  versionId: string
) {
  const variant = await requireCharacterSheetVersion(
    scopedDb,
    sequenceId,
    versionId
  );
  await scopedDb.characterSheetVariants.undiscard(variant.id);
  return { variantId: variant.id };
}

// ── Looks (#2015) ───────────────────────────────────────────────────────────

/** What a person writes on a look. Blank clothing or styling clears it. */
export type LookInput = {
  name: string;
  clothing: string | null;
  styling: string | null;
};

const blankToNull = (value: string | null | undefined) =>
  value === undefined ? undefined : value?.trim() || null;

/** Add an outfit to a character. It has no sheet until one is asked for. */
export async function createCharacterLook(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  characterId: string,
  input: LookInput
) {
  const character = await requireCharacter(scopedDb, sequenceId, characterId);
  const look = await scopedDb.characterLooks.create(
    sequenceId,
    character.id,
    {
      name: input.name.trim(),
      clothing: blankToNull(input.clothing) ?? null,
      styling: blankToNull(input.styling) ?? null,
    },
    { source: 'edit', actorId: actor.userId }
  );
  return { characterId: character.id, lookId: look.id, name: look.name };
}

/**
 * Rename a look or edit its clothing / styling. An edit to clothing or
 * styling makes the look's sheet, and the shots of the scenes that wear it,
 * stale; a rename does not.
 */
export async function updateCharacterLook(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  characterId: string,
  lookId: string,
  patch: Partial<LookInput>
) {
  const character = await requireCharacter(scopedDb, sequenceId, characterId);
  const look = requireLiveLook(
    await requireCharacterLook(scopedDb, character, lookId)
  );
  // A default look's styling edit may copy the pinned bible version forward
  // and make it current (the #2065 features move): never a stale "not a
  // person" on a locked character.
  if (look.isDefault) {
    await keepLockedCharacterAPerson(scopedDb, actor, sequenceId, character);
  }
  const updated = await scopedDb.characterLooks.update(
    sequenceId,
    look.id,
    {
      name: patch.name?.trim(),
      clothing: blankToNull(patch.clothing),
      styling: blankToNull(patch.styling),
    },
    { source: 'edit', actorId: actor.userId }
  );
  return { characterId: character.id, lookId: look.id, name: updated.name };
}

/** Remove a look (undoable). Refused for the default look and a worn one. */
export async function removeCharacterLook(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  characterId: string,
  lookId: string
) {
  const character = await requireCharacter(scopedDb, sequenceId, characterId);
  const look = await requireCharacterLook(scopedDb, character, lookId);
  const deletedAt = await scopedDb.characterLooks.remove(sequenceId, look.id, {
    actorId: actor.userId,
  });
  return {
    characterId: character.id,
    lookId: look.id,
    name: look.name,
    deletedAt,
  };
}

export async function restoreCharacterLook(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  characterId: string,
  lookId: string
) {
  const character = await requireCharacter(scopedDb, sequenceId, characterId);
  const look = await requireCharacterLook(scopedDb, character, lookId);
  await scopedDb.characterLooks.restore(sequenceId, look.id, {
    actorId: actor.userId,
  });
  return { characterId: character.id, lookId: look.id, name: look.name };
}

/** Point a look back at one of its earlier definitions. */
export async function selectCharacterLookVersion(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  characterId: string,
  lookId: string,
  versionId: string
) {
  const character = await requireCharacter(scopedDb, sequenceId, characterId);
  const look = requireLiveLook(
    await requireCharacterLook(scopedDb, character, lookId)
  );
  const updated = await scopedDb.characterLooks.selectVersion(
    sequenceId,
    look.id,
    versionId,
    { actorId: actor.userId }
  );
  return {
    characterId: character.id,
    lookId: look.id,
    name: updated.name,
    versionId,
  };
}

// ── Looks from no sequence (#2065) ──────────────────────────────────────────

/** A look of one of the team's characters, at its current version. */
async function requireTeamLook(
  scopedDb: Pick<ScopedDb, 'characters'>,
  characterId: string,
  lookId: string
) {
  const character = await scopedDb.characters.getCurrent(characterId);
  if (!character) throw new NotFoundError('Character not found');
  const look = character.looks.find((candidate) => candidate.id === lookId);
  if (!look) throw new NotFoundError('Look not found');
  return look;
}

/** Add an outfit from the Characters page. No sequence uses it yet. */
export async function createTeamCharacterLook(
  scopedDb: ScopedDb,
  actor: Actor,
  characterId: string,
  input: LookInput
) {
  const look = await scopedDb.characterLooks.create(
    null,
    characterId,
    {
      name: input.name.trim(),
      clothing: blankToNull(input.clothing) ?? null,
      styling: blankToNull(input.styling) ?? null,
    },
    { source: 'edit', actorId: actor.userId }
  );
  return { characterId, lookId: look.id, name: look.name };
}

/** Rename a look or edit its clothing / styling from the Characters page. */
export async function updateTeamCharacterLook(
  scopedDb: ScopedDb,
  actor: Actor,
  characterId: string,
  lookId: string,
  patch: Partial<LookInput>
) {
  const look = await requireTeamLook(scopedDb, characterId, lookId);
  if (look.deletedAt) {
    throw new ValidationError(
      `${look.name} was removed. Restore the look first.`
    );
  }
  // As in {@link updateCharacterLook}: the features move copies the current
  // bible version forward.
  if (look.isDefault) {
    await keepLockedCharacterAPerson(
      scopedDb,
      actor,
      null,
      await requireCurrentCharacter(scopedDb, characterId)
    );
  }
  const updated = await scopedDb.characterLooks.update(
    null,
    look.id,
    {
      name: patch.name?.trim(),
      clothing: blankToNull(patch.clothing),
      styling: blankToNull(patch.styling),
    },
    { source: 'edit', actorId: actor.userId }
  );
  return { characterId, lookId: look.id, name: updated.name };
}

/** Remove a look (undoable). Refused for the default look and a worn one. */
export async function removeTeamCharacterLook(
  scopedDb: ScopedDb,
  actor: Actor,
  characterId: string,
  lookId: string
) {
  const look = await requireTeamLook(scopedDb, characterId, lookId);
  const deletedAt = await scopedDb.characterLooks.remove(null, look.id, {
    actorId: actor.userId,
  });
  return { characterId, lookId: look.id, name: look.name, deletedAt };
}

export async function restoreTeamCharacterLook(
  scopedDb: ScopedDb,
  actor: Actor,
  characterId: string,
  lookId: string
) {
  const look = await requireTeamLook(scopedDb, characterId, lookId);
  await scopedDb.characterLooks.restore(null, look.id, {
    actorId: actor.userId,
  });
  return { characterId, lookId: look.id, name: look.name };
}

// ── Locations ───────────────────────────────────────────────────────────────

/** The location, when it belongs to this sequence (live or soft-deleted). */
async function requireLocation(
  scopedDb: Pick<ScopedDb, 'sequenceLocations'>,
  sequenceId: string,
  locationDbId: string
) {
  const location = await scopedDb.sequenceLocations.getById(locationDbId);
  if (!location || location.sequenceId !== sequenceId) {
    throw new NotFoundError('Location not found');
  }
  return location;
}

/**
 * Create a location by hand — starts reference-less (`referenceStatus:
 * 'pending'`). `locationId` is a shortened name (`loc_office`) uniqued on the
 * `(sequenceId, locationId)` index.
 */
export async function createLocation(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  { name, ...bible }: LocationBibleFields & { name: string }
) {
  const base = identityToken('loc', name);
  const taken = new Set<string>();
  let locationId = base;
  while (
    await scopedDb.sequenceLocations.getByLocationId(sequenceId, locationId)
  ) {
    taken.add(locationId);
    locationId = nextIdentityToken(base, taken);
  }
  const location = await scopedDb.sequenceLocations.create(
    {
      sequenceId,
      locationId,
      name,
      ...bible,
      consistencyTag:
        bible.consistencyTag ?? `${locationId}: ${slugifyTag(name)}`,
      referenceStatus: 'pending',
    },
    { source: 'edit', createdBy: actor.userId }
  );
  await scopedDb.sequenceEvents.record({
    sequenceId,
    actorId: actor.userId,
    kind: 'location.created',
    targetType: 'location',
    targetId: location.id,
    summary: `Added location ${name}`,
    data: { name, locationId },
  });
  return location;
}

/** Edit a location's bible fields; only the sent fields change. */
export async function updateLocation(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  locationDbId: string,
  update: LocationBibleUpdate
) {
  await requireLocation(scopedDb, sequenceId, locationDbId);
  return await scopedDb.sequenceLocations.updateBible(locationDbId, update, {
    actorId: actor.userId,
  });
}

/** Soft-remove a location (undoable; continuity tags are kept). */
export async function deleteLocation(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  locationDbId: string
) {
  const location = await requireLocation(scopedDb, sequenceId, locationDbId);
  const deletedAt = await scopedDb.sequenceLocations.softDelete(locationDbId, {
    actorId: actor.userId,
  });
  return { locationDbId, name: location.name, deletedAt };
}

export async function restoreLocation(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  locationDbId: string
) {
  await requireLocation(scopedDb, sequenceId, locationDbId);
  return await scopedDb.sequenceLocations.restore(locationDbId, {
    actorId: actor.userId,
  });
}

export async function selectLocationSheetVersion(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  locationDbId: string,
  versionId: string
) {
  const location = await requireLocation(scopedDb, sequenceId, locationDbId);
  const version = await scopedDb.locationSheetVariants.select(
    location.id,
    versionId,
    { actorId: actor.userId }
  );
  await emitQuietly(() =>
    getGenerationChannel(sequenceId).emit(
      'generation.location-sheet:progress',
      { locationId: location.id, status: 'completed' }
    )
  );
  return {
    versionId: version.id,
    locationDbId: location.id,
    name: location.name,
  };
}

/** A reference version of a location of this sequence. */
async function requireLocationSheetVersion(
  scopedDb: ScopedDb,
  sequenceId: string,
  versionId: string
) {
  const variant = await scopedDb.locationSheetVariants.getById(versionId);
  if (!variant || variant.parentType !== 'sequence_location') {
    throw new NotFoundError('Sequence-location variant not found');
  }
  await requireLocation(scopedDb, sequenceId, variant.parentId);
  return variant;
}

export async function discardLocationSheetVersion(
  scopedDb: ScopedDb,
  sequenceId: string,
  versionId: string
) {
  const variant = await requireLocationSheetVersion(
    scopedDb,
    sequenceId,
    versionId
  );
  const discardedAt = await scopedDb.locationSheetVariants.discard(variant.id);
  return { variantId: variant.id, discardedAt };
}

export async function undiscardLocationSheetVersion(
  scopedDb: ScopedDb,
  sequenceId: string,
  versionId: string
) {
  const variant = await requireLocationSheetVersion(
    scopedDb,
    sequenceId,
    versionId
  );
  await scopedDb.locationSheetVariants.undiscard(variant.id);
  return { variantId: variant.id };
}

// ── Elements ────────────────────────────────────────────────────────────────

/** The element, when it belongs to this sequence (live or soft-deleted). */
async function requireElement(
  scopedDb: Pick<ScopedDb, 'sequenceElements'>,
  sequenceId: string,
  elementId: string
) {
  const element = await scopedDb.sequenceElements.getById(elementId);
  if (!element || element.sequenceId !== sequenceId) {
    throw new NotFoundError('Element not found');
  }
  return element;
}

/**
 * Set an element's description by hand (#1559): vision writes it for an
 * image; for a clip or audio the user says what it is. Blank clears it.
 * Shots that mention the element go stale — the description is prompt input.
 */
export async function setElementDescription(
  scopedDb: ScopedDb,
  sequenceId: string,
  elementId: string,
  description: string
) {
  await requireElement(scopedDb, sequenceId, elementId);
  const trimmed = description.trim();
  return await scopedDb.sequenceElements.update(elementId, {
    description: trimmed.length > 0 ? trimmed : null,
  });
}

/** Soft delete (#1108): the row and its bytes stay, so restore is lossless. */
export async function deleteElement(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  elementId: string
) {
  const element = await requireElement(scopedDb, sequenceId, elementId);
  const deletedAt = await scopedDb.sequenceElements.softDelete(elementId, {
    actorId: actor.userId,
  });
  return { success: true, token: element.token, deletedAt };
}

export async function restoreElement(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  elementId: string
) {
  await requireElement(scopedDb, sequenceId, elementId);
  return await scopedDb.sequenceElements.restore(elementId, {
    actorId: actor.userId,
  });
}

/**
 * Rename an element's script token and rewrite it in the script and every
 * shot prompt. A user rename is refused on collision rather than suffixed —
 * the user typed this name.
 */
export async function renameElementToken(
  scopedDb: ScopedDb,
  sequenceId: string,
  elementId: string,
  token: string
) {
  const element = await requireElement(scopedDb, sequenceId, elementId);
  const cleaned = deriveTokenFromFilename(token);
  if (cleaned === element.token) {
    return { element, shotsUpdated: 0, scriptUpdated: false };
  }
  if (
    await scopedDb.sequenceElements.isTokenTaken(
      sequenceId,
      cleaned,
      element.id
    )
  ) {
    throw new ConflictError(
      `Another element is already named "${cleaned}". Pick a different name.`
    );
  }
  return await scopedDb.sequenceElements.cascadeRename({
    sequenceId,
    elementId: element.id,
    oldToken: element.token,
    newToken: cleaned,
  });
}
