/**
 * ModelArk private asset library (Advanced Creation Rights).
 *
 * Seedance 2.5/2.0 refuse a public URL that *may contain a real person*.
 * Rights unlock this API so we can register the still and pass `asset://<id>`
 * on the video task instead. Virtual (AIGC) groups cover photorealistic
 * generated faces; a real-human (LivenessFace) group still needs the person
 * to complete H5 verification — out of scope here.
 */

import {
  bytePlusOpenApi,
  withProject,
  type BytePlusOpenApiConfig,
} from './byteplus-openapi';

export const OPENSTORY_AIGC_GROUP_NAME = 'openstory-virtual';

export type BytePlusAssetKind = 'Image' | 'Video' | 'Audio';
type BytePlusAssetStatus = 'Active' | 'Processing' | 'Failed';

export type BytePlusAsset = {
  Id?: string;
  Name?: string;
  Status?: BytePlusAssetStatus;
  AssetType?: BytePlusAssetKind;
  GroupId?: string;
};

export type BytePlusAssetGroup = {
  Id?: string;
  Name?: string;
  GroupType?: string;
};

function assetNameFor(identity: string): string {
  // CreateAsset Name is max 64 chars and is the ListAssets search key.
  return `os-${identity}`.slice(0, 64);
}

export async function hashAssetIdentity(identity: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(identity)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function listAssetGroups(
  config: BytePlusOpenApiConfig,
  name: string
): Promise<BytePlusAssetGroup[]> {
  const result = await bytePlusOpenApi<{ Items?: BytePlusAssetGroup[] }>(
    config,
    'ListAssetGroups',
    withProject(config, {
      Filter: { Name: name, GroupType: 'AIGC' },
      PageNumber: 1,
      PageSize: 20,
    })
  );
  return (result.Items ?? []).filter((item) => item.Name === name);
}

async function createAssetGroup(
  config: BytePlusOpenApiConfig,
  name: string
): Promise<string> {
  const result = await bytePlusOpenApi<{ Id?: string }>(
    config,
    'CreateAssetGroup',
    withProject(config, {
      Name: name,
      Description: 'OpenStory virtual portrait stills for Seedance',
      GroupType: 'AIGC',
    })
  );
  if (!result.Id) {
    throw new Error('BytePlus CreateAssetGroup returned no Id');
  }
  return result.Id;
}

async function resolveAigcGroupId(
  config: BytePlusOpenApiConfig,
  existingGroupId?: string
): Promise<string> {
  if (existingGroupId) return existingGroupId;
  const existing = await listAssetGroups(config, OPENSTORY_AIGC_GROUP_NAME);
  const found = existing[0]?.Id;
  if (found) return found;
  return createAssetGroup(config, OPENSTORY_AIGC_GROUP_NAME);
}

async function listAssetsByName(
  config: BytePlusOpenApiConfig,
  groupId: string,
  name: string
): Promise<BytePlusAsset[]> {
  const result = await bytePlusOpenApi<{ Items?: BytePlusAsset[] }>(
    config,
    'ListAssets',
    withProject(config, {
      Filter: { Name: name, GroupIds: [groupId], GroupType: 'AIGC' },
      PageNumber: 1,
      PageSize: 20,
    })
  );
  return (result.Items ?? []).filter((item) => item.Name === name);
}

async function createAsset(
  config: BytePlusOpenApiConfig,
  input: {
    groupId: string;
    url: string;
    name: string;
    assetType: BytePlusAssetKind;
  }
): Promise<string> {
  const result = await bytePlusOpenApi<{ Id?: string }>(
    config,
    'CreateAsset',
    withProject(config, {
      GroupId: input.groupId,
      URL: input.url,
      Name: input.name,
      AssetType: input.assetType,
    })
  );
  if (!result.Id) {
    throw new Error('BytePlus CreateAsset returned no Id');
  }
  return result.Id;
}

async function getAsset(
  config: BytePlusOpenApiConfig,
  id: string
): Promise<BytePlusAsset> {
  return bytePlusOpenApi<BytePlusAsset>(
    config,
    'GetAsset',
    withProject(config, { Id: id })
  );
}

async function waitForAssetActive(
  config: BytePlusOpenApiConfig,
  id: string,
  options?: {
    sleep?: (ms: number) => Promise<void>;
    maxAttempts?: number;
    delayMs?: number;
  }
): Promise<BytePlusAsset> {
  const sleep =
    options?.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options?.maxAttempts ?? 24;
  const delayMs = options?.delayMs ?? 2000;

  let last: BytePlusAsset | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    last = await getAsset(config, id);
    if (last.Status === 'Active') return last;
    if (last.Status === 'Failed') {
      throw new Error(`BytePlus asset ${id} failed processing`);
    }
    if (attempt < maxAttempts - 1) await sleep(delayMs);
  }
  throw new Error(
    `BytePlus asset ${id} still ${last?.Status ?? 'unknown'} after ${maxAttempts} polls`
  );
}

export async function ingestAigcAsset(
  config: BytePlusOpenApiConfig,
  input: {
    identity: string;
    publicUrl: string;
    assetType: BytePlusAssetKind;
    groupId?: string;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<string> {
  const groupId = await resolveAigcGroupId(config, input.groupId);
  const name = assetNameFor(await hashAssetIdentity(input.identity));
  const existing = await listAssetsByName(config, groupId, name);
  const active = existing.find((item) => item.Status === 'Active' && item.Id);
  if (active?.Id) return `asset://${active.Id}`;

  const processing = existing.find(
    (item) => item.Status === 'Processing' && item.Id
  );
  const id =
    processing?.Id ??
    (await createAsset(config, {
      groupId,
      url: input.publicUrl,
      name,
      assetType: input.assetType,
    }));
  const ready = await waitForAssetActive(config, id, { sleep: input.sleep });
  if (!ready.Id) {
    throw new Error('BytePlus GetAsset returned Active with no Id');
  }
  return `asset://${ready.Id}`;
}
