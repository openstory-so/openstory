/**
 * Browser client for the server-side sequence export (#1402).
 *
 * POSTs `/api/v1/sequences/$id/exports` with the session cookie (CSRF is
 * server-fn-only, so this route accepts it) and polls GET until the row is
 * `ready` or `failed`. A ready hash-match on POST returns immediately —
 * the theatre then downloads that URL the same way as a browser-encoded MP4.
 */

const POLL_WAIT = '60s';
const POLL_GAP_MS = 2_000;
/** Matches the route's stale-processing window (render 15m × 2 retries + pad). */
const MAX_WAIT_MS = 35 * 60 * 1000;

type ServerExport = {
  id: string;
  status: 'processing' | 'ready' | 'failed';
  url: string | null;
  error: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readExport(value: unknown): ServerExport | null {
  if (!isRecord(value)) return null;
  const { id, status, url, error } = value;
  if (typeof id !== 'string') return null;
  if (status !== 'processing' && status !== 'ready' && status !== 'failed') {
    return null;
  }
  return {
    id,
    status,
    url: typeof url === 'string' ? url : null,
    error: typeof error === 'string' ? error : null,
  };
}

function readCreatedExport(body: unknown): ServerExport | null {
  if (!isRecord(body)) return null;
  return readExport(body.export);
}

function findExport(body: unknown, id: string): ServerExport | null {
  if (!isRecord(body) || !Array.isArray(body.exports)) return null;
  for (const row of body.exports) {
    const parsed = readExport(row);
    if (parsed?.id === id) return parsed;
  }
  return null;
}

function apiErrorMessage(
  body: unknown,
  fallback: string,
  status: number
): string {
  if (
    isRecord(body) &&
    isRecord(body.error) &&
    typeof body.error.message === 'string' &&
    body.error.message.length > 0
  ) {
    return body.error.message;
  }
  return `${fallback} (${status})`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function readyUrl(row: ServerExport): string | null {
  return row.status === 'ready' && row.url ? row.url : null;
}

export async function exportSequenceOnServer(opts: {
  sequenceId: string;
  signal: AbortSignal;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleepFn?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<{ url: string }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  const sleepFn = opts.sleepFn ?? sleep;
  const started = now();
  const base = `/api/v1/sequences/${opts.sequenceId}/exports`;

  const post = await fetchFn(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    credentials: 'same-origin',
    signal: opts.signal,
  });
  const postBody: unknown = await post.json().catch(() => null);
  if (!post.ok && post.status !== 202) {
    throw new Error(
      apiErrorMessage(postBody, 'Server export failed', post.status)
    );
  }
  const created = readCreatedExport(postBody);
  if (!created) throw new Error('Server export returned no export');
  const postedUrl = readyUrl(created);
  if (postedUrl) return { url: postedUrl };
  if (created.status === 'failed') {
    throw new Error(created.error ?? 'Server export failed');
  }

  while (!opts.signal.aborted) {
    if (now() - started > MAX_WAIT_MS) {
      throw new Error('Server export timed out');
    }
    const get = await fetchFn(`${base}?wait=${POLL_WAIT}`, {
      credentials: 'same-origin',
      signal: opts.signal,
    });
    const getBody: unknown = await get.json().catch(() => null);
    if (!get.ok) {
      throw new Error(
        apiErrorMessage(getBody, 'Server export poll failed', get.status)
      );
    }
    const current = findExport(getBody, created.id);
    const currentUrl = current ? readyUrl(current) : null;
    if (currentUrl) return { url: currentUrl };
    if (current?.status === 'failed') {
      throw new Error(current.error ?? 'Server export failed');
    }
    await sleepFn(POLL_GAP_MS, opts.signal);
  }
  throw new DOMException('Aborted', 'AbortError');
}
