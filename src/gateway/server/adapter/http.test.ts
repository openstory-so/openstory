/** The HTTP transport: hosted gateway calls on the install's key, outputs copied here, no local hold or debit (#2438). */

import { describe, expect, it, vi } from 'vitest';
import type { GatewayMedia } from '@/gateway/server/providers';
import { z } from 'zod';

const KEY = `osk_${'k'.repeat(64)}`;
const env: Record<string, string | undefined> = {
  OPENSTORY_API_KEY: KEY,
  OPENSTORY_GATEWAY_URL: 'https://hosted.example',
};
vi.doMock('#env', () => ({ getEnv: () => env }));
/** The install's provenance records; every other key reads as a stored image. */
const provenance = new Map<string, Uint8Array>();
vi.doMock('#storage', () => ({
  readStorageObject: vi.fn(async (key: string) => {
    if (key.startsWith('gateway-provenance/')) {
      const bytes = provenance.get(key);
      return bytes ? { bytes, contentType: 'text/plain' } : null;
    }
    return { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' };
  }),
  uploadFile: vi.fn(async (bucket: string, path: string, bytes: Uint8Array) => {
    provenance.set(`${bucket}/${path}`, bytes);
  }),
}));
const { sha256Hex } = await import('@/platform/compliance/hash');
const provenanceKey = async (r2Key: string) =>
  `gateway-provenance/${await sha256Hex(r2Key)}`;

const { gatewayPoller, gatewayTransport } = await import('./http');
const { runGatewayToEnd } = await import('./index');
const { NonRetryableError } = await import('cloudflare:workflows');
const submitJob = await import('../submit-job');

const ROUTE = {
  via: 'remote',
  target: { provider: 'grok', modelId: 'grok-imagine-image' },
} as const;

function job(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: '01M8B00000000000000000JB01',
    provider: 'grok',
    model: 'grok-imagine-image',
    kind: 'image',
    status,
    outputs: [],
    error: null,
    charge: null,
    createdAt: '2026-11-26T00:00:00.000Z',
    completedAt: null,
    _links: {
      self: { href: '/api/v1/gateway/jobs/01M8B00000000000000000JB01' },
    },
    ...extra,
  };
}

const SUCCEEDED = job('succeeded', {
  outputs: [
    {
      url: 'https://hosted.example/r2/thumbnails/out.jpg',
      contentType: 'image/jpeg',
    },
  ],
  charge: { totalMicros: 20_000, lines: [] },
});

/** A hosted gateway that answers each path in turn and records what it was sent. */
function hosted(answers: Record<string, Response[]>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push({ url, init: init ?? {} });
      const path = new URL(url).pathname;
      const next = answers[path]?.shift();
      if (!next) throw new Error(`unexpected call ${url}`);
      return next;
    });
  return { calls, restore: () => fetchSpy.mockRestore() };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** A scopedDb any touch of which fails, bar the organization id: the remote path must not read, hold or debit locally. */
const untouchable = new Proxy(
  {},
  {
    get: (_target, prop) => {
      if (prop === 'organizationId') return 'o';
      throw new Error(`the remote path touched scopedDb.${String(prop)}`);
    },
  }
);

function transport() {
  const stored: GatewayMedia[] = [];
  const { transport } = gatewayTransport(ROUTE, {
    // @ts-expect-error -- any read, hold or debit on it throws
    scopedDb: untouchable,
    runId: 'run-1',
    store: async (media, index) => {
      stored.push(media);
      return {
        url: `/r2/thumbnails/local/output-${index}.jpg`,
        path: `local/output-${index}.jpg`,
        contentType: 'image/jpeg',
      };
    },
    uploadRightsChecked: submitJob.UPLOAD_RIGHTS_CHECKED,
    reservation: { id: 'run-reservation' },
  });
  return { transport, stored };
}

describe('the HTTP transport', () => {
  it('uploads local files, submits under the key, polls, and copies the outputs here with no local hold or debit', async () => {
    const server = hosted({
      '/api/v1/gateway/uploads': [
        json({ url: 'https://hosted.example/r2/gateway-uploads/o/a.png' }, 201),
      ],
      '/api/v1/gateway/grok/grok-imagine-image': [json(job('queued'), 202)],
      '/api/v1/gateway/jobs/01M8B00000000000000000JB01': [
        json(job('running')),
        json(SUCCEEDED),
      ],
    });
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1_000 });
    try {
      const { transport: gateway, stored } = transport();
      const done = await runGatewayToEnd(
        gateway,
        { idempotencyKey: 'run-1:still' },
        { prompt: 'Mara at the dryer', image: '/r2/characters/o/sheet.png' }
      );
      expect(done.outputs).toEqual([
        {
          url: '/r2/thumbnails/local/output-0.jpg',
          path: 'local/output-0.jpg',
          contentType: 'image/jpeg',
        },
      ]);
      expect(stored).toEqual([
        {
          url: 'https://hosted.example/r2/thumbnails/out.jpg',
          contentType: 'image/jpeg',
        },
      ]);
      const submit = server.calls[1];
      expect(JSON.parse(z.string().parse(submit?.init.body))).toEqual({
        prompt: 'Mara at the dryer',
        image: 'https://hosted.example/r2/gateway-uploads/o/a.png',
      });
      expect(new Headers(submit?.init.headers).get('idempotency-key')).toBe(
        'run-1:still'
      );
      for (const call of server.calls) {
        expect(new Headers(call.init.headers).get('authorization')).toBe(
          `Bearer ${KEY}`
        );
        expect(call.url).not.toContain(KEY);
        // A redirect would carry the key to another origin: it fails instead.
        expect(call.init.redirect).toBe('error');
      }
      expect(server.calls[2]?.url).toContain('?wait=');
    } finally {
      vi.useRealTimers();
      server.restore();
    }
  });

  it('names an upload by the call and the file, so a retried step sends the same body', async () => {
    const keys: (string | null)[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const server = hosted({
        '/api/v1/gateway/uploads': [json({ url: 'https://h/u.png' }, 201)],
        '/api/v1/gateway/grok/grok-imagine-image': [json(SUCCEEDED, 202)],
      });
      try {
        await transport().transport.submit(
          { image: '/r2/characters/o/sheet.png' },
          'run-1:still'
        );
        keys.push(
          new Headers(server.calls[0]?.init.headers).get('idempotency-key')
        );
      } finally {
        server.restore();
      }
    }
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('surfaces a hosted refusal unchanged and never retries it', async () => {
    const server = hosted({
      '/api/v1/gateway/grok/grok-imagine-image': [
        json(
          {
            error: {
              code: 'INSUFFICIENT_CREDITS',
              message: 'Insufficient credits',
            },
          },
          402
        ),
      ],
    });
    try {
      const submitted = transport().transport.submit({ n: 1 }, 'k');
      await expect(submitted).rejects.toBeInstanceOf(NonRetryableError);
      await expect(submitted).rejects.toThrow(
        'INSUFFICIENT_CREDITS: Insufficient credits'
      );
    } finally {
      server.restore();
    }
  });

  it('leaves a hosted 5xx or 429 to the step retry', async () => {
    const server = hosted({
      '/api/v1/gateway/grok/grok-imagine-image': [json({}, 503)],
    });
    try {
      const submitted = transport().transport.submit({ n: 1 }, 'k');
      await expect(submitted).rejects.not.toBeInstanceOf(NonRetryableError);
    } finally {
      server.restore();
    }
  });

  it('polls a remote video handle over HTTP and a failed job reads as its code', async () => {
    const server = hosted({
      '/api/v1/gateway/jobs/01M8B00000000000000000JB01': [
        json(
          job('failed', {
            error: {
              code: 'CONTENT_REJECTED',
              message: 'The provider refused the content of this request.',
            },
          })
        ),
      ],
    });
    try {
      const poller = gatewayPoller('remote:01M8B00000000000000000JB01', {
        // @ts-expect-error -- the remote poll must not touch it
        scopedDb: untouchable,
        store: async () => {
          throw new Error('nothing to store');
        },
      });
      expect(await poller.poll('remote:01M8B00000000000000000JB01')).toEqual({
        kind: 'failed',
        error:
          'CONTENT_REJECTED: The provider refused the content of this request.',
      });
    } finally {
      server.restore();
    }
  });

  it("refuses another organization's stored file before reading or sending anything", async () => {
    const server = hosted({});
    const { readStorageObject } = await import('#storage');
    vi.mocked(readStorageObject).mockClear();
    try {
      await expect(
        transport().transport.submit(
          { image: '/r2/characters/other-org/sheet.png' },
          'run-1:still'
        )
      ).rejects.toThrow('An input file belongs to another organization');
      expect(readStorageObject).not.toHaveBeenCalled();
      expect(server.calls).toHaveLength(0);
    } finally {
      server.restore();
    }
  });

  describe('hosted outputs go back as hosted URLs (#2438)', () => {
    it('records where each copied output came from', async () => {
      provenance.clear();
      const server = hosted({
        '/api/v1/gateway/grok/grok-imagine-image': [json(SUCCEEDED, 202)],
      });
      try {
        await transport().transport.submit({ prompt: 'Mara' }, 'run-1:still');
        const recorded = provenance.get(
          await provenanceKey('thumbnails/local/output-0.jpg')
        );
        expect(new TextDecoder().decode(recorded)).toBe(
          'https://hosted.example/r2/thumbnails/out.jpg'
        );
      } finally {
        server.restore();
      }
    });

    it('sends a recorded still or take as its hosted URL and uploads nothing', async () => {
      provenance.clear();
      for (const [key, hostedUrl] of [
        ['characters/o/sheet.png', 'https://hosted.example/r2/x/sheet.png'],
        ['audio/o/take.wav', 'https://hosted.example/r2/audio/take.wav'],
      ] as const) {
        provenance.set(
          await provenanceKey(key),
          new TextEncoder().encode(hostedUrl)
        );
      }
      const server = hosted({
        '/api/v1/gateway/grok/grok-imagine-image': [json(job('queued'), 202)],
      });
      try {
        await transport().transport.submit(
          {
            image: '/r2/characters/o/sheet.png',
            audio: '/r2/audio/o/take.wav',
          },
          'run-1:clip'
        );
        expect(server.calls).toHaveLength(1);
        expect(
          JSON.parse(z.string().parse(server.calls[0]?.init.body))
        ).toEqual({
          image: 'https://hosted.example/r2/x/sheet.png',
          audio: 'https://hosted.example/r2/audio/take.wav',
        });
      } finally {
        server.restore();
      }
    });

    it('refuses audio the hosted gateway did not make, before sending anything', async () => {
      provenance.clear();
      const server = hosted({});
      try {
        const error = await transport()
          .transport.submit({ audio: '/r2/audio/o/mic.wav' }, 'run-1:clip')
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NonRetryableError);
        expect(error).toMatchObject({
          message: expect.stringContaining(
            'Audio recorded or made on this install'
          ),
        });
        expect(server.calls).toHaveLength(0);
      } finally {
        server.restore();
      }
    });
  });

  it('refuses a model id or job id that could retarget the request', async () => {
    const server = hosted({});
    try {
      for (const modelId of ['../jobs/x', 'a?b', 'a%2Fb', 'a#b', 'a/../b']) {
        const { transport: gateway } = gatewayTransport(
          { via: 'remote', target: { provider: 'grok', modelId } },
          {
            // @ts-expect-error -- any read, hold or debit on it throws
            scopedDb: untouchable,
            runId: 'run-1',
            store: async () => ({ url: '', path: '', contentType: '' }),
            uploadRightsChecked: submitJob.UPLOAD_RIGHTS_CHECKED,
            reservation: null,
          }
        );
        await expect(gateway.submit({}, 'k'), modelId).rejects.toThrow(
          'Not a model id the hosted gateway takes'
        );
      }
      expect(() =>
        gatewayPoller('remote:../uploads', {
          // @ts-expect-error -- any read, hold or debit on it throws
          scopedDb: untouchable,
          store: async () => ({ url: '', path: '', contentType: '' }),
        })
      ).toThrow('not a ULID');
      expect(server.calls).toHaveLength(0);
    } finally {
      server.restore();
    }
  });
});
