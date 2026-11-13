/** R2 keys for gateway outputs: `teams/<organizationId>/gateway/<jobId>/output-<n>.<ext>`. */

import { organizationKeyPrefix } from '@/platform/server/storage/buckets';
import { getMimeTypeFromExtension } from '@/platform/server/storage/file';
import { uploadResponse } from '@/platform/server/storage/upload-response';
import {
  ACTIVITY_BUCKETS,
  outputExtension,
} from '@/studio/server/workflows/asset-generation-workflow';
import type { GatewayJobKind, GatewayJobOutput } from '@/gateway/schema';
import type { GatewayMedia } from '@/gateway/server/providers';

/** Streams one output into R2; runs in the step that produced it (#1645). */
export async function storeGatewayOutput(params: {
  media: GatewayMedia;
  kind: GatewayJobKind;
  organizationId: string;
  jobId: string;
  index: number;
}): Promise<GatewayJobOutput> {
  const { media } = params;
  let response: Response;
  let known: string | null;
  if ('base64' in media) {
    const bytes = Uint8Array.from(atob(media.base64), (c) => c.charCodeAt(0));
    response = new Response(bytes, {
      headers: { 'content-length': String(bytes.byteLength) },
    });
    known = media.contentType;
  } else {
    response = await fetch(media.url);
    if (!response.ok) {
      throw new Error(`Could not download the output (${response.status})`);
    }
    known = media.contentType ?? response.headers.get('content-type');
  }
  const extension = outputExtension('url' in media ? media.url : '', known);
  const contentType = known ?? getMimeTypeFromExtension(extension);
  const uploaded = await uploadResponse(
    response,
    ACTIVITY_BUCKETS[params.kind],
    `${organizationKeyPrefix(params.organizationId)}/gateway/${params.jobId}/output-${params.index}.${extension}`,
    { contentType }
  );
  return { url: uploaded.publicUrl, path: uploaded.path, contentType };
}
