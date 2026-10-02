/**
 * Cast edits shared by the editor's server fns and the MCP tools (#1979):
 * characters, locations and elements of one sequence — create, bible edits,
 * soft delete / restore, voice switch and history, sheet version picks,
 * element description and token. No generation starts here.
 *
 * Every function takes the sequence id the caller authorised and refuses a
 * row of another sequence (live or soft-deleted rows both pass, so restore
 * can reach them).
 */
import type { z } from 'zod';
import { ConflictError, NotFoundError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import { getGenerationChannel } from '@/platform/realtime';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { CharacterBibleUpdate } from '@/cast/server/db/characters';
import type { LocationBibleUpdate } from '@/cast/server/db/sequence-locations';
import {
  identityToken,
  nextIdentityToken,
  slugifyTag,
  type characterBibleFieldsSchema,
  type locationBibleFieldsSchema,
} from '@/cast/bible-field';
import { deriveTokenFromFilename } from '@/cast/derive-token';
import {
  releaseCharacterVoice,
  releaseReplacedVoice,
} from '@/cast/server/voice/release-voice';

const logger = getLogger(['openstory', 'cast', 'cast-edit']);

type Actor = { userId: string };
type CharacterBibleFields = z.output<typeof characterBibleFieldsSchema>;
type LocationBibleFields = z.output<typeof locationBibleFieldsSchema>;

/** Realtime emits only bust caches; a failed one must not fail the write. */
async function emitQuietly(emit: () => Promise<unknown>) {
  try {
    await emit();
  } catch (error) {
    logger.error('realtime emit failed', { err: error });
  }
}

// ── Characters ──────────────────────────────────────────────────────────────

/** The character, when it belongs to this sequence (live or soft-deleted). */
export async function requireCharacter(
  scopedDb: Pick<ScopedDb, 'characters'>,
  sequenceId: string,
  characterId: string
) {
  const character = await scopedDb.characters.getById(characterId);
  if (!character || character.sequenceId !== sequenceId) {
    throw new NotFoundError('Character not found');
  }
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
  { name, ...bible }: CharacterBibleFields & { name: string }
) {
  const base = identityToken('char', name);
  const taken = new Set<string>();
  let characterId = base;
  while (await scopedDb.characters.getByCharacterId(sequenceId, characterId)) {
    taken.add(characterId);
    characterId = nextIdentityToken(base, taken);
  }
  const character = await scopedDb.characters.create(
    {
      sequenceId,
      characterId,
      name,
      ...bible,
      consistencyTag:
        bible.consistencyTag ?? `${characterId}: ${slugifyTag(name)}`,
      sheetStatus: 'pending',
    },
    { source: 'edit', createdBy: actor.userId }
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
 * Edit a character's bible fields. Only the sent fields change; the sheet and
 * prompts that project them re-stale by hash derivation.
 */
export async function updateCharacter(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  characterId: string,
  update: CharacterBibleUpdate
) {
  await requireCharacter(scopedDb, sequenceId, characterId);
  return await scopedDb.characters.updateBible(characterId, update, {
    actorId: actor.userId,
    source: 'edit',
  });
}

/**
 * Soft-remove a character (undoable). Scene continuity tags are kept, so a
 * restore is lossless. The voice slot is account-wide, so it goes with the
 * row (#1553); the description and previews stay.
 */
export async function deleteCharacter(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  characterId: string
) {
  const existing = await requireCharacter(scopedDb, sequenceId, characterId);
  const deletedAt = await scopedDb.characters.softDelete(characterId, {
    actorId: actor.userId,
  });
  await releaseCharacterVoice(scopedDb, existing, actor.userId);
  return { characterId, deletedAt };
}

export async function restoreCharacter(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  characterId: string
) {
  await requireCharacter(scopedDb, sequenceId, characterId);
  return await scopedDb.characters.restore(characterId, {
    actorId: actor.userId,
  });
}

/**
 * Per-character voice switch (#1553): an explicit override of the sequence
 * default. Off releases the saved voice.
 */
export async function setCharacterVoiceEnabled(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
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
  return { characterId: character.id, useVoice: enabled };
}

/**
 * Point the character back at an earlier voice (#1657): the pointer moves
 * first, then the voice the row was holding is released if nothing else uses
 * it. A released voice can never be selected again.
 */
export async function selectCharacterVoiceVersion(
  scopedDb: ScopedDb,
  sequenceId: string,
  characterId: string,
  versionId: string
) {
  const character = await requireCharacter(scopedDb, sequenceId, characterId);
  const updated = await scopedDb.characters.selectVoiceVersion(
    character.id,
    versionId
  );
  await releaseReplacedVoice(scopedDb, character.voiceId, updated.voiceId);
  return { characterId: character.id, voiceId: updated.voiceId };
}

export async function selectCharacterSheetVersion(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  characterId: string,
  versionId: string
) {
  const character = await requireCharacter(scopedDb, sequenceId, characterId);
  const version = await scopedDb.characterSheetVariants.select(
    character.id,
    versionId,
    { actorId: actor.userId }
  );
  await emitQuietly(() =>
    getGenerationChannel(sequenceId).emit(
      'generation.character-sheet:progress',
      { characterId: character.id, status: 'completed' }
    )
  );
  return { versionId: version.id, characterId: character.id };
}

/** A sheet version of a character of this sequence. */
async function requireCharacterSheetVersion(
  scopedDb: ScopedDb,
  sequenceId: string,
  versionId: string
) {
  const variant = await scopedDb.characterSheetVariants.getById(versionId);
  if (!variant) throw new NotFoundError('Character sheet variant not found');
  await requireCharacter(scopedDb, sequenceId, variant.characterId);
  return variant;
}

export async function discardCharacterSheetVersion(
  scopedDb: ScopedDb,
  sequenceId: string,
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
  sequenceId: string,
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
  await requireLocation(scopedDb, sequenceId, locationDbId);
  const deletedAt = await scopedDb.sequenceLocations.softDelete(locationDbId, {
    actorId: actor.userId,
  });
  return { locationDbId, deletedAt };
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
  return { versionId: version.id, locationDbId: location.id };
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
  await requireElement(scopedDb, sequenceId, elementId);
  const deletedAt = await scopedDb.sequenceElements.softDelete(elementId, {
    actorId: actor.userId,
  });
  return { success: true, deletedAt };
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
