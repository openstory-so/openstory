import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stitch } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { asStub } from '@/test/as-stub';

const fileExists = vi.fn();
const classifyUpload = vi.fn();
const attestUploads = vi.fn();
vi.doMock('#storage', () => ({ fileExists }));
vi.doMock('@/cast/server/upload-rights', () => ({
  classifyUpload,
  attestUploads,
}));

const { publishStitch } = await import('./publish-stitch');

const STILL = '/r2/stitches/T/S/0.png';
const LINE = '/r2/stitches/T/S/1.wav';
const row = (publishedAt: Date | null) =>
  asStub<Stitch>({
    id: 'S',
    teamId: 'T',
    userId: 'U',
    publishedAt,
    createdAt: new Date('2026-10-19T00:00:00Z'),
    cut: {
      clips: [
        {
          imageUrl: STILL,
          fallbackImageUrl: null,
          durationSeconds: 3,
          audioUrls: [LINE],
          width: 1,
          height: 1,
          cues: [],
        },
      ],
      frameWidth: 16,
      frameHeight: 9,
      musicUrl: LINE,
      musicGainDb: 0,
    },
  });

const getById = vi.fn();
const publish = vi.fn();
const scopedDb = asStub<ScopedDb>({ stitches: { getById, publish } });
const args = {
  scopedDb,
  userId: 'U',
  id: 'S',
  portraitAttestation: null,
  request: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  getById.mockResolvedValue(row(null));
  publish.mockImplementation(async () => row(new Date()));
  fileExists.mockResolvedValue(true);
  classifyUpload.mockResolvedValue({ status: 'cleared' });
});

describe('publishStitch (#2127)', () => {
  it('404s a stitch the team does not have', async () => {
    getById.mockResolvedValue(null);
    await expect(publishStitch(args)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('names the file that was never uploaded and publishes nothing', async () => {
    fileExists.mockImplementation(async (_bucket: string, path: string) =>
      path.endsWith('.png')
    );
    await expect(publishStitch(args)).rejects.toThrow(
      '1.wav was not uploaded.'
    );
    expect(classifyUpload).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('checks every image once, in the bucket, before publishing', async () => {
    const published = await publishStitch(args);
    expect(published.publishedAt).not.toBeNull();
    expect(fileExists).toHaveBeenCalledWith('stitches', 'T/S/0.png');
    expect(fileExists).toHaveBeenCalledWith('stitches', 'T/S/1.wav');
    // The line is used twice (clip and bed) and is sound: not classified.
    expect(classifyUpload).toHaveBeenCalledTimes(1);
    expect(classifyUpload).toHaveBeenCalledWith(
      expect.objectContaining({ url: STILL, userId: 'U' })
    );
    expect(attestUploads).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith('S');
  });

  it('needs the portrait sign-off for a real person, and records it', async () => {
    classifyUpload.mockResolvedValue({ status: 'needs_portrait' });
    await expect(publishStitch(args)).rejects.toMatchObject({
      code: 'ATTESTATION_REQUIRED',
    });
    expect(publish).not.toHaveBeenCalled();

    const attestation = {
      statementVersion: 'portrait-rights-v1' as const,
      authorizationBasis: 'self',
    };
    await publishStitch({ ...args, portraitAttestation: attestation });
    expect(attestUploads).toHaveBeenCalledWith(
      scopedDb,
      [{ url: STILL, ...attestation }],
      args.request
    );
    expect(publish).toHaveBeenCalledWith('S');
  });

  it('checks a file any slot shows as a picture, even one a video slot also names', async () => {
    const base = row(null);
    getById.mockResolvedValue({
      ...base,
      cut: {
        ...base.cut,
        clips: [
          ...base.cut.clips,
          // The still again, misfiled as a clip: it is still a picture.
          { videoUrl: STILL, posterUrl: null, cues: [] },
        ],
      },
    });
    classifyUpload.mockResolvedValue({ status: 'needs_portrait' });
    await expect(publishStitch(args)).rejects.toMatchObject({
      code: 'ATTESTATION_REQUIRED',
    });
    expect(classifyUpload).toHaveBeenCalledTimes(1);
  });

  it('answers a concurrent publish with the published row, not an error', async () => {
    const at = new Date('2026-10-19T03:00:00Z');
    publish.mockResolvedValue(null);
    getById.mockResolvedValueOnce(row(null)).mockResolvedValueOnce(row(at));
    expect((await publishStitch(args)).publishedAt).toBe(at);
  });

  it('is idempotent once published', async () => {
    const at = new Date('2026-10-19T01:00:00Z');
    getById.mockResolvedValue(row(at));
    expect((await publishStitch(args)).publishedAt).toBe(at);
    expect(fileExists).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
