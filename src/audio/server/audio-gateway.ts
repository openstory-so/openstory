/** Audio on the openstory gateway: held, run, stored and charged in the caller's step (#2436). */

import type { GatewayJobInput } from '@/gateway/schema';
import { runGatewayToEnd } from '@/gateway/server/adapter';
import { gatewayTransport } from '@/gateway/server/adapter/http';
import type { GatewayCallRoute, GatewayRoutes } from '@/gateway/server/route';
import { storeGatewayOutput } from '@/gateway/server/storage';
import { UPLOAD_RIGHTS_CHECKED } from '@/gateway/server/submit-job';
import { generateId } from '@/platform/id';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';

/** A call routed to the gateway: the run's own step, model and key. */
export type AudioGatewayCall = {
  readonly scopedDb: WorkflowScopedDb;
  /** The run's route for this call: the model as it read at the trigger, or the hosted gateway. */
  readonly route: GatewayCallRoute;
  readonly runId: string;
  /** The run's reservation: each job charges it instead of holding again (#2435). */
  readonly reservationId: string | undefined;
  /** Replay-stable per call: a retried step reuses the job and its hold. */
  readonly idempotencyKey: string;
};

/** A run's audio calls: its routes and what a gateway call needs; the route is per call. */
export type AudioRun = Omit<AudioGatewayCall, 'route'> & {
  readonly routes: GatewayRoutes | undefined;
};

/**
 * The body is the provider's own. Rights: ElevenLabs bodies are text; Seed
 * references are the organization's Seed voice clips (made from text) or the
 * user's own in-app mic take.
 */
export function runAudioOnGateway(
  call: AudioGatewayCall,
  body: GatewayJobInput
) {
  const { scopedDb, runId } = call;
  const folder = `audio-gateway/${generateId()}`;
  const { transport } = gatewayTransport(call.route, {
    scopedDb,
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
    reservation: call.reservationId ? { id: call.reservationId } : null,
    wireBody: async (body) => body,
  });
  return runGatewayToEnd(
    transport,
    { idempotencyKey: call.idempotencyKey },
    body
  );
}
