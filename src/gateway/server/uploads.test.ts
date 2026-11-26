/** `POST /api/v1/gateway/uploads` storage (#2438): fresh ids, create-only writes, a key maps to one file, a refused file is gone. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AttestationRequiredError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { StorageFileExistsError } from '@/platform/server/storage/buckets';
import { asStub } from '@/test/as-stub';

type Stored = { bytes: Uint8Array; contentType: string | undefined };

/** An in-memory R2 binding: `put` honours `if-none-match: *` atomically, as R2 does. */
const r2 = vi.hoisted(() => {
  const objects = new Map<string, Stored>();
  return {
    objects,
    binding: {
      async put(
        key: string,
        value:
          | ReadableStream<Uint8Array>
          | ArrayBuffer
          | Uint8Array<ArrayBuffer>,
        options?: {
          httpMetadata?: { contentType?: string };
          onlyIf?: Headers;
        }
      ) {
        const bytes = new Uint8Array(await new Response(value).arrayBuffer());
        if (options?.onlyIf?.get('if-none-match') === '*' && objects.has(key)) {
          return null;
        }
        objects.set(key, {
          bytes,
          contentType: options?.httpMetadata?.contentType,
        });
        return { key };
      },
      async get(key: string) {
        const object = objects.get(key);
        if (!object) return null;
        return {
          arrayBuffer: async () => object.bytes.slice().buffer,
          httpMetadata: { contentType: object.contentType },
        };
      },
      async delete(key: string) {
        objects.delete(key);
      },
      async list(options: { prefix: string; limit: number }) {
        const listed = [...objects.entries()]
          .filter(([key]) => key.startsWith(options.prefix))
          .map(([key, object]) => ({
            key,
            size: object.bytes.byteLength,
            uploaded: new Date(0),
            httpMetadata: { contentType: object.contentType },
          }));
        return {
          objects: listed.slice(0, options.limit),
          truncated: listed.length > options.limit,
          cursor: 'next',
        };
      },
    },
  };
});
const limiter = vi.hoisted(() => ({ limit: vi.fn() }));
vi.mock('cloudflare:workers', () => ({
  env: { R2_STORAGE_BUCKET: r2.binding, GATEWAY_UPLOAD_RATE_LIMITER: limiter },
}));
const requireGenerationAllowed = vi.hoisted(() => vi.fn());
vi.mock('@/platform/server/compliance/generation-gate', () => ({
  requireGenerationAllowed,
}));
vi.mock(
  '#storage',
  () => import('@/platform/server/storage/storage-cloudflare')
);

const requireCheckedUploadRights = vi.hoisted(() => vi.fn());
vi.mock('@/cast/server/upload-check', () => ({ requireCheckedUploadRights }));
vi.mock('@/gateway/server/platform-credentials', () => ({
  withPlatformLlmKey: (db: unknown) => db,
}));

const { storeGatewayUpload } = await import('./uploads');
const { uploadFile } =
  await import('@/platform/server/storage/storage-cloudflare');

const ORG = '01KORGANIZATIONA0000000000';
const hasEnoughCredits = vi.fn();
const scopedDb = asStub<ScopedDb>({
  organizationId: ORG,
  userId: 'u1',
  billing: { hasEnoughCredits },
});

function uploadRequest(
  bytes: string,
  key = 'job-1:still',
  headers: Record<string, string> = {}
) {
  return new Request('https://openstory.so/api/v1/gateway/uploads', {
    method: 'POST',
    headers: {
      'content-type': 'image/png',
      'content-length': String(bytes.length),
      'idempotency-key': key,
      ...headers,
    },
    body: bytes,
  });
}

const mediaKeys = () =>
  [...r2.objects.keys()].filter((key) => !key.includes('/keys/'));

beforeEach(() => {
  r2.objects.clear();
  requireCheckedUploadRights.mockReset();
  requireCheckedUploadRights.mockResolvedValue(undefined);
  limiter.limit.mockReset();
  limiter.limit.mockResolvedValue({ success: true });
  requireGenerationAllowed.mockReset();
  requireGenerationAllowed.mockResolvedValue(undefined);
  hasEnoughCredits.mockReset();
  hasEnoughCredits.mockResolvedValue(true);
});

describe('gateway uploads', () => {
  it('refuses a second create-only write to an existing key and keeps the first bytes', async () => {
    await uploadFile('gateway-uploads', `${ORG}/a.png`, new Uint8Array([1]), {
      upsert: false,
    });
    await expect(
      uploadFile('gateway-uploads', `${ORG}/a.png`, new Uint8Array([2]), {
        upsert: false,
      })
    ).rejects.toBeInstanceOf(StorageFileExistsError);
    expect(r2.objects.get(`gateway-uploads/${ORG}/a.png`)?.bytes).toEqual(
      new Uint8Array([1])
    );
  });

  it("stores under a fresh ULID in the caller's organization, checks that exact URL, and answers it", async () => {
    const { url } = await storeGatewayUpload(scopedDb, uploadRequest('png'));
    expect(url).toMatch(
      new RegExp(
        `^https://openstory\\.so/r2/gateway-uploads/${ORG}/[0-9A-HJKMNP-TV-Z]{26}\\.png$`
      )
    );
    expect(requireCheckedUploadRights).toHaveBeenCalledWith(
      scopedDb,
      [url],
      expect.anything()
    );
  });

  it('maps one Idempotency-Key to one file: a replay answers it and never rewrites it', async () => {
    const first = await storeGatewayUpload(scopedDb, uploadRequest('png'));
    const second = await storeGatewayUpload(
      scopedDb,
      uploadRequest('other bytes')
    );
    expect(second.url).toBe(first.url);
    expect(mediaKeys()).toHaveLength(1);
    const [only] = mediaKeys();
    expect(new TextDecoder().decode(r2.objects.get(only ?? '')?.bytes)).toBe(
      'png'
    );
  });

  it('gives a new key a new file', async () => {
    const a = await storeGatewayUpload(scopedDb, uploadRequest('a', 'k1'));
    const b = await storeGatewayUpload(scopedDb, uploadRequest('b', 'k2'));
    expect(a.url).not.toBe(b.url);
  });

  it('an upload that fails the rights check leaves nothing servable and no key mapping', async () => {
    requireCheckedUploadRights.mockRejectedValueOnce(
      new AttestationRequiredError('needs a portrait attestation')
    );
    await expect(
      storeGatewayUpload(scopedDb, uploadRequest('person'))
    ).rejects.toBeInstanceOf(AttestationRequiredError);
    expect(r2.objects.size).toBe(0);
  });

  describe('refuses before any byte is stored or checked', () => {
    const nothingSpent = () => {
      expect(r2.objects.size).toBe(0);
      expect(requireCheckedUploadRights).not.toHaveBeenCalled();
    };

    it('over the per-organization upload rate', async () => {
      limiter.limit.mockResolvedValue({ success: false });
      const refusal = await storeGatewayUpload(
        scopedDb,
        uploadRequest('png')
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(Response);
      expect(refusal instanceof Response && refusal.status).toBe(429);
      expect(limiter.limit).toHaveBeenCalledWith({ key: ORG });
      nothingSpent();
    });

    it('for a blocked organization', async () => {
      requireGenerationAllowed.mockRejectedValue(
        new Error('Account restricted')
      );
      await expect(
        storeGatewayUpload(scopedDb, uploadRequest('png'))
      ).rejects.toThrow('Account restricted');
      nothingSpent();
    });

    it('when the organization cannot pay for the check', async () => {
      hasEnoughCredits.mockResolvedValue(false);
      await expect(
        storeGatewayUpload(scopedDb, uploadRequest('png'))
      ).rejects.toThrow('Insufficient credits to check an upload');
      nothingSpent();
    });

    it('over the size cap by declared length', async () => {
      await expect(
        storeGatewayUpload(
          scopedDb,
          uploadRequest('png', 'k', {
            'content-length': String(20 * 1024 * 1024 + 1),
          })
        )
      ).rejects.toThrow('at most 20 MB for image');
      nothingSpent();
    });

    it('when the stream carries more than it declared', async () => {
      const lying = new Request('https://openstory.so/api/v1/gateway/uploads', {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          'content-length': '3',
          'idempotency-key': 'k',
        },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('png'));
            controller.enqueue(new TextEncoder().encode('more'));
            controller.close();
          },
        }),
        duplex: 'half',
      });
      await expect(storeGatewayUpload(scopedDb, lying)).rejects.toThrow(
        'longer than its Content-Length'
      );
      nothingSpent();
    });

    it('when the organization already keeps its cap of uploads', async () => {
      for (let i = 0; i < 500; i++) {
        r2.objects.set(`gateway-uploads/${ORG}/${i}.png`, {
          bytes: new Uint8Array([1]),
          contentType: 'image/png',
        });
      }
      await expect(
        storeGatewayUpload(scopedDb, uploadRequest('png'))
      ).rejects.toThrow('at most 500 gateway uploads');
      expect(r2.objects.size).toBe(500);
      expect(requireCheckedUploadRights).not.toHaveBeenCalled();
    });
  });
});
