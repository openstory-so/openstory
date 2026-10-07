/**
 * The attached cast in script analysis (#2050). Pure.
 *
 * Analysis reads only the characters cast into the sequence, never the team
 * library. The trigger snapshots them (`AttachedCastSnapshot`); the bibles
 * call sees them as a `<CAST>` block shaped like `<ELEMENTS>` and echoes
 * their ids; a name it cannot place is a new character. For a character the
 * library or another sequence holds (`shared`), the pinned bible wins over
 * anything the model wrote, and her looks are linked by name, never
 * rewritten or removed.
 */

import type { CharacterBibleEntry } from '@/shots/scene-analysis.schema';
import type { AttachedCastSnapshot } from '@/platform/server/workflow/types';

const key = (name: string) => name.trim().toLowerCase();

/** One line per cast character, for the bibles prompt. */
export function formatCastBlock(cast: readonly AttachedCastSnapshot[]): string {
  if (cast.length === 0) return '';
  const lines = cast.map(({ entry }) => {
    const looks = entry.looks
      .map(
        (look) => `"${look.name}"${look.clothing ? ` (${look.clothing})` : ''}`
      )
      .join('; ');
    const voice = entry.voiceOnly ? ' [voice only]' : '';
    const appearance = [entry.age, entry.gender, entry.physicalDescription]
      .filter(Boolean)
      .join(', ');
    return `- ${entry.characterId}: ${entry.name}${voice}${appearance ? ` — ${appearance}` : ''}. Looks: ${looks}`;
  });
  return `\n<CAST>\nThese characters are already cast in this sequence. For each one the script uses, return an entry with this exact characterId and reuse its look names:\n${lines.join('\n')}\n</CAST>\n`;
}

/**
 * The model's bible with each shared cast character replaced by her snapshot:
 * the pinned bible fields, her looks (by their `character_looks` ids) and,
 * after them, any look the model named that she does not have (its slug id,
 * so the cast-records step adds it). A model look with a cast look's name is
 * that look, so the scene picks that named its slug are re-pointed at the id.
 * Entries the snapshot does not hold, and characters only this sequence
 * holds, are returned as the model wrote them.
 */
export function applyAttachedCast(
  characterBible: readonly CharacterBibleEntry[],
  sceneLooks: Readonly<Record<string, Readonly<Record<string, string>>>>,
  cast: readonly AttachedCastSnapshot[]
): {
  characterBible: CharacterBibleEntry[];
  sceneLooks: Record<string, Record<string, string>>;
} {
  const shared = new Map(
    cast.filter((c) => c.shared).map((c) => [c.entry.characterId, c.entry])
  );
  const slugToId = new Map<string, string>();
  const merged = characterBible.map((entry) => {
    const pinned = shared.get(entry.characterId);
    if (!pinned) return entry;
    const added = entry.looks.filter((look) => {
      const known = pinned.looks.find(
        (own) => key(own.name) === key(look.name)
      );
      if (known) slugToId.set(look.lookId, known.lookId);
      return !known;
    });
    return {
      ...pinned,
      looks: [...pinned.looks, ...added],
    };
  });
  const picks = Object.fromEntries(
    Object.entries(sceneLooks).map(([sceneId, byTag]) => [
      sceneId,
      Object.fromEntries(
        Object.entries(byTag).map(([tag, lookId]) => [
          tag,
          slugToId.get(lookId) ?? lookId,
        ])
      ),
    ])
  );
  return { characterBible: merged, sceneLooks: picks };
}
