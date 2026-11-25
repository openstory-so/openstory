/** ElevenLabs on the openstory gateway: held, run, stored and charged in the caller's step (#2436). */

import type { GatewayJobInput } from '@/gateway/schema';
import { runGatewayToEnd } from '@/gateway/server/adapter';
import { inProcessGateway } from '@/gateway/server/adapter/in-process';
import type { GatewayModel } from '@/gateway/server/catalog';
import { storeGatewayOutput } from '@/gateway/server/storage';
import { UPLOAD_RIGHTS_CHECKED } from '@/gateway/server/submit-job';
import { generateId } from '@/platform/id';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';

/** A call the trigger routed to the gateway; null on the direct path. */
export type ElevenLabsGatewayCall = {
  readonly scopedDb: WorkflowScopedDb;
  /** The model as it read at the trigger. */
  readonly model: GatewayModel;
  readonly runId: string;
  /** Replay-stable per call: a retried step reuses the job and its hold. */
  readonly idempotencyKey: string;
};

/** The body is ElevenLabs' own; these bodies carry text only, so there is no upload to check. */
export function runElevenLabsOnGateway(
  call: ElevenLabsGatewayCall,
  body: GatewayJobInput
) {
  const { scopedDb, model, runId } = call;
  const folder = `elevenlabs/${generateId()}`;
  const gateway = inProcessGateway({
    scopedDb,
    model,
    runId,
    store: (media, index) =>
      storeGatewayOutput({
        media,
        kind: 'audio',
        organizationId: scopedDb.organizationId,
        folder,
        index,
      }),
    uploadRightsChecked: UPLOAD_RIGHTS_CHECKED,
  });
  return runGatewayToEnd(
    gateway,
    { idempotencyKey: call.idempotencyKey },
    body
  );
}
