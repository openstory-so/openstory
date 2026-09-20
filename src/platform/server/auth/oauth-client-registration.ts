/**
 * Dynamic client registration for loopback clients (#1456).
 *
 * `@better-auth/oauth-provider` follows OIDC registration: a request with no
 * `application_type` is a `web` client, and a web client may not redirect to
 * `http://localhost`. MCP clients that run on the user's machine (Claude Code,
 * editors, CLIs) register exactly that — `http://localhost:<port>/callback` —
 * and send no `application_type`, so their registration was refused, they
 * never got a `client_id`, and the user landed on `/oauth2/authorize` with
 * "client_id is required".
 *
 * An http loopback redirect is what RFC 8252 defines a native app by, so that
 * is what the missing field is read as. A request that states its type, or
 * that redirects anywhere else, is passed through untouched.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isHttpLoopback(uri: unknown): boolean {
  if (typeof uri !== 'string') return false;
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** The registration body, with `application_type: 'native'` when it is implied. */
export function withInferredApplicationType(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  if ('application_type' in body) return body;
  const uris = 'redirect_uris' in body ? body.redirect_uris : undefined;
  if (!Array.isArray(uris) || uris.length === 0) return body;
  if (!uris.every(isHttpLoopback)) return body;
  return { ...body, application_type: 'native' };
}

/** The same request with the inferred type; unreadable JSON is left to the provider. */
export async function inferNativeRegistration(
  request: Request
): Promise<Request> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return request;
  }
  const inferred = withInferredApplicationType(body);
  if (inferred === body) return request;
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(inferred),
  });
}
