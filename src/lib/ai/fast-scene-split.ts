/**
 * Fast text-based scene splitter for preview generation.
 * Splits scripts using screenplay formatting conventions (INT./EXT., CUT TO, etc.)
 * without any LLM calls. Produces minimal Scene[] for quick preview shots.
 */

import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { generateId } from '@/shared/id';

/** Screenplay markers that typically indicate scene boundaries */
const SCENE_HEADING_PATTERN = /^(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.)[\s]/i;

const TRANSITION_PATTERN =
  /^(?:CUT TO:|DISSOLVE TO:|FADE IN:|FADE OUT[.:]?|SMASH CUT TO:|MATCH CUT TO:|WIPE TO:)\s*$/i;

/** Double blank lines (or more) also indicate scene breaks */
const DOUBLE_BLANK_PATTERN = /\n\s*\n\s*\n/;

const DEFAULT_MAX_LINES_PER_SCENE = 25;
const MIN_SCENE_LINES = 3;

/**
 * Split a script into scenes using text heuristics.
 * No LLM call needed — runs synchronously in ~0ms.
 */
export function fastSceneSplit(
  script: string,
  maxLinesPerScene = DEFAULT_MAX_LINES_PER_SCENE
): Scene[] {
  const lines = script.split('\n');
  const chunks: string[][] = [];
  let currentChunk: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Scene heading or transition → start a new chunk
    if (
      SCENE_HEADING_PATTERN.test(trimmed) ||
      TRANSITION_PATTERN.test(trimmed)
    ) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
      }
      currentChunk = [line];
      continue;
    }

    currentChunk.push(line);

    // Cap chunk size — force a split if too long
    if (currentChunk.length >= maxLinesPerScene) {
      chunks.push(currentChunk);
      currentChunk = [];
    }
  }

  // Push remaining lines
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  // Merge very small chunks with adjacent ones
  const merged = mergeSmallChunks(chunks, MIN_SCENE_LINES);

  // Also split on double blank lines within chunks
  const finalChunks = merged.flatMap((chunk) => splitOnDoubleBlankLines(chunk));

  // Filter out empty/whitespace-only chunks
  const nonEmpty = finalChunks.filter((chunk) =>
    chunk.some((line) => line.trim().length > 0)
  );

  // Convert to Scene[]
  return nonEmpty.map((chunk, index) => chunkToScene(chunk, index));
}

function mergeSmallChunks(chunks: string[][], minLines: number): string[][] {
  if (chunks.length <= 1) return chunks;

  const result: string[][] = [];
  let buffer: string[] = [];

  for (const chunk of chunks) {
    if (buffer.length > 0 && buffer.length < minLines) {
      // Merge small buffer into this chunk
      buffer.push(...chunk);
    } else {
      if (buffer.length > 0) {
        result.push(buffer);
      }
      buffer = [...chunk];
    }
  }

  if (buffer.length > 0) {
    result.push(buffer);
  }

  return result;
}

function splitOnDoubleBlankLines(chunk: string[]): string[][] {
  const text = chunk.join('\n');
  if (!DOUBLE_BLANK_PATTERN.test(text)) return [chunk];

  const parts = text.split(/\n\s*\n\s*\n/);
  return parts
    .map((part) => part.split('\n'))
    .filter((lines) => lines.some((l) => l.trim().length > 0));
}

function chunkToScene(lines: string[], index: number): Scene {
  const extract = lines.join('\n').trim();
  const firstLine = lines.find((l) => l.trim().length > 0)?.trim() ?? '';

  // Try to derive a title from the first line
  const title = deriveTitle(firstLine, index);

  return {
    sceneId: generateId(),
    sceneNumber: index + 1,
    originalScript: {
      extract,
      dialogue: [],
    },
    metadata: {
      title,
      durationSeconds: estimateDuration(lines),
      location: SCENE_HEADING_PATTERN.test(firstLine) ? firstLine : '',
      timeOfDay: '',
      storyBeat: '',
    },
  };
}

function deriveTitle(firstLine: string, index: number): string {
  // If it looks like a scene heading, use it
  if (SCENE_HEADING_PATTERN.test(firstLine)) {
    // Clean up: "INT. OFFICE - DAY" → "Office"
    const cleaned = firstLine
      .replace(/^(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.)\s*/i, '')
      .replace(
        /\s*-\s*(DAY|NIGHT|DAWN|DUSK|EVENING|MORNING|CONTINUOUS|LATER|SAME).*$/i,
        ''
      )
      .trim();
    return cleaned || `Scene ${index + 1}`;
  }

  // Use first ~50 chars of first line as title
  if (firstLine.length > 50) {
    return firstLine.slice(0, 47) + '...';
  }
  return firstLine || `Scene ${index + 1}`;
}

function estimateDuration(lines: string[]): number {
  // Rough estimate: ~1 second per 2 lines of script, clamped to 3-10s
  const nonEmpty = lines.filter((l) => l.trim().length > 0).length;
  return Math.max(3, Math.min(10, Math.round(nonEmpty / 2)));
}
