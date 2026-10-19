/**
 * The two stitch routes of the public API (#2127), driven as the CLI drives
 * them: POST the cut, then POST publish. The scoped db and the publish step
 * are fakes; what is pinned is the wire: the 400s, the 201 and its links, and
 * that the stored cut carries the middleware's team, never the body's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const create = vi.fn();
const publishStitch = vi.fn();
vi.doMock('@/stitches/server/publish-stitch', () => ({ publishStitch }));

const { Route: CreateRoute } = await import('@/routes/api/v1/stitches');
const { Route: PublishRoute } =
  await import('@/routes/api/v1/stitches.$id.publish');

type Handler = (ctx: {
  request: Request;
  params: { id: string };
  context: unknown;
}) => Promise<Response>;
const handlerSchema = z.custom<Handler>((v) => typeof v === 'function');
const postCreate = z
  .object({ POST: handlerSchema })
  .parse(CreateRoute.options.server?.handlers).POST;
const postPublish = z
  .object({ POST: handlerSchema })
  .parse(PublishRoute.options.server?.handlers).POST;

const context = {
  teamId: 'TEAM',
  user: { id: 'USER', email: 'u@example.com' },
  scopedDb: { stitches: { create } },
};
const cut = {
  clips: [{ videoUrl: 'media/0.mp4', posterUrl: 'media/1.png', cues: [] }],
  frameWidth: 16,
  frameHeight: 9,
  musicUrl: null,
  musicGainDb: 0,
};
const post = (body: string, id = 'S') =>
  new Request(
    `https://os.test/api/v1/stitches${id === 'S' ? '' : `/${id}/publish`}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }
  );
const createCall = (body: string) =>
  postCreate({ request: post(body), params: { id: '' }, context });

beforeEach(() => {
  vi.clearAllMocks();
  create.mockImplementation(async (input) => ({
    ...input,
    teamId: 'TEAM',
    userId: 'USER',
    createdAt: new Date('2026-10-19T00:00:00Z'),
  }));
});

describe('POST /api/v1/stitches', () => {
  it('400s a body that is not JSON, and writes nothing', async () => {
    const res = await createCall('{nope');
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('400s a cut that names anything but bundle media, and writes nothing', async () => {
    const outside = {
      ...cut,
      clips: [{ videoUrl: 'media/../x.mp4', posterUrl: null, cues: [] }],
    };
    const res = await createCall(JSON.stringify({ cut: outside }));
    expect(res.status).toBe(400);
    const body = z
      .object({ error: z.object({ code: z.string() }) })
      .parse(await res.json());
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(create).not.toHaveBeenCalled();
  });

  it('201s an unpublished row on the team path with upload and publish links', async () => {
    const res = await createCall(JSON.stringify({ cut }));
    expect(res.status).toBe(201);
    const input = z
      .object({
        id: z.string(),
        publishedAt: z.null(),
        cut: z.object({
          clips: z.array(
            z.object({ videoUrl: z.string(), posterUrl: z.string() })
          ),
        }),
      })
      .parse(create.mock.calls[0]?.[0]);
    expect(input.cut.clips[0]).toEqual({
      videoUrl: `/r2/stitches/TEAM/${input.id}/0.mp4`,
      posterUrl: `/r2/stitches/TEAM/${input.id}/1.png`,
    });
    const body = z
      .object({
        id: z.string(),
        url: z.string(),
        _links: z.object({
          upload: z.object({ href: z.string(), method: z.literal('PUT') }),
          publish: z.object({ href: z.string(), method: z.literal('POST') }),
        }),
      })
      .parse(await res.json());
    expect(body.id).toBe(input.id);
    expect(body.url).toBe(`https://os.test/stitch/${input.id}`);
    expect(body._links.upload.href).toBe(
      `/api/storage/upload?bucket=stitches&path=TEAM/${input.id}/{name}&contentType={type}`
    );
    expect(body._links.publish.href).toBe(
      `/api/v1/stitches/${input.id}/publish`
    );
  });
});

describe('POST /api/v1/stitches/$id/publish', () => {
  it('publishes with no body, and passes the attestation when sent', async () => {
    publishStitch.mockResolvedValue({
      id: 'ST',
      publishedAt: new Date('2026-10-19T02:00:00Z'),
    });
    const bare = await postPublish({
      request: post('', 'ST'),
      params: { id: 'ST' },
      context,
    });
    expect(bare.status).toBe(200);
    expect(publishStitch).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ST',
        userId: 'USER',
        portraitAttestation: null,
      })
    );
    const body = z
      .object({ url: z.string(), publishedAt: z.string() })
      .parse(await bare.json());
    expect(body.url).toBe('https://os.test/stitch/ST');
    expect(body.publishedAt).toBe('2026-10-19T02:00:00.000Z');

    const attestation = {
      statementVersion: 'portrait-rights-v1',
      authorizationBasis: 'self',
    };
    await postPublish({
      request: post(JSON.stringify({ portraitAttestation: attestation }), 'ST'),
      params: { id: 'ST' },
      context,
    });
    expect(publishStitch).toHaveBeenLastCalledWith(
      expect.objectContaining({ portraitAttestation: attestation })
    );
  });

  it('400s a body that is not JSON, like the create route', async () => {
    const res = await postPublish({
      request: post('{nope', 'ST'),
      params: { id: 'ST' },
      context,
    });
    expect(res.status).toBe(400);
    const body = z
      .object({ error: z.object({ code: z.string() }) })
      .parse(await res.json());
    expect(body.error.code).toBe('INVALID_JSON');
    expect(publishStitch).not.toHaveBeenCalled();
  });

  it('turns the publish step’s refusal into the error envelope', async () => {
    const { AttestationRequiredError } = await import('@/platform/errors');
    publishStitch.mockRejectedValue(
      new AttestationRequiredError('real person')
    );
    const res = await postPublish({
      request: post('', 'ST'),
      params: { id: 'ST' },
      context,
    });
    expect(res.status).toBe(400);
    const body = z
      .object({ error: z.object({ code: z.string() }) })
      .parse(await res.json());
    expect(body.error.code).toBe('ATTESTATION_REQUIRED');
  });
});
