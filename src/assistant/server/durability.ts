/**
 * The assistant's stream log (#2155): every chunk of a turn is appended to a
 * Durable Streams object before it reaches the browser, so a dropped
 * connection, a reload or a second tab reads the reply from the log instead
 * of running the model again. The Durable Streams server runs inside this
 * Worker (`STREAMS` binding, `StreamObject` re-exported in src/server.ts)
 * and is called in-process: no route speaks its protocol to the outside.
 */

import { env, waitUntil } from 'cloudflare:workers';
import {
  createStreamsHandler,
  type StreamsEnv,
} from '@durable-streams/server-cloudflare';
import {
  durableStream,
  type DurableStreamOffset,
} from '@tanstack/ai-durable-stream';
import { EventType, type StreamDurability } from '@tanstack/ai';

export type StreamOwner = { teamId: string; user: { id: string } };
type StreamLog = StreamDurability<DurableStreamOffset>;

/**
 * A log is only ever read within `ACTIVE_RUN_MAX_AGE_MS` of its run, so it
 * expires well after that (sliding, from last access). Sent on every create:
 * the server refuses a create whose TTL differs from the stored one, so
 * never change this for a deployed stream set without a new prefix.
 */
const STREAM_TTL_SECONDS = 3 * 24 * 60 * 60;
/** The host is a placeholder: the in-process handler routes by path. */
const STREAMS_BASE = 'https://durable-streams.internal';

const streams = createStreamsHandler<StreamsEnv>({
  // Every caller is this Worker's own assistant code, already past the
  // session middleware; the owner prefix below does the scoping.
  auth: () => undefined,
  cors: false,
});

const streamsFetch: typeof fetch = (input, init) =>
  streams(new Request(input, init), env);

/**
 * A run id is client-chosen, so its stream is keyed under the owner too:
 * another user's run id names a stream that does not exist.
 */
const prefixFor = (owner: StreamOwner) =>
  `assistant/${owner.teamId}/${owner.user.id}`;

/**
 * The log of the run `request` names (`X-Run-Id` on a POST, `?runId` on a
 * GET), replayed from the offset the request carries.
 */
export function assistantStreamLog(
  request: Request,
  owner: StreamOwner
): StreamLog {
  return durableStream(request, {
    streamPrefix: prefixFor(owner),
    fetch: streamsFetch,
    headers: { 'Stream-TTL': String(STREAM_TTL_SECONDS) },
  });
}

/** The log of `runId` as a producer: no offset, nothing to replay. */
function producerLog(runId: string, owner: StreamOwner): StreamLog {
  return assistantStreamLog(
    new Request(STREAMS_BASE, { headers: { 'X-Run-Id': runId } }),
    owner
  );
}

/**
 * A fresh run's log, with the request kept alive until the log is closed.
 * When the browser goes away mid-reply the response is cancelled, but the
 * run keeps appending to the log so a rejoin reads the whole reply; without
 * `waitUntil` workerd would drop that work with the request.
 *
 * ponytail: `waitUntil` holds a request for a bounded time after the
 * response ends, so a turn that runs much longer than that after a
 * disconnect is cut off with its log open and its usage uncharged;
 * `closeOpenRuns` seals the log on the next turn and `findActiveRun` stops
 * reporting it after `ACTIVE_RUN_MAX_AGE_MS`. Drive the run from a Durable
 * Object if turns routinely outlive that window.
 */
export function heldStreamLog(runId: string, owner: StreamOwner): StreamLog {
  const log = producerLog(runId, owner);
  let release: () => void = () => {};
  waitUntil(
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  return {
    ...log,
    close: async () => {
      try {
        await log.close();
      } finally {
        release();
      }
    },
  };
}

/**
 * Terminalise the log of a run that never reached its own close (a killed
 * isolate): a reader tailing it sees the run end instead of waiting on an
 * open log forever.
 */
export async function sealStreamLog(
  owner: StreamOwner,
  run: { runId: string; threadId: string }
): Promise<void> {
  const log = producerLog(run.runId, owner);
  await log.append([
    {
      type: EventType.RUN_ERROR,
      threadId: run.threadId,
      runId: run.runId,
      message: 'This reply was cut off.',
      timestamp: Date.now(),
    },
  ]);
  await log.close();
}

/** Drop the logs of a deleted thread's runs; a log already gone is fine. */
export async function deleteStreamLogs(
  owner: StreamOwner,
  runIds: readonly string[]
): Promise<void> {
  for (const runId of runIds) {
    const url = `${STREAMS_BASE}/streams/${encodeURIComponent(`${prefixFor(owner)}/${runId}`)}`;
    const response = await streamsFetch(url, { method: 'DELETE' });
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new Error(
        `deleting assistant stream log failed (${response.status})`
      );
    }
  }
}
