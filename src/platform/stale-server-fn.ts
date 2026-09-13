/**
 * A tab left open across a deploy calls `GET /_serverFn/<old id>`.
 * TanStack Start's `getServerFnById` throws *outside* the try/catch that
 * serializes server-fn errors, so h3 answers
 * `500 {"status":500,"unhandled":true,"message":"HTTPError"}` with no
 * `x-tss-serialized` header. The Start client then treats that JSON as the
 * call's payload, reads `.result`, and the fn resolves `undefined` (#1557).
 *
 * Rewrite that 500 to a marked 404. The client (`installStaleServerFnReload`)
 * reloads once, same remedy as a stale chunk (#1395).
 */

export const STALE_SERVER_FN_HEADER = 'x-os-stale-server-fn';

export function isStaleServerFnPath(pathname: string): boolean {
  return pathname.startsWith('/_serverFn/');
}

export function isUnhandledMissingServerFn(
  status: number,
  headers: Headers,
  body: string
): boolean {
  if (status !== 500) return false;
  if (headers.get('x-tss-serialized') === 'true') return false;
  const trimmed = body.trim();
  if (trimmed.includes('Server function info not found')) return true;
  try {
    const json: unknown = JSON.parse(trimmed);
    if (typeof json !== 'object' || json === null) return false;
    const record = json as { unhandled?: unknown; message?: unknown };
    if (record.unhandled !== true) return false;
    return (
      record.message === 'HTTPError' ||
      (typeof record.message === 'string' &&
        record.message.includes('Server function info not found'))
    );
  } catch {
    return false;
  }
}

export function staleServerFnResponse(): Response {
  return new Response('stale server function', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      [STALE_SERVER_FN_HEADER]: '1',
    },
  });
}

export async function rewriteStaleServerFnResponse(
  response: Response
): Promise<Response> {
  if (response.status !== 500) return response;
  if (response.headers.get('x-tss-serialized') === 'true') return response;
  const body = await response.clone().text();
  if (!isUnhandledMissingServerFn(response.status, response.headers, body)) {
    return response;
  }
  return staleServerFnResponse();
}
