/**
 * HAL (Hypertext Application Language) primitives for the public `/api/v1`.
 *
 * Plain REST makes an agent read prose docs to learn what it can do next and how
 * to call it. HAL flips that: every response carries `_links` — a machine-readable
 * catalog of the affordances available from *this* resource. We extend the bare
 * HAL link (which only standardises `href`/`templated`/`title`) with the fields an
 * LLM actually needs to call an endpoint without guessing:
 *
 *   - `method`       — the HTTP verb (HAL assumes GET; writes need this stated).
 *   - `contentType`  — request body media type for write affordances.
 *   - `examples`     — concrete example request bodies / values, inline.
 *   - `stepUp` /
 *     `idempotencyRequired` — declared *requirements*, so an agent learns a call
 *     needs step-up auth or an `Idempotency-Key` header up front, instead of
 *     discovering it via a 4xx. (Not enforced today — forward-compatible hints.)
 *
 * `href` values are server-relative (`/api/v1/...`); callers resolve them against
 * the origin they reached us on. Templated hrefs use RFC 6570 (`{id}`, `{?wait}`).
 */

export const API_V1_BASE = '/api/v1';
export const STYLES_PATH = `${API_V1_BASE}/styles`;

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** An extended HAL link object — one callable affordance. */
export type HalLink = {
  /** Server-relative URL, possibly an RFC 6570 template (see `templated`). */
  href: string;
  /** HTTP verb. Omitted means GET, per HAL convention. */
  method?: HttpMethod;
  /** Human/agent-readable label for the affordance. */
  title?: string;
  /** True when `href` is an RFC 6570 URI template (e.g. contains `{id}`). */
  templated?: boolean;
  /** Request body media type for write affordances (e.g. `application/json`). */
  contentType?: string;
  /** Example request bodies (writes) or example values, shown inline. */
  examples?: unknown[];
  /**
   * Declares this affordance needs step-up authentication beyond the API key.
   * Advertised so an agent can prepare rather than discover it via a 403. Not
   * enforced by any current endpoint.
   */
  stepUp?: boolean;
  /**
   * Declares this affordance needs an `Idempotency-Key` request header.
   * Advertised up front rather than surfaced via a 4xx. Not enforced by any
   * current endpoint.
   */
  idempotencyRequired?: boolean;
};

export type HalLinks = Record<string, HalLink>;

/** A resource document with its affordance catalog attached. */
export type HalResource<T extends object> = T & { _links: HalLinks };

/** Attach (or merge) a `_links` catalog onto a resource body. */
export function withLinks<T extends object>(
  body: T,
  links: HalLinks
): HalResource<T> {
  return { ...body, _links: links };
}

/** A plain GET link to `href` (the common read affordance). */
export function getLink(href: string, title?: string): HalLink {
  return { href, method: 'GET', ...(title ? { title } : {}) };
}

/**
 * The `{?wait}` long-poll variant of a GET link. Every pollable resource
 * advertises this so an agent knows it can block for results instead of
 * busy-looping (see `wait.ts`).
 */
export function waitLink(href: string, title?: string): HalLink {
  return {
    href: `${href}{?wait}`,
    method: 'GET',
    templated: true,
    title: title ?? 'Long-poll this resource (e.g. ?wait=60s) until it changes',
  };
}
