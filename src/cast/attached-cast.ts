/**
 * The attached cast in script analysis (#2050). Pure.
 *
 * Analysis reads only the characters cast into the sequence, never the organization
 * library. The trigger snapshots them (`AttachedCastSnapshot`); the bibles
 * call sees them as a `<CAST>` block shaped like `<ELEMENTS>` and echoes
 * their ids; a name it cannot place is a new character. For a character the
 * library or another sequence holds (`shared`), the pinned bible wins over
 * anything the model wrote, and her looks are linked by name, never
 * rewritten or removed.
 */

import type { CharacterBibleEntry } from '@/shots/scene-analysis.schema';
import type { AttachedCastSnapshot } from '@/platform/server/workflow/types';
import { uniqueOneEdit } from '@/cast/near-name';

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
 * What the model got wrong about the cast, or null (#2050). An entry that
 * echoes a cast id must carry that character's name; an entry with a cast
 * character's name must echo the id, not invent one. Either way the run
 * fails here, visibly, rather than making a second same-named character or
 * quietly turning someone else into the attached one.
 */
export function castEchoProblem(
  wire: readonly { characterId: string; name: string }[],
  cast: readonly AttachedCastSnapshot[]
): string | null {
  const byId = new Map(cast.map((c) => [c.entry.characterId, c.entry.name]));
  const byName = new Map(
    cast.map((c) => [key(c.entry.name), c.entry.characterId])
  );
  for (const entry of wire) {
    const castName = byId.get(entry.characterId);
    if (castName !== undefined && key(castName) !== key(entry.name)) {
      return `The analysis gave cast id ${entry.characterId} (${castName}) to "${entry.name}". Run it again.`;
    }
    const castId = byName.get(key(entry.name));
    if (castName === undefined && castId !== undefined) {
      return `The analysis made a new "${entry.name}" instead of using the cast character ${castId}. Run it again.`;
    }
  }
  return null;
}

type FoldableEntry = {
  characterId: string;
  name: string;
  looks: readonly { name: string }[];
};

const lookKey = (name: string) => name.trim().toLowerCase();

/**
 * Bind a wire entry whose name is one edit from exactly one cast member onto
 * that member's id and spelling (#2249). An entry that already echoes a cast
 * id is left as the model wrote it, so `castEchoProblem` still fails a real
 * mismatch. When the echo and the near duplicate are both present they
 * collapse to the echo, and looks the echo does not already name are kept.
 */
export function foldNearCast<T extends FoldableEntry>(
  wire: readonly T[],
  cast: readonly AttachedCastSnapshot[]
): T[] {
  const castIds = new Set(cast.map((member) => member.entry.characterId));
  const named = cast.map((member) => ({
    name: member.entry.name,
    characterId: member.entry.characterId,
  }));
  const marked = wire.map((entry) => {
    if (castIds.has(entry.characterId)) return { entry, echoed: true };
    const hit = uniqueOneEdit(entry.name, named);
    if (!hit) return { entry, echoed: false };
    return {
      entry: { ...entry, characterId: hit.characterId, name: hit.name },
      echoed: false,
    };
  });

  const order: string[] = [];
  const groups = new Map<string, typeof marked>();
  for (const item of marked) {
    const group = groups.get(item.entry.characterId);
    if (group) group.push(item);
    else {
      groups.set(item.entry.characterId, [item]);
      order.push(item.entry.characterId);
    }
  }

  return order.flatMap((id) => {
    const group = groups.get(id);
    const first = group?.[0];
    if (!group || !first) return [];
    if (group.length === 1) return [first.entry];
    const base = group.find((item) => item.echoed) ?? first;
    const looks = [...base.entry.looks];
    const seen = new Set(looks.map((look) => lookKey(look.name)));
    for (const item of group) {
      if (item === base) continue;
      for (const look of item.entry.looks) {
        const key = lookKey(look.name);
        if (seen.has(key)) continue;
        seen.add(key);
        looks.push(look);
      }
    }
    return [{ ...base.entry, looks }];
  });
}

/**
 * The attached cast's tags by script id: an echoed entry keeps its own, a
 * new entry must not repeat any.
 */
export const castTags = (cast: readonly AttachedCastSnapshot[]) =>
  new Map(
    cast.map((c) => [
      c.entry.characterId,
      c.entry.consistencyTag || key(c.entry.name).replace(/\s+/g, '_'),
    ])
  );

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
