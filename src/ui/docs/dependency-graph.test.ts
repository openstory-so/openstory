import { describe, expect, it } from 'vitest';
import {
  GRAPH_EDGES,
  GRAPH_NODES,
  staleAfterEdit,
  staleBecauseOf,
} from './dependency-graph';

const ids = (reach: { id: string }[]) => reach.map((r) => r.id).sort();

describe('dependency graph', () => {
  it('every edge joins two known nodes; only seeded edges may land on an input', () => {
    const known = new Set(GRAPH_NODES.map((n) => n.id));
    for (const e of GRAPH_EDGES) {
      expect(known.has(e.from), e.from).toBe(true);
      expect(known.has(e.to), e.to).toBe(true);
      const to = GRAPH_NODES.find((n) => n.id === e.to);
      if (e.tracking !== 'seeded') expect(to?.kind).toBe('artifact');
    }
  });

  it('a script edit never re-stales a bible', () => {
    const after = ids(staleAfterEdit('script', 'start-frame'));
    for (const bible of ['style', 'character', 'location', 'element']) {
      expect(after).not.toContain(bible);
    }
    expect(after).toContain('visualPrompt');
  });

  it('is acyclic in both modes', () => {
    for (const n of GRAPH_NODES) {
      expect(ids(staleAfterEdit(n.id, 'start-frame'))).not.toContain(n.id);
      expect(ids(staleAfterEdit(n.id, 'reference-only'))).not.toContain(n.id);
    }
  });

  it('a character edit cascades to the export via sheet, still and clip', () => {
    expect(ids(staleAfterEdit('character', 'start-frame'))).toEqual([
      'characterSheet',
      'clip',
      'export',
      'motionPrompt',
      'musicPrompt',
      'still',
      'visualPrompt',
    ]);
    const still = staleAfterEdit('character', 'start-frame').find(
      (r) => r.id === 'still'
    );
    expect(still?.via.tracking).toBe('pointer');
  });

  it('reference-only drops the still from the clip chain but keeps the prompt path', () => {
    const after = staleAfterEdit('still', 'reference-only');
    expect(ids(after)).toEqual([]);
    expect(ids(staleAfterEdit('characterSheet', 'reference-only'))).toEqual([
      'still',
    ]);
  });

  it('cascade and untracked edges do not propagate', () => {
    expect(ids(staleAfterEdit('duration', 'start-frame'))).toEqual([
      'musicPrompt',
    ]);
    expect(ids(staleBecauseOf('musicTrack', 'start-frame'))).toEqual([]);
    expect(ids(staleBecauseOf('voice', 'start-frame'))).toEqual([]);
  });

  it('upstream walk mirrors the downstream walk', () => {
    expect(ids(staleBecauseOf('clip', 'start-frame'))).toEqual(
      [
        'analysisModel',
        'aspectRatio',
        'character',
        'characterSheet',
        'element',
        'imageModel',
        'libraryLocation',
        'libraryLocationReference',
        'location',
        'locationSheet',
        'script',
        'startFrameMode',
        'still',
        'style',
        'talent',
        'talentSheet',
        'visualPrompt',
        'motionPrompt',
      ].sort()
    );
  });
});
