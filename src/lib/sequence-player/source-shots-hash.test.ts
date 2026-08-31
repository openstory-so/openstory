/**
 * Pins the export cache key so browser and server producers cannot drift
 * onto different hashes for the same cut (#1406).
 */

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '@/lib/compliance/hash';
import {
  effectiveExportMusicUrl,
  hashSequenceExportInputs,
  sequenceExportInputsKey,
} from './source-shots-hash';

const cut = {
  sceneUrls: ['/r2/a.mp4', '/r2/b.mp4'],
  musicUrl: '/r2/music.mp3',
} as const;

describe('sequenceExportInputsKey', () => {
  it('serializes {sceneUrls, musicUrl} in that key order', () => {
    expect(sequenceExportInputsKey(cut)).toBe(
      '{"sceneUrls":["/r2/a.mp4","/r2/b.mp4"],"musicUrl":"/r2/music.mp3"}'
    );
  });

  it('treats a muted cut as musicUrl null, not omitted', () => {
    expect(
      sequenceExportInputsKey({ sceneUrls: cut.sceneUrls, musicUrl: null })
    ).toBe('{"sceneUrls":["/r2/a.mp4","/r2/b.mp4"],"musicUrl":null}');
  });
});

describe('hashSequenceExportInputs', () => {
  it('is SHA-256 of the canonical JSON (byte-identical across producers)', async () => {
    const hash = await hashSequenceExportInputs(cut);
    expect(hash).toBe(await sha256Hex(sequenceExportInputsKey(cut)));
    expect(hash).toBe(await hashSequenceExportInputs({ ...cut }));
  });

  it('changes when scene order, a url, or the music choice changes', async () => {
    const base = await hashSequenceExportInputs(cut);
    expect(
      await hashSequenceExportInputs({
        sceneUrls: [...cut.sceneUrls].reverse(),
        musicUrl: cut.musicUrl,
      })
    ).not.toBe(base);
    expect(
      await hashSequenceExportInputs({
        sceneUrls: ['/r2/a-v2.mp4', '/r2/b.mp4'],
        musicUrl: cut.musicUrl,
      })
    ).not.toBe(base);
    expect(
      await hashSequenceExportInputs({
        sceneUrls: cut.sceneUrls,
        musicUrl: null,
      })
    ).not.toBe(base);
  });
});

describe('effectiveExportMusicUrl', () => {
  it('is the music URL when the toggle is on, else null', () => {
    expect(effectiveExportMusicUrl(true, '/r2/m.mp3')).toBe('/r2/m.mp3');
    expect(effectiveExportMusicUrl(true, null)).toBeNull();
    expect(effectiveExportMusicUrl(true, undefined)).toBeNull();
    expect(effectiveExportMusicUrl(false, '/r2/m.mp3')).toBeNull();
  });
});
