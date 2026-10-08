/**
 * Pin moves (#2017): which version a sequence's cast link pointed at when an
 * artifact was made, read back from the events that moved the pin. An exact
 * pointer compare: never "the version that was newest at that time", which
 * is wrong once a character is in two sequences (another sequence's edit
 * writes a version this one never pinned).
 */
import { z } from 'zod';

export type PinMove = {
  at: Date;
  /** Null on an event written before pins were recorded: the walk stops. */
  from: string | null;
  to: string;
};

const move = z.object({ from: z.string().nullable(), to: z.string() });
const pinMoveData = z.object({
  /** Null: the edit appended no version, so the pin did not move. */
  bibleVersion: move.nullable().optional(),
  bible: move.optional(),
  lookId: z.string().optional(),
  lookVersion: move.optional(),
  looks: z.array(move.extend({ lookId: z.string() })).optional(),
  prevState: z.record(z.string(), z.unknown()).optional(),
});

/** A move whose destination was not recorded (an event from before #2017). */
const UNKNOWN_TO = '';

type PinMoveEvent = {
  kind: string;
  targetId: string;
  createdAt: Date;
  data: unknown;
};

/**
 * The pin moves a sequence's events record: bible moves by character id,
 * look moves by look id, oldest first. A `character.updated` or `look.updated`
 * event with no version ids (written before #2017) is a move to an unknown
 * place, so it is kept with `from: null` and stops a walk through it.
 */
export function pinMovesFromEvents(events: readonly PinMoveEvent[]): {
  bible: ReadonlyMap<string, readonly PinMove[]>;
  look: ReadonlyMap<string, readonly PinMove[]>;
} {
  const bible = new Map<string, PinMove[]>();
  const look = new Map<string, PinMove[]>();
  const push = (map: Map<string, PinMove[]>, key: string, item: PinMove) => {
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  };
  for (const event of events) {
    const parsed = pinMoveData.safeParse(event.data ?? {});
    const data = parsed.success ? parsed.data : {};
    const at = event.createdAt;
    if (event.kind === 'character.updated') {
      if (data.bibleVersion) {
        push(bible, event.targetId, { at, ...data.bibleVersion });
      } else if (data.bibleVersion === undefined) {
        // An event from before #2017 says nothing about the pin. A bible
        // field in `prevState` means a version was appended, destination
        // unrecorded; a voice-description-only edit appended none.
        const fields = Object.keys(data.prevState ?? {}).filter(
          (key) => key !== 'voiceDescription'
        );
        if (fields.length > 0) {
          push(bible, event.targetId, { at, from: null, to: UNKNOWN_TO });
        }
      }
      // `bibleVersion: null`: the edit appended no version.
    } else if (event.kind === 'character.version-moved') {
      if (data.bible) push(bible, event.targetId, { at, ...data.bible });
      for (const item of data.looks ?? []) {
        push(look, item.lookId, { at, from: item.from, to: item.to });
      }
    } else if (
      event.kind === 'look.updated' ||
      event.kind === 'look.version-selected'
    ) {
      if (data.lookId) {
        push(
          look,
          data.lookId,
          data.lookVersion
            ? { at, ...data.lookVersion }
            : { at, from: null, to: UNKNOWN_TO }
        );
      }
    }
  }
  return { bible, look };
}

/**
 * The version the pin named at `at`, walking back from what it names now
 * through every move made since. Null when a move since then did not record
 * where it came from: the cause then names the character without fields.
 */
export function pinnedVersionAt(
  current: string,
  moves: readonly PinMove[] | undefined,
  at: number
): string | null {
  let pin = current;
  for (const item of [...(moves ?? [])].reverse()) {
    if (item.at.getTime() <= at) break;
    if (item.from === null) return null;
    pin = item.from;
  }
  return pin;
}
