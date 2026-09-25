import { describe, expect, it } from 'vitest';
import {
  edgesForMode,
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
      'musicTrack',
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
    // The sheets bind on the clip in both modes (#1657), so a new sheet
    // version reaches the render with no still in between.
    expect(ids(staleAfterEdit('characterSheet', 'reference-only'))).toEqual([
      'clip',
      'export',
      'still',
    ]);
    // The location sheet is only sent to the video model in reference-only,
    // so only that mode binds it on the clip.
    const locationToClip = (mode: 'start-frame' | 'reference-only') =>
      edgesForMode(mode).some(
        (e) => e.from === 'locationSheet' && e.to === 'clip'
      );
    expect(locationToClip('reference-only')).toBe(true);
    expect(locationToClip('start-frame')).toBe(false);
  });

  it('untracked edges do not propagate, gap or not', () => {
    expect(ids(staleBecauseOf('voice', 'start-frame'))).toEqual([]);
    expect(ids(staleAfterEdit('videoModel', 'start-frame'))).toEqual([]);
    expect(ids(staleAfterEdit('musicOn', 'start-frame'))).toEqual(['export']);
    expect(ids(staleAfterEdit('stopAt', 'start-frame'))).toEqual([]);
  });

  it('duration and the music track are compared (#767, #1657)', () => {
    expect(ids(staleAfterEdit('duration', 'start-frame'))).toEqual([
      'clip',
      'export',
      'musicPrompt',
      'musicTrack',
    ]);
    expect(ids(staleBecauseOf('musicTrack', 'start-frame'))).toContain(
      'musicPrompt'
    );
  });

  it('a voice change re-stales the recording, the section and the clip, not the motion prompt', () => {
    expect(ids(staleAfterEdit('voice', 'start-frame'))).toEqual([
      'clip',
      'dialogueRecording',
      'dialogueSection',
      'export',
    ]);
    expect(ids(staleAfterEdit('voice', 'reference-only'))).toEqual([
      'clip',
      'dialogueRecording',
      'dialogueSection',
      'export',
    ]);
    expect(ids(staleBecauseOf('motionPrompt', 'start-frame'))).not.toContain(
      'voice'
    );
  });

  it('the clip reaches its dialogue through the section, by pointer (#1657)', () => {
    const toClip = GRAPH_EDGES.filter(
      (e) => e.to === 'clip' && e.from.startsWith('dialogue')
    );
    expect(
      toClip
        .map((e) => [e.from, e.tracking])
        .sort(([a = ''], [b = '']) => a.localeCompare(b))
    ).toEqual([
      ['dialogue', 'hash'],
      ['dialogueSection', 'pointer'],
    ]);
    expect(ids(staleAfterEdit('dialogue', 'start-frame'))).toEqual([
      'clip',
      'dialogueRecording',
      'dialogueSection',
      'export',
      'motionPrompt', // the shot's lines are its input (#1784)
    ]);
  });

  it('upstream walk mirrors the downstream walk', () => {
    for (const a of GRAPH_NODES) {
      const down = ids(staleAfterEdit(a.id, 'start-frame'));
      for (const b of GRAPH_NODES) {
        const up = ids(staleBecauseOf(b.id, 'start-frame'));
        expect(up.includes(a.id), `${a.id} → ${b.id}`).toBe(
          down.includes(b.id)
        );
      }
    }
  });
});
