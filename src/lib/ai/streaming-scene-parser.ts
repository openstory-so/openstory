/**
 * Streaming boundary-scene parser (#1035 / #1218).
 *
 * Incrementally consumes the scenes-call output — `{ projectMetadata,
 * boundaries[] }` — from a partial JSON stream. The LLM never authors
 * script text or per-scene metadata: as soon as boundary k+1 has fully
 * streamed, scene k is a local verbatim slice of the ORIGINAL script with
 * heading/dialogue/duration derived from that slice (`scene-from-slice.ts`).
 *
 * Scene ids/numbers are minted here (server-side), never by the LLM.
 */

import { parsePartialJSON } from '@tanstack/ai';
import { z } from 'zod';
import {
  type BoundaryAnnotation,
  resolveBoundaries,
  sliceScenes,
} from './boundary-split';
import { sceneBoundarySchema } from './response-schemas';
import {
  buildSceneFromSlice,
  inheritMissingLocation,
} from './scene-from-slice';
import type {
  Continuity,
  DialogueLine,
  SceneMetadata,
} from './scene-analysis.schema';

/**
 * The per-scene shape the scene-split workflow persists and emits mid-stream.
 * Matches the slice of `Scene` that `buildSceneInsert` + eventing consume.
 */
export type SceneSplittingScene = {
  sceneId: string;
  sceneNumber: number;
  originalScript: { extract: string; dialogue: DialogueLine[] };
  metadata: SceneMetadata;
  continuity: Continuity;
};

export type StreamedSceneEvent =
  | { type: 'title'; title: string }
  | { type: 'scene'; scene: SceneSplittingScene; index: number };

/**
 * Strip markdown code fences that some models wrap around JSON output.
 * Handles ```json, ```, and leading/trailing whitespace.
 */
export function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Assemble the final scene array from a complete scenes-call result: resolve
 * boundaries, slice the script, derive local fields from each slice. Pure —
 * the workflow uses it for the post-stream (and retry/fallback) build, with
 * `sceneIdFor` reusing ids the streaming parser already minted so mid-stream
 * rows and the final result agree.
 */
export function assembleScenes(
  script: string,
  result: {
    boundaries: BoundaryAnnotation[];
  },
  sceneIdFor: (index: number) => string
): {
  scenes: SceneSplittingScene[];
  resolution: ReturnType<typeof resolveBoundaries>;
  slices: string[];
} {
  const resolution = resolveBoundaries(script, result.boundaries);
  const slices = sliceScenes(script, resolution.offsets);
  const scenes = slices.map((slice, i) =>
    buildSceneFromSlice(sceneIdFor(i), i, slice)
  );
  for (let i = 1; i < scenes.length; i++) {
    const scene = scenes[i];
    const previous = scenes[i - 1];
    if (!scene) continue;
    scenes[i] = inheritMissingLocation(scene, previous);
  }
  return { scenes, resolution, slices };
}

/**
 * Create a parser bound to the raw script. `mintSceneId` is called once per
 * scene index (inject `generateId` in production, a counter in tests).
 *
 * Boundary resolution is a pure function of (script, boundary prefix) with a
 * monotonic cursor, so incremental resolution mid-stream and the workflow's
 * final full-payload resolution agree on every prefix.
 */
export function createStreamingSceneParser(
  script: string,
  mintSceneId: () => string
) {
  let titleEmitted = false;
  let emittedScenes = 0;
  let previousEmitted: SceneSplittingScene | undefined;
  const sceneIds = new Map<number, string>();

  const idFor = (index: number): string => {
    const existing = sceneIds.get(index);
    if (existing !== undefined) return existing;
    const id = mintSceneId();
    sceneIds.set(index, id);
    return id;
  };

  return {
    /**
     * Feed the full accumulated LLM text; returns events new since last feed.
     * Pass `done: true` on the final feed so the last scene (whose end is the
     * script end) is emitted.
     */
    feed(accumulated: string, done = false): StreamedSceneEvent[] {
      const events: StreamedSceneEvent[] = [];

      const raw = parsePartialJSON(stripCodeFences(accumulated));
      if (!isRecord(raw)) return events;

      if (!titleEmitted) {
        const pm = raw.projectMetadata;
        if (
          isRecord(pm) &&
          typeof pm.title === 'string' &&
          pm.title.length > 0
        ) {
          titleEmitted = true;
          events.push({ type: 'title', title: pm.title });
        }
      }

      // A partially-streamed trailing array entry parses as a truncated
      // object (parsePartialJSON completes a mid-string quote with partial
      // content), so an entry has settled only once something follows it:
      // a later entry, or the stream's end.
      const settledPrefix = <T>(
        value: unknown,
        schema: z.ZodType<T>,
        closed: boolean
      ): T[] => {
        if (!Array.isArray(value)) return [];
        const settled = closed ? value.length : value.length - 1;
        const out: T[] = [];
        for (let i = 0; i < settled; i++) {
          const parsed = schema.safeParse(value[i]);
          if (!parsed.success) break;
          out.push(parsed.data);
        }
        return out;
      };

      const boundaries: BoundaryAnnotation[] = settledPrefix(
        raw.boundaries,
        sceneBoundarySchema,
        done
      );

      const resolution = resolveBoundaries(script, boundaries);
      const slices = sliceScenes(script, resolution.offsets);
      // Scene i ends where boundary i+1 begins. Once the stream is done,
      // every scene's end is known (the last ends at script end).
      const finalized = done ? slices.length : Math.max(0, slices.length - 1);

      for (let i = emittedScenes; i < finalized; i++) {
        const slice = slices[i];
        if (slice === undefined) break;
        const scene = inheritMissingLocation(
          buildSceneFromSlice(idFor(i), i, slice),
          previousEmitted
        );
        previousEmitted = scene;
        events.push({
          type: 'scene',
          scene,
          index: i,
        });
        emittedScenes = i + 1;
      }

      return events;
    },

    /** Scene ids minted so far, keyed by scene index. */
    mintedSceneIds(): ReadonlyMap<number, string> {
      return sceneIds;
    },
  };
}
