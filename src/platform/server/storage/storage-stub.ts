/**
 * Storage default-resolution stub.
 *
 * Activated by the `default` branch of `#storage` in package.json's `imports`
 * map. Cloudflare Workers (dev + prod) hit the `workerd` branch which loads
 * `storage-cloudflare.ts`; this stub only resolves under non-Workerd consumers
 * (Storybook, unit tests). All real callers are server-side and either
 * stubbed out by `.storybook/server-stub-plugin.ts` or mocked via
 * `vi.doMock`, so this should never execute at runtime.
 *
 * Signatures mirror `storage-cloudflare.ts` exactly.
 */

import type {
  MultipartPart,
  StorageBucket,
  StorageFileInfo,
  UploadResult,
} from './buckets';

const throwStub = (): never => {
  throw new Error(
    '[storage-stub] storage helpers called in a non-Workerd runtime — only storage-cloudflare.ts should run at runtime.'
  );
};

export const uploadFile = (
  _bucket: StorageBucket,
  _path: string,
  _file: File | Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
  _options?: {
    upsert?: boolean;
    contentType?: string;
    cacheControl?: string;
  }
): Promise<UploadResult> => throwStub();

export const createMultipartUpload = (
  _bucket: StorageBucket,
  _path: string,
  _contentType?: string
): Promise<{ uploadId: string; key: string }> => throwStub();

export const uploadPart = (
  _bucket: StorageBucket,
  _path: string,
  _uploadId: string,
  _partNumber: number,
  _body: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | Blob
): Promise<MultipartPart> => throwStub();

export const completeMultipartUpload = (
  _bucket: StorageBucket,
  _path: string,
  _uploadId: string,
  _parts: MultipartPart[]
): Promise<UploadResult> => throwStub();

export const abortMultipartUpload = (
  _bucket: StorageBucket,
  _path: string,
  _uploadId: string
): Promise<void> => throwStub();

export const getSignedUrl = (
  _bucket: StorageBucket,
  _path: string,
  _expiresIn?: number
): Promise<string> => throwStub();

export const getSignedUrlWithDownload = (
  _bucket: StorageBucket,
  _path: string,
  _filename: string,
  _expiresIn?: number
): Promise<string> => throwStub();

export const getSignedUploadUrl = (
  _bucket: StorageBucket,
  _path: string,
  _contentType: string,
  _expiresIn?: number
): Promise<{
  uploadUrl: string;
  publicUrl: string;
  path: string;
  contentType: string;
}> => throwStub();

export const deleteFile = (
  _bucket: StorageBucket,
  _path: string
): Promise<void> => throwStub();

export const deleteFiles = (
  _bucket: StorageBucket,
  _paths: string[]
): Promise<void> => throwStub();

export const listFiles = (
  _bucket: StorageBucket,
  _path?: string,
  _options?: {
    limit?: number;
    offset?: number;
    sortBy?: { column: string; order: 'asc' | 'desc' };
  }
): Promise<StorageFileInfo[]> => throwStub();

export const moveFile = (
  _bucket: StorageBucket,
  _fromPath: string,
  _toPath: string
): Promise<void> => throwStub();

export const copyFile = (
  _bucket: StorageBucket,
  _fromPath: string,
  _toPath: string
): Promise<void> => throwStub();

export const fileExists = (
  _bucket: StorageBucket,
  _path: string
): Promise<boolean> => throwStub();

export const readStorageObject = (
  _key: string,
  _range?: { offset: number; length: number }
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string } | null> =>
  throwStub();

export const storageObjectSize = (_key: string): Promise<number | null> =>
  throwStub();

export const serveFile = (_key: string, _request: Request): Promise<Response> =>
  throwStub();
