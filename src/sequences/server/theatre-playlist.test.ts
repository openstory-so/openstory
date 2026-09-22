import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '@/platform/errors';

const objects = new Map<string, Uint8Array>();
const uploads: { path: string; kind: string }[] = [];

async function bytesOf(
  file: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  if (file instanceof ReadableStream) {
    const chunks: Uint8Array[] = [];
    const reader = file.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
  return file instanceof Uint8Array ? file : new Uint8Array(file);
}

const readStorageObject = vi.fn(
  async (key: string, range?: { offset: number; length: number }) => {
    const bytes = objects.get(key);
    if (!bytes) return null;
    const slice = range
      ? bytes.slice(range.offset, range.offset + range.length)
      : bytes.slice();
    return { bytes: new Uint8Array(slice), contentType: '' };
  }
);
const storageObjectSize = vi.fn(
  async (key: string) => objects.get(key)?.byteLength ?? null
);
const uploadFile = vi.fn(
  async (
    bucket: string,
    path: string,
    file: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>
  ) => {
    const bytes = await bytesOf(file);
    objects.set(`${bucket}/${path}`, bytes);
    uploads.push({
      path,
      kind: file instanceof ReadableStream ? 'stream' : 'buffer',
    });
    return {
      path: `${bucket}/${path}`,
      publicUrl: `/r2/${bucket}/${path}`,
      fullPath: `${bucket}/${path}`,
    };
  }
);

vi.doMock('#storage', () => ({
  readStorageObject,
  storageObjectSize,
  uploadFile,
}));

const {
  buildTheatrePlaylist,
  ensureFragmentedClips,
  initSectionLength,
  writeFragmentedCopy,
} = await import('./theatre-playlist');

const CLIP_KEY = 'videos/team/clip.mp4';
const CLIP = new Uint8Array(
  readFileSync(resolve(__dirname, '../../../e2e/fixtures/test-video.mp4'))
);

beforeEach(() => {
  objects.clear();
  uploads.length = 0;
  readStorageObject.mockClear();
  storageObjectSize.mockClear();
  uploadFile.mockClear();
  objects.set(CLIP_KEY, CLIP);
});

const clip = (n: number, over: Record<string, unknown> = {}) => ({
  url: `https://cdn.test/videos/c${n}.mp4.frag.mp4`,
  initBytes: 1277,
  size: 10_000 + n,
  durationSeconds: 6.592,
  videoCodec: 'avc',
  hasAudio: true,
  ...over,
});

function box(type: string, payloadBytes: number): Uint8Array {
  const bytes = new Uint8Array(8 + payloadBytes);
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength);
  bytes.set(new TextEncoder().encode(type), 4);
  return bytes;
}

describe('buildTheatrePlaylist', () => {
  it('lists each clip as one byte-ranged segment behind its own init section', () => {
    const text = buildTheatrePlaylist([
      clip(1),
      clip(2, { durationSeconds: 12.256 }),
    ]);
    expect(text).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-TARGETDURATION:13',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXT-X-MAP:URI="https://cdn.test/videos/c1.mp4.frag.mp4",BYTERANGE="1277@0"',
        '#EXTINF:6.592,',
        '#EXT-X-BYTERANGE:8724@1277',
        'https://cdn.test/videos/c1.mp4.frag.mp4',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-MAP:URI="https://cdn.test/videos/c2.mp4.frag.mp4",BYTERANGE="1277@0"',
        '#EXTINF:12.256,',
        '#EXT-X-BYTERANGE:8725@1277',
        'https://cdn.test/videos/c2.mp4.frag.mp4',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n')
    );
  });

  it('refuses a list one player cannot append: a codec or audio-track switch', () => {
    expect(() =>
      buildTheatrePlaylist([clip(1), clip(2, { videoCodec: 'hevc' })])
    ).toThrow(/differ/);
    expect(() =>
      buildTheatrePlaylist([clip(1), clip(2, { hasAudio: false })])
    ).toThrow(/differ/);
    expect(() => buildTheatrePlaylist([])).toThrow(/No clips/);
  });
});

describe('initSectionLength', () => {
  it('is the offset of the first moof', () => {
    const bytes = new Uint8Array([
      ...box('ftyp', 24),
      ...box('moov', 1000),
      ...box('moof', 50),
      ...box('mdat', 500),
    ]);
    expect(initSectionLength(bytes)).toBe(32 + 1008);
  });

  it('throws on a file that was never fragmented', () => {
    expect(() =>
      initSectionLength(new Uint8Array([...box('ftyp', 24), ...box('mdat', 9)]))
    ).toThrow(/no moof/);
  });
});

describe('writeFragmentedCopy', () => {
  it('repackages from ranged reads and a streamed upload, never the whole clip at once', async () => {
    await writeFragmentedCopy(CLIP_KEY);

    const sidecar = JSON.parse(
      new TextDecoder().decode(objects.get('videos/team/clip.mp4.frag.json'))
    );
    expect(sidecar.videoCodec).toBe('avc');
    expect(sidecar.hasAudio).toBe(false);
    expect(sidecar.durationSeconds).toBeCloseTo(0.5, 2);
    expect(sidecar.initBytes).toBeGreaterThan(0);
    expect(sidecar.size).toBeGreaterThan(sidecar.initBytes);

    const frag = objects.get('videos/team/clip.mp4.frag.mp4');
    if (!frag) throw new Error('fragmented copy was not uploaded');
    expect(initSectionLength(frag)).toBe(sidecar.initBytes);
    expect(frag.byteLength).toBe(sidecar.size);

    const clipReads = readStorageObject.mock.calls.filter(
      ([key]) => key === CLIP_KEY
    );
    expect(clipReads.length).toBeGreaterThan(0);
    expect(
      clipReads.every(
        ([, range]) =>
          range != null &&
          Number.isInteger(range.offset) &&
          Number.isInteger(range.length)
      )
    ).toBe(true);
    expect(uploads.find((u) => u.path.endsWith('.frag.mp4'))?.kind).toBe(
      'stream'
    );
  });

  it('skips remux when the sidecar is already there', async () => {
    await writeFragmentedCopy(CLIP_KEY);
    const firstUploads = uploads.length;
    readStorageObject.mockClear();
    uploadFile.mockClear();
    await writeFragmentedCopy(CLIP_KEY);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(uploads.length).toBe(firstUploads);
  });

  it('remuxes when the sidecar is not valid JSON', async () => {
    objects.set(
      'videos/team/clip.mp4.frag.json',
      new TextEncoder().encode('not-json{')
    );
    await writeFragmentedCopy(CLIP_KEY);
    const sidecar = JSON.parse(
      new TextDecoder().decode(objects.get('videos/team/clip.mp4.frag.json'))
    );
    expect(sidecar.videoCodec).toBe('avc');
    expect(sidecar.size).toBeGreaterThan(sidecar.initBytes);
  });
});

describe('ensureFragmentedClips', () => {
  it('lists sidecar copies and does not remux', async () => {
    await writeFragmentedCopy(CLIP_KEY);
    readStorageObject.mockClear();
    uploadFile.mockClear();
    uploads.length = 0;

    const [result] = await ensureFragmentedClips(
      ['/r2/videos/team/clip.mp4'],
      'https://app.test'
    );
    expect(result?.url).toBe(
      'https://app.test/r2/videos/team/clip.mp4.frag.mp4'
    );
    expect(result?.videoCodec).toBe('avc');
    expect(uploadFile).not.toHaveBeenCalled();
    expect(
      readStorageObject.mock.calls.every(([key]) => key.endsWith('.frag.json'))
    ).toBe(true);
  });

  it('refuses a clip that was never fragmented at ingest', async () => {
    await expect(
      ensureFragmentedClips(['/r2/videos/team/clip.mp4'], 'https://app.test')
    ).rejects.toBeInstanceOf(ValidationError);
    expect(uploads).toEqual([]);
  });

  it('refuses a clip whose sidecar is not valid JSON', async () => {
    objects.set(
      'videos/team/clip.mp4.frag.json',
      new TextEncoder().encode('not-json{')
    );
    await expect(
      ensureFragmentedClips(['/r2/videos/team/clip.mp4'], 'https://app.test')
    ).rejects.toBeInstanceOf(ValidationError);
    expect(uploads).toEqual([]);
  });
});
