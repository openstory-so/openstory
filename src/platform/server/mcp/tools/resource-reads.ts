/** The resource templates (#1462) and the tool projections they serve. */

import type { ScopedDb } from '@/platform/server/db/scoped';
import { readProductionBible } from '@/sequences/server/production-bible';
import { readSequenceSummary } from './get-sequence';
import { readSceneDetail } from './get-scene';

type Read = (
  scopedDb: ScopedDb,
  ids: Record<string, string>,
  origin: string
) => Promise<unknown>;

export const MCP_RESOURCE_TEMPLATES = [
  {
    name: 'sequence-summary',
    title: 'Sequence summary',
    uriTemplate: 'openstory://sequences/{sequenceId}/summary',
    params: ['sequenceId'],
    listed: true,
    read: ((db, ids, origin) =>
      readSequenceSummary(db, ids.sequenceId ?? '', origin)) satisfies Read,
  },
  {
    name: 'sequence-bible',
    title: 'Production bible',
    uriTemplate: 'openstory://sequences/{sequenceId}/bible',
    params: ['sequenceId'],
    listed: true,
    read: ((db, ids, origin) =>
      readProductionBible(db, ids.sequenceId ?? '', origin)) satisfies Read,
  },
  {
    name: 'scene',
    title: 'Scene',
    uriTemplate: 'openstory://sequences/{sequenceId}/scenes/{sceneId}',
    params: ['sequenceId', 'sceneId'],
    listed: false,
    read: ((db, ids, origin) =>
      readSceneDetail(
        db,
        ids.sequenceId ?? '',
        ids.sceneId ?? '',
        origin
      )) satisfies Read,
  },
] as const;
