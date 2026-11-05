/**
 * Merge two cast members inside one sequence (#2249).
 *
 * The winner's link stays. Mentions in this sequence's selected scene
 * script, dialogue, prompts and shot spec are appended as new versions.
 * The loser's sheet image is copied onto the winner's default look only
 * when the winner has none. The loser is then soft-removed. Undo is
 * restore: the link comes back, the appended versions stay.
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import type { Database } from '@/platform/server/db/client';
import type {
  CastCharacterWithSheet,
  ShotDialogueLine,
} from '@/platform/server/db/schema';
import {
  characterLooks,
  characterSheetVariants,
  characters,
  framePromptVersions,
  frameVariants,
  frames,
  sceneScriptVersions,
  scenes,
  sequenceCast,
  shotDialogueClaims,
  shotDialogueVersions,
  shotPromptVersions,
  shotSpecVersions,
  shots,
} from '@/platform/server/db/schema';
import {
  repointCharacterTags,
  repointLookPicks,
  repointMentionText,
  repointSpeaker,
  repointSpec,
  type CastMention,
} from '@/cast/merge-mentions';
import { generateId } from '@/platform/id';
import { buildEventInsert } from '@/sequences/server/db/sequence-events';
import { sceneNarrativeOf } from '@/shots/scene-narrative';
import { joinSelectedScript, sceneColumns } from '@/shots/server/db/scenes';
import { promoteLegacyMotionDialogue } from '@/shots/server/db/shot-prompt-versions';
import { hashShotSpecInput } from '@/shots/shot-spec-currency';
import { canonicalStoredShotSpec } from '@/shots/shot-list.schema';

function mentionOf(character: CastCharacterWithSheet): CastMention {
  return {
    name: character.name,
    scriptCharacterId: character.characterId,
    consistencyTag: character.consistencyTag,
  };
}

function repointLines<T extends { character: string }>(
  lines: readonly T[],
  from: CastMention,
  into: CastMention
): T[] {
  return lines.map((line) => ({
    ...line,
    character: repointSpeaker(line.character, from, into),
  }));
}

function sameSpeakers(
  before: readonly { character: string }[],
  after: readonly { character: string }[]
): boolean {
  return (
    before.length === after.length &&
    before.every((line, index) => line.character === after[index]?.character)
  );
}

/** The winner has no sheet of its own and none is on the way. */
function winnerCanTakeSheet(winner: CastCharacterWithSheet): boolean {
  if (winner.pendingPromoteSheetVersionId) return false;
  if (winner.sheetStatus === 'generating') return false;
  if (winner.sheetImageUrl) return false;
  if (winner.sheetStatus === 'completed') return false;
  return true;
}

export async function mergeCastCharacters(
  db: Database,
  sequenceId: string,
  from: CastCharacterWithSheet,
  into: CastCharacterWithSheet,
  actorId: string | null
): Promise<{ characterId: string; sheetCopied: boolean }> {
  const loser = mentionOf(from);
  const winner = mentionOf(into);
  const now = new Date();

  const selectedScripts = await db
    .select({
      sceneId: scenes.id,
      scene: sceneColumns,
      version: sceneScriptVersions,
    })
    .from(scenes)
    .innerJoin(sceneScriptVersions, joinSelectedScript)
    .where(eq(scenes.sequenceId, sequenceId));

  const selectedMotion = await db
    .select({ version: shotPromptVersions })
    .from(shots)
    .innerJoin(
      shotPromptVersions,
      eq(shots.selectedMotionPromptVersionId, shotPromptVersions.id)
    )
    .where(eq(shots.sequenceId, sequenceId));

  const frameRows = await db
    .select({ shotId: frames.shotId, prompt: framePromptVersions })
    .from(frames)
    .innerJoin(
      framePromptVersions,
      eq(framePromptVersions.id, frames.selectedImagePromptVersionId)
    )
    .where(eq(frames.sequenceId, sequenceId));

  const selectedSpecs = await db
    .select({ version: shotSpecVersions, sceneId: shots.sceneId })
    .from(shots)
    .innerJoin(
      shotSpecVersions,
      eq(shotSpecVersions.id, shots.selectedSpecVersionId)
    )
    .where(eq(shots.sequenceId, sequenceId));

  const loadDialogue = () =>
    db
      .select({ version: shotDialogueVersions })
      .from(shotDialogueVersions)
      .innerJoin(shots, eq(shots.id, shotDialogueVersions.shotId))
      .where(
        and(
          eq(shots.sequenceId, sequenceId),
          isNotNull(shotDialogueVersions.selectedAt)
        )
      );

  const motionRewrite = selectedMotion.flatMap(({ version }) => {
    const text = repointMentionText(version.text, loser, winner);
    const dialogue = version.dialogue
      ? {
          ...version.dialogue,
          lines: repointLines(version.dialogue.lines, loser, winner),
        }
      : null;
    const changed =
      text !== version.text ||
      !sameSpeakers(version.dialogue?.lines ?? [], dialogue?.lines ?? []);
    return changed ? [{ version, text, dialogue }] : [];
  });

  for (const { version } of motionRewrite) {
    const selected = await loadDialogue();
    if (selected.some((row) => row.version.shotId === version.shotId)) continue;
    await promoteLegacyMotionDialogue(db, version.shotId);
  }

  const dialogueRows = await loadDialogue();
  const linesByShot = new Map<string, ShotDialogueLine[]>();

  const scriptStatements = selectedScripts.flatMap(
    ({ sceneId, scene, version }) => {
      const extract = repointMentionText(
        version.content.extract,
        loser,
        winner
      );
      const dialogue = repointLines(version.content.dialogue, loser, winner);
      const continuity = version.continuity
        ? {
            ...version.continuity,
            characterTags: repointCharacterTags(
              version.continuity.characterTags,
              loser,
              winner
            ),
            characterLooks: repointLookPicks(
              version.continuity.characterLooks,
              loser,
              winner
            ),
          }
        : version.continuity;
      const changed =
        extract !== version.content.extract ||
        !sameSpeakers(version.content.dialogue, dialogue) ||
        JSON.stringify(continuity) !== JSON.stringify(version.continuity);
      if (!changed) return [];
      const id = generateId();
      return [
        db.insert(sceneScriptVersions).values({
          id,
          sceneId,
          content: { ...version.content, extract, dialogue },
          ...sceneNarrativeOf(scene),
          ...(continuity ? { continuity } : {}),
          source: 'renamed' as const,
          createdBy: actorId,
        }),
        db
          .update(scenes)
          .set({ selectedScriptVersionId: id, updatedAt: now })
          .where(
            and(
              eq(scenes.id, sceneId),
              eq(scenes.selectedScriptVersionId, version.id)
            )
          ),
      ];
    }
  );

  const dialogueStatements = dialogueRows.flatMap(({ version }) => {
    const lines = repointLines(version.lines, loser, winner);
    linesByShot.set(version.shotId, lines);
    if (sameSpeakers(version.lines, lines)) return [];
    const id = generateId();
    return [
      db
        .update(shotDialogueVersions)
        .set({ selectedAt: null })
        .where(
          and(
            eq(shotDialogueVersions.shotId, version.shotId),
            isNotNull(shotDialogueVersions.selectedAt)
          )
        ),
      db
        .update(shotDialogueClaims)
        .set({ pendingSourceKey: null })
        .where(
          and(
            eq(shotDialogueClaims.shotId, version.shotId),
            eq(shotDialogueClaims.status, 'generating'),
            isNotNull(shotDialogueClaims.pendingSourceKey)
          )
        ),
      db.insert(shotDialogueVersions).values({
        id,
        shotId: version.shotId,
        lines,
        source: 'user-edit' as const,
        selectedAt: now,
        createdBy: actorId,
      }),
    ];
  });

  const sceneById = new Map<string, (typeof selectedScripts)[number]>(
    selectedScripts.map((row) => [row.sceneId, row])
  );
  const specIdByShot = new Map<string, string>();
  const specStatements = [];
  for (const { version, sceneId } of selectedSpecs) {
    const sceneRow = sceneId ? sceneById.get(sceneId) : undefined;
    if (!sceneRow) continue;
    const nextSpec = repointSpec(version.spec, loser, winner);
    const extract = repointMentionText(
      sceneRow.version.content.extract,
      loser,
      winner
    );
    const continuity = sceneRow.version.continuity;
    const spoken = linesByShot.get(version.shotId) ?? [];
    const inputHash = await hashShotSpecInput({
      scriptExtract: extract,
      lines: spoken.map((line) => ({
        character: line.character,
        line: line.line,
        tone: line.tone,
      })),
      characterTags: continuity
        ? repointCharacterTags(continuity.characterTags, loser, winner)
        : [],
      elementTags: continuity?.elementTags ?? [],
      environmentTag: continuity?.environmentTag ?? '',
    });
    const textSame =
      JSON.stringify(canonicalStoredShotSpec(nextSpec)) ===
      JSON.stringify(canonicalStoredShotSpec(version.spec));
    if (textSame && version.inputHash === inputHash) continue;
    const id = generateId();
    specIdByShot.set(version.shotId, id);
    specStatements.push(
      db.insert(shotSpecVersions).values({
        id,
        shotId: version.shotId,
        spec: nextSpec,
        source: 'rename' as const,
        inputHash,
        createdBy: actorId,
      }),
      db
        .update(shots)
        .set({ selectedSpecVersionId: id, updatedAt: now })
        .where(
          and(
            eq(shots.id, version.shotId),
            eq(shots.selectedSpecVersionId, version.id)
          )
        )
    );
  }

  const promptStatements = [
    ...motionRewrite.flatMap(({ version, text, dialogue }) => {
      const id = generateId();
      return [
        db.insert(shotPromptVersions).values({
          id,
          shotId: version.shotId,
          promptType: version.promptType,
          text,
          components: version.components,
          parameters: version.parameters,
          dialogue,
          audio: version.audio,
          usesStartFrame: version.usesStartFrame,
          source: 'renamed' as const,
          specVersionId:
            specIdByShot.get(version.shotId) ?? version.specVersionId,
          inputHash: version.inputHash,
          analysisModel: version.analysisModel,
          createdBy: actorId,
        }),
        db
          .update(shots)
          .set({ selectedMotionPromptVersionId: id, updatedAt: now })
          .where(
            and(
              eq(shots.id, version.shotId),
              eq(shots.selectedMotionPromptVersionId, version.id)
            )
          ),
      ];
    }),
    ...frameRows.flatMap(({ shotId, prompt }) => {
      const text = repointMentionText(prompt.text, loser, winner);
      if (text === prompt.text) return [];
      const id = generateId();
      return [
        db.insert(framePromptVersions).values({
          id,
          frameId: prompt.frameId,
          text,
          components: prompt.components,
          source: 'renamed' as const,
          specVersionId: specIdByShot.get(shotId) ?? prompt.specVersionId,
          inputHash: prompt.inputHash,
          analysisModel: prompt.analysisModel,
          createdBy: actorId,
        }),
        db
          .update(frames)
          .set({ selectedImagePromptVersionId: id, updatedAt: now })
          .where(
            and(
              eq(frames.id, prompt.frameId),
              eq(frames.selectedImagePromptVersionId, prompt.id)
            )
          ),
        db
          .update(frameVariants)
          .set({ promptVersionId: id })
          .where(
            and(
              eq(frameVariants.frameId, prompt.frameId),
              eq(frameVariants.promptVersionId, prompt.id)
            )
          ),
      ];
    }),
  ];

  const sheetStatements = [];
  let sheetCopied = false;
  if (
    winnerCanTakeSheet(into) &&
    from.sheetStatus === 'completed' &&
    from.sheetImageUrl &&
    from.selectedSheetVersionId
  ) {
    const [sheet] = await db
      .select()
      .from(characterSheetVariants)
      .where(eq(characterSheetVariants.id, from.selectedSheetVersionId));
    if (sheet?.url && sheet.status === 'completed') {
      const id = generateId();
      sheetCopied = true;
      sheetStatements.push(
        db.insert(characterSheetVariants).values({
          id,
          characterId: into.id,
          lookId: into.lookId,
          model: sheet.model,
          url: sheet.url,
          storagePath: sheet.storagePath,
          portraitUrl: sheet.portraitUrl,
          status: 'completed',
        }),
        db
          .update(characterLooks)
          .set({
            selectedSheetVersionId: id,
            sheetStatus: 'completed',
            updatedAt: now,
          })
          .where(eq(characterLooks.id, into.lookId))
      );
    }
  }

  await db.batch([
    db
      .update(sequenceCast)
      .set({ removedAt: now })
      .where(eq(sequenceCast.id, from.castId)),
    ...scriptStatements,
    ...dialogueStatements,
    ...specStatements,
    ...promptStatements,
    ...sheetStatements,
    db
      .update(characters)
      .set({ updatedAt: now })
      .where(eq(characters.id, from.id)),
    buildEventInsert(db, {
      sequenceId,
      actorId,
      kind: 'character.deleted',
      targetType: 'character',
      targetId: from.id,
      summary: `Merged ${from.name} into ${into.name}`,
      data: {
        name: from.name,
        characterId: from.characterId,
        mergedInto: into.id,
      },
    }),
  ]);

  return { characterId: into.id, sheetCopied };
}
