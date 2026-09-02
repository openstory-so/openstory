/**
 * The `GET /api/v1` root document — the API's self-description, modelled on the
 * `instructions` an MCP server returns at initialize time. An agent that reads
 * this once should know what the API is for, how to authenticate, the
 * create→poll workflow, the cross-cutting conventions (`?wait=` long-poll, HAL
 * affordances, the forward-looking `stepUp`/`idempotencyRequired` hints), and
 * have a copy-pasteable example body — without reading external docs.
 *
 * The root is intentionally unauthenticated: discovery should work *before* a
 * caller has wired up a key, so the narrative can tell them how to get one.
 */

import { apiEnhanceScriptSchema } from './enhance-input-schema';
import {
  API_V1_BASE,
  getLink,
  type HalLink,
  type HalResource,
  STYLES_PATH,
} from './hal';
import { apiCreateSequenceSchema } from './input-schema';
import { EXAMPLE_CREATE_STYLE_BODY } from './style-input-schema';
import { z } from 'zod';

const INSTRUCTIONS = `OpenStory public API v1 — create AI video sequences from a script in one call.

Workflow:
  1. POST /api/v1/sequences with a script (and optional style, cast, locations,
     elements, model choices). Generation is asynchronous: you get back 202 with
     the created sequence id(s), workflow run id(s), and a statusUrl to poll.
  2. GET the statusUrl to watch progress: overall status, the style and models
     used, per-shot image/video status + URLs, music, poster, and ready counts.
     Status is derived from the database, so it is always correct even if you
     reconnect later.

List your sequences:
  GET /api/v1/sequences returns your team's sequences, most recent first. Each
  entry is a compact summary (status, aspect ratio, style, models, poster,
  music, and ready/failed counts) with a 'self' link to its full status
  document. Page with ?limit (default 20, max 100) and the opaque ?cursor from
  the response's 'next' link.

Enhance only (no sequence):
  POST /api/v1/scripts/enhance to expand/polish a script without generating a
  video. Takes the enhancement-relevant inputs (style, aspectRatio, targetSeconds,
  videoModel, elements) and STREAMS the result back as Server-Sent Events: unnamed 'data:'
  shots each carry { "delta": "..." }; a final 'event: done' shot carries the
  full { "enhancedScript": "..." } plus duration fit (snapped total vs target)
  and a '_links' catalog whose
  'create-sequence' affordance embeds a ready-to-POST example body using the
  enhanced script (with enhance: "off"). Errors after streaming starts arrive
  as an 'event: error' shot.

Styles (create your own look):
  POST /api/v1/styles creates a team-owned library style you can then pass as
  'style' to POST /api/v1/sequences. Send a 'name' and a complete v2 'config'
  (look: mood, artStyle, lighting, colorPalette, colorGrading; motion: camera,
  pace, energy) plus optional description/category/tags. Responds 201
  with the style document and a 'create-sequence' link pre-filled with its id;
  409 if the name's URL slug collides with a style you can already see.
  GET /api/v1/styles lists your library styles plus the public templates
  (full documents incl. config); GET /api/v1/styles/{id} returns one.

Authentication:
  Every endpoint except this root and the device-login pair requires an API
  key. Two ways to get one:
  - Device-code login (RFC 8628 shape, no copy-pasting secrets): POST
    /api/v1/device/code, show the user the returned user_code and
    verification_url (or open verification_url_complete), then GET the 'poll'
    link — /api/v1/device/token?device_code=…&wait=60s — until it returns 200
    { api_key, team }. While the user decides you get 428 authorization_pending
    (keep polling; ?wait blocks server-side so you needn't sleep), 429 slow_down
    if you poll faster than 'interval' without ?wait, 403 access_denied, or 410
    expired_token (codes last 10 minutes; start again). The key is a normal
    team-scoped key the user can revoke under Settings → Developer.
  - Manually: the user creates a key in the dashboard under Settings →
    Developer and gives it to you.
  Send the key as either
  'Authorization: Bearer <key>' or 'x-api-key: <key>'. Keys are team-scoped and
  rate limited to 10 requests/second.

Conventions (apply to every endpoint):
  - ?wait=<duration> long-polls: instead of busy-polling, append e.g. ?wait=60s
    (also 30, 2m, 1500ms; capped at 90s) and the server holds the request open,
    returning the moment the resource changes or reaches a terminal state. Ideal
    when you have no sleep tool of your own. On POST, ?wait also embeds the first
    progress snapshot of each new sequence in the response.
  - HAL: every response carries a '_links' map of the actions available from
    that resource. Each link states its 'method', and write links state their
    'contentType' and 'examples'. Follow links rather than hardcoding paths.
  - Links may also declare 'stepUp' (needs step-up auth) or 'idempotencyRequired'
    (needs an Idempotency-Key header) so you know a requirement before you call,
    not via a 4xx. No v1 endpoint sets these today; they are forward-looking.

Errors are always JSON: { "error": { "code", "message", "details"? } } with the
matching HTTP status — never an HTML page or redirect.

Machine-readable spec: GET /api/v1/openapi.json returns the full OpenAPI 3.1
document (generated from the same schema this API validates against).`;

/** A representative `POST /api/v1/sequences` body (schema defaults applied). */
function exampleCreateBody(): unknown {
  return apiCreateSequenceSchema.parse({
    script: 'A lighthouse keeper befriends a stranded whale.',
    title: 'Sea Tale',
    style: 'Cinematic Noir',
    targetSeconds: 30,
    motion: true,
    music: true,
    characters: ['Old Tom the keeper', { name: 'The whale', isHuman: false }],
    locations: ['Stormy lighthouse'],
  });
}

/** The `create-sequence` affordance, advertised in the root document. */
export function createSequenceLink(): HalLink {
  return {
    href: `${API_V1_BASE}/sequences`,
    method: 'POST',
    title:
      'Create a video sequence (one-shot). Responds 202; poll the statusUrl.',
    contentType: 'application/json',
    examples: [exampleCreateBody()],
  };
}

/** A representative `POST /api/v1/scripts/enhance` body. */
function exampleEnhanceBody(): unknown {
  return apiEnhanceScriptSchema.parse({
    script: 'A lighthouse keeper befriends a stranded whale.',
    style: 'Cinematic Noir',
    targetSeconds: 30,
  });
}

/** The `enhance-script` affordance, advertised in the root document. */
export function enhanceScriptLink(): HalLink {
  return {
    href: `${API_V1_BASE}/scripts/enhance`,
    method: 'POST',
    title:
      'Enhance a script without creating a sequence. Streams the result as Server-Sent Events.',
    contentType: 'application/json',
    examples: [exampleEnhanceBody()],
  };
}

/** The `create-style` affordance, advertised in the root document. */
export function createStyleLink(): HalLink {
  return {
    href: STYLES_PATH,
    method: 'POST',
    title: 'Create a team style from a complete v2 config. Responds 201.',
    contentType: 'application/json',
    examples: [EXAMPLE_CREATE_STYLE_BODY],
  };
}

export type RootDocument = HalResource<{
  name: string;
  version: string;
  instructions: string;
  /** The JSON Schema for the create request body, inline for tool callers. */
  requestSchema: unknown;
}>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Zod 4.5 emits `{ $ref: "#/$defs/Id", $defs }` when the root schema has
 * `.meta({ id })`. Tool callers expect a draft object (`type: "object"`) at
 * the root; inline that named def and keep the remaining `$defs`.
 */
function jsonSchemaForToolCallers(schema: z.ZodType): unknown {
  const generated: unknown = JSON.parse(JSON.stringify(z.toJSONSchema(schema)));
  if (!isPlainObject(generated)) return generated;
  const ref = generated.$ref;
  const defs = generated.$defs;
  if (
    typeof ref !== 'string' ||
    !ref.startsWith('#/$defs/') ||
    !isPlainObject(defs)
  ) {
    return generated;
  }
  const name = ref.slice('#/$defs/'.length);
  const root = defs[name];
  if (!isPlainObject(root)) return generated;
  const { $ref: _ref, $defs: _defs, $schema, ...rest } = generated;
  const remaining = { ...defs };
  delete remaining[name];
  return {
    ...root,
    ...rest,
    ...(Object.keys(remaining).length > 0 ? { $defs: remaining } : {}),
    ...($schema === undefined ? {} : { $schema }),
  };
}

/** Build the `GET /api/v1` self-description document. */
export function buildRootDocument(): RootDocument {
  return {
    name: 'OpenStory API',
    version: 'v1',
    instructions: INSTRUCTIONS,
    requestSchema: jsonSchemaForToolCallers(apiCreateSequenceSchema),
    _links: {
      self: {
        href: API_V1_BASE,
        method: 'GET',
        title: 'API root / instructions',
      },
      'device-authorize': {
        href: `${API_V1_BASE}/device/code`,
        method: 'POST',
        title:
          'Start a device-code login to obtain an API key (no auth required). Returns user_code + verification_url; poll the returned link.',
        contentType: 'application/json',
        examples: [{}],
      },
      'create-sequence': createSequenceLink(),
      'list-sequences': {
        href: `${API_V1_BASE}/sequences{?limit,cursor}`,
        method: 'GET',
        templated: true,
        title:
          "List your team's sequences (most recent first; cursor-paginated)",
      },
      'enhance-script': enhanceScriptLink(),
      'create-style': createStyleLink(),
      'list-styles': getLink(
        STYLES_PATH,
        "List your team's library styles and the public templates"
      ),
      style: {
        href: `${STYLES_PATH}/{id}`,
        method: 'GET',
        templated: true,
        title: 'Get one style (full document incl. config)',
      },
      'sequence-status': {
        href: `${API_V1_BASE}/sequences/{id}{?wait}`,
        method: 'GET',
        templated: true,
        title: 'Get sequence status (supports ?wait long-polling)',
      },
      'openapi-spec': {
        href: `${API_V1_BASE}/openapi.json`,
        method: 'GET',
        title: 'OpenAPI 3.1 specification (JSON)',
      },
    },
  };
}
