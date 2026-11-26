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
    },
  };
});
vi.mock('cloudflare:workers', () => ({
  env: { R2_STORAGE_BUCKET: r2.binding },
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
const scopedDb = asStub<ScopedDb>({ organizationId: ORG, userId: 'u1' });

function uploadRequest(bytes: string, key = 'job-1:still') {
  return new Request('https://openstory.so/api/v1/gateway/uploads', {
    method: 'POST',
    headers: {
      'content-type': 'image/png',
      'content-length': String(bytes.length),
      'idempotency-key': key,
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
});
