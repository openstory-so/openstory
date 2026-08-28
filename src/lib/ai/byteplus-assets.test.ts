import { describe, expect, it } from 'vitest';
import {
  hashAssetIdentity,
  ingestAigcAsset,
  OPENSTORY_AIGC_GROUP_NAME,
  type BytePlusAsset,
  type BytePlusAssetGroup,
} from './byteplus-assets';
import type { BytePlusOpenApiConfig } from './byteplus-openapi';

type Handler = (body: Record<string, unknown>) => unknown;

function configWith(
  handlers: Record<string, Handler>,
  calls: string[]
): BytePlusOpenApiConfig {
  return {
    accessKey: 'AKTEST',
    secretKey: 'sk-test',
    now: () => new Date('2026-03-28T00:00:00.000Z'),
    fetch: async (input, init) => {
      const href =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(href);
      const action = url.searchParams.get('Action') ?? '';
      calls.push(action);
      const handler = handlers[action];
      if (!handler) {
        return new Response(`unexpected action ${action}`, { status: 500 });
      }
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      const parsed: unknown = JSON.parse(raw);
      const body: Record<string, unknown> = {};
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) {
          body[key] = value;
        }
      }
      const result = handler(body);
      return new Response(JSON.stringify({ Result: result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
}

describe('ingestAigcAsset', () => {
  it('creates an AIGC group and asset, then returns asset:// after Active', async () => {
    const calls: string[] = [];
    const config = configWith(
      {
        ListAssetGroups: () => ({ Items: [] as BytePlusAssetGroup[] }),
        CreateAssetGroup: (body) => {
          expect(body.Name).toBe(OPENSTORY_AIGC_GROUP_NAME);
          expect(body.GroupType).toBe('AIGC');
          return { Id: 'group-1' };
        },
        ListAssets: (body) => {
          const filter =
            typeof body.Filter === 'object' && body.Filter !== null
              ? body.Filter
              : {};
          expect(filter).toMatchObject({
            GroupType: 'AIGC',
            GroupIds: ['group-1'],
          });
          return { Items: [] as BytePlusAsset[] };
        },
        CreateAsset: (body) => {
          expect(body.GroupId).toBe('group-1');
          expect(body.URL).toBe('https://cdn.example.com/still.png');
          expect(body.AssetType).toBe('Image');
          return { Id: 'asset-1' };
        },
        GetAsset: () => ({ Id: 'asset-1', Status: 'Active' }),
      },
      calls
    );

    const uri = await ingestAigcAsset(config, {
      identity: '/r2/team/still.png',
      publicUrl: 'https://cdn.example.com/still.png',
      assetType: 'Image',
      sleep: async () => undefined,
    });

    expect(uri).toBe('asset://asset-1');
    expect(calls).toEqual([
      'ListAssetGroups',
      'CreateAssetGroup',
      'ListAssets',
      'CreateAsset',
      'GetAsset',
    ]);
  });

  it('reuses an Active asset with the same identity instead of creating another', async () => {
    const identity = '/r2/team/still.png';
    const namePrefix = `os-${await hashAssetIdentity(identity)}`.slice(0, 64);
    const calls: string[] = [];
    const config = configWith(
      {
        ListAssetGroups: () => ({
          Items: [
            {
              Id: 'group-1',
              Name: OPENSTORY_AIGC_GROUP_NAME,
              GroupType: 'AIGC',
            },
          ],
        }),
        ListAssets: () => ({
          Items: [{ Id: 'asset-existing', Name: namePrefix, Status: 'Active' }],
        }),
      },
      calls
    );

    const uri = await ingestAigcAsset(config, {
      identity,
      publicUrl: 'https://cdn.example.com/other.png',
      assetType: 'Image',
      groupId: 'group-1',
    });

    expect(uri).toBe('asset://asset-existing');
    expect(calls).toEqual(['ListAssets']);
  });

  it('polls Processing until Active', async () => {
    let polls = 0;
    const calls: string[] = [];
    const config = configWith(
      {
        ListAssets: () => ({ Items: [] as BytePlusAsset[] }),
        CreateAsset: () => ({ Id: 'asset-slow' }),
        GetAsset: () => {
          polls += 1;
          return {
            Id: 'asset-slow',
            Status: polls < 3 ? 'Processing' : 'Active',
          };
        },
      },
      calls
    );

    const uri = await ingestAigcAsset(config, {
      identity: 'still-a',
      publicUrl: 'https://cdn.example.com/a.png',
      assetType: 'Image',
      groupId: 'group-1',
      sleep: async () => undefined,
    });

    expect(uri).toBe('asset://asset-slow');
    expect(polls).toBe(3);
  });

  it('fails when processing ends in Failed', async () => {
    const config = configWith(
      {
        ListAssets: () => ({ Items: [] as BytePlusAsset[] }),
        CreateAsset: () => ({ Id: 'asset-bad' }),
        GetAsset: () => ({ Id: 'asset-bad', Status: 'Failed' }),
      },
      []
    );

    await expect(
      ingestAigcAsset(config, {
        identity: 'still-b',
        publicUrl: 'https://cdn.example.com/b.png',
        assetType: 'Image',
        groupId: 'group-1',
        sleep: async () => undefined,
      })
    ).rejects.toThrow(/failed processing/);
  });
});
