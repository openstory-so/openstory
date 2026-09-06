/**
 * OpenAPI 3.1 document for the public `/api/v1`, served at
 * `GET /api/v1/openapi.json`.
 *
 * EVERY schema here is generated from the Zod schema the runtime actually
 * uses (via `z.toJSONSchema`) — request bodies from the validators, response
 * documents from the schemas the response types are inferred from in
 * `state.ts` / `create.ts` / `list.ts` / `styles.ts` / `hal.ts`. Nothing is
 * hand-authored, so the published contract cannot drift from the wire shape.
 * A component is named by `.meta({ id })` on its schema; `componentSchemas`
 * hoists those into `components.schemas`.
 */

import { oneShotResultSchema, oneShotWaitResultSchema } from './create';
import { apiEnhanceScriptSchema } from './enhance-input-schema';
import { API_V1_BASE, halLinksSchema } from './hal';
import { apiCreateSequenceSchema } from './input-schema';
import { sequenceListPageSchema } from './list';
import {
  sequenceExportAcceptedSchema,
  sequenceExportsResultSchema,
  sequenceStateResourceSchema,
} from './state';
import {
  apiCreateStyleSchema,
  EXAMPLE_CREATE_STYLE_BODY,
} from './style-input-schema';
import { errorEnvelopeSchema, rootDocumentSchema } from './discovery';
import { styleListResultSchema } from './styles';
import { z, type ZodType } from 'zod';

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

/** Recursively repoint Zod's `#/$defs/X` refs at OpenAPI `#/components/schemas/X`. */
function rewriteRefs(node: JsonValue): JsonValue {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === 'object') return rewriteRefsInObject(node);
  return node;
}

/** `rewriteRefs` specialised to a JSON object, preserving the JsonObject type. */
function rewriteRefsInObject(obj: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] =
      key === '$ref' && typeof value === 'string'
        ? value.replace('#/$defs/', '#/components/schemas/')
        : rewriteRefs(value);
  }
  return out;
}

/**
 * Turn a Zod schema into its OpenAPI root component plus its lifted `$defs`
 * (CharacterRef, SequenceStateShot, HalLink, …), all refs repointed at
 * `#/components/schemas`. Zod emits a self-contained draft-2020-12 schema
 * whose internal `#/$defs` refs don't resolve once embedded in an OpenAPI
 * document, so we hoist them to siblings under `components.schemas`.
 */
function componentSchemas(schema: ZodType): {
  root: JsonObject;
  defs: JsonObject;
} {
  // Round-trip through JSON to get a plain, mutable JSON tree (no Zod classes).
  const generated: JsonObject = JSON.parse(
    JSON.stringify(z.toJSONSchema(schema))
  );
  const { $defs, $schema: _schema, ...root } = generated;
  const defs =
    $defs && typeof $defs === 'object' && !Array.isArray($defs) ? $defs : {};
  return {
    root: rewriteRefsInObject(root),
    defs: rewriteRefsInObject(defs),
  };
}

/**
 * The `$defs` a named schema lifts — for response documents, whose root is
 * itself a `$ref` into its own defs, everything we want is in `defs`.
 */
function componentDefs(schema: ZodType): JsonObject {
  return componentSchemas(schema).defs;
}

/** A representative create body, embedded as the request example. */
const EXAMPLE_CREATE_BODY: JsonObject = {
  script: 'A lighthouse keeper befriends a stranded whale.',
  title: 'Sea Tale',
  style: 'Cinematic Noir',
  targetSeconds: 30,
  motion: true,
  music: true,
  characters: ['Old Tom the keeper', { name: 'The whale', isHuman: false }],
  locations: ['Stormy lighthouse'],
};

/** A representative enhance body, embedded as the request example. */
const EXAMPLE_ENHANCE_BODY: JsonObject = {
  script: 'A lighthouse keeper befriends a stranded whale.',
  style: 'Cinematic Noir',
  targetSeconds: 30,
};

/** Shared error-envelope reference for 4xx/5xx responses. */
function errorResponse(description: string): JsonObject {
  return {
    description,
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/Error' } },
    },
  };
}

/** Build the full OpenAPI 3.1 document for `/api/v1`. */
export function buildOpenApiDocument(): JsonObject {
  const { root: createRequest, defs } = componentSchemas(
    apiCreateSequenceSchema
  );
  const { root: enhanceRequest, defs: enhanceDefs } = componentSchemas(
    apiEnhanceScriptSchema
  );
  const { root: createStyleRequest, defs: styleDefs } =
    componentSchemas(apiCreateStyleSchema);

  const waitParam: JsonObject = {
    name: 'wait',
    in: 'query',
    required: false,
    description:
      'Long-poll duration: hold the request open until the resource changes or reaches a terminal state. Forms: "60s", "30" (seconds), "2m", "1500ms". Capped at 90s; absent/0/malformed returns immediately.',
    schema: { type: 'string' },
    example: '60s',
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'OpenStory API',
      version: 'v1',
      description:
        'Create AI video sequences from a script in one call. Generation is asynchronous: POST returns 202 with sequence id(s) and a status URL to poll (optionally with ?wait long-polling). Every response carries a HAL `_links` catalog of next actions.',
    },
    servers: [
      {
        url: '/',
        description: 'Relative to the origin serving this document.',
      },
    ],
    security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
    tags: [
      { name: 'discovery', description: 'Unauthenticated self-description.' },
      { name: 'auth', description: 'Obtain an API key via device-code login.' },
      { name: 'sequences', description: 'Create and watch video sequences.' },
      { name: 'scripts', description: 'Enhance scripts without generating.' },
      { name: 'styles', description: 'Create and browse team styles.' },
    ],
    paths: {
      [API_V1_BASE]: {
        get: {
          tags: ['discovery'],
          summary: 'API root / instructions',
          description:
            'MCP-style self-description: an instructions narrative, the create request JSON Schema, and a HAL link catalog. Unauthenticated so discovery works before a key is wired up.',
          security: [],
          responses: {
            '200': {
              description: 'The API root document.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RootDocument' },
                },
              },
            },
          },
        },
      },
      [`${API_V1_BASE}/openapi.json`]: {
        get: {
          tags: ['discovery'],
          summary: 'This OpenAPI 3.1 document',
          security: [],
          responses: {
            '200': {
              description: 'The OpenAPI document.',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      [`${API_V1_BASE}/device/code`]: {
        post: {
          tags: ['auth'],
          summary: 'Start a device-code login',
          description:
            'RFC 8628-style login for agents: returns a secret `device_code` to poll with and a short `user_code` the user enters at `verification_url` (or open `verification_url_complete`). Codes last 10 minutes. Unauthenticated and rate limited per IP.',
          security: [],
          responses: {
            '201': {
              description: 'A new device code.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: [
                      'device_code',
                      'user_code',
                      'verification_url',
                      'verification_url_complete',
                      'expires_in',
                      'interval',
                    ],
                    properties: {
                      device_code: { type: 'string' },
                      user_code: { type: 'string' },
                      verification_url: { type: 'string', format: 'uri' },
                      verification_url_complete: {
                        type: 'string',
                        format: 'uri',
                      },
                      expires_in: { type: 'integer', description: 'Seconds.' },
                      interval: {
                        type: 'integer',
                        description: 'Minimum seconds between bare polls.',
                      },
                      _links: { type: 'object' },
                    },
                  },
                },
              },
            },
            '429': errorResponse(
              'Too many device-login requests from this IP.'
            ),
          },
        },
      },
      [`${API_V1_BASE}/device/token`]: {
        get: {
          tags: ['auth'],
          summary: 'Collect the API key for an approved device code',
          description:
            'Poll with the `device_code`. `?wait` holds the request open server-side (e.g. `60s`) so you need not sleep between polls; without it, respect `interval`. Returns the key exactly once — the code is consumed.',
          security: [],
          parameters: [
            {
              name: 'device_code',
              in: 'query',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'wait',
              in: 'query',
              required: false,
              description: 'Long-poll duration, e.g. `30s` or `60s`.',
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Approved. The key is shown only once.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['api_key', 'team'],
                    properties: {
                      api_key: { type: 'string' },
                      team: {
                        type: 'object',
                        required: ['id', 'name'],
                        properties: {
                          id: { type: 'string' },
                          name: { type: 'string' },
                        },
                      },
                      _links: { type: 'object' },
                    },
                  },
                },
              },
            },
            '400': errorResponse('Missing device_code or bad ?wait.'),
            '403': errorResponse('access_denied — the user denied the login.'),
            '410': errorResponse(
              'expired_token — unknown, expired, or already-used code.'
            ),
            '428': errorResponse('authorization_pending — keep polling.'),
            '429': errorResponse(
              'slow_down (polled faster than `interval` without ?wait) or per-IP limit; honour Retry-After.'
            ),
          },
        },
      },
      [`${API_V1_BASE}/sequences`]: {
        get: {
          tags: ['sequences'],
          summary: "List this team's sequences",
          description:
            "List the API key team's sequences, most recent first (by updatedAt). Each entry is a compact summary — status-document scalars plus a `counts` block, without the per-shot array — and carries a HAL `self` link to its full status document. Archived sequences are excluded. Page with ?limit (default 20, max 100) and the opaque ?cursor returned in the response's `next` link.",
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              description: 'Max sequences to return (1–100). Default 20.',
              schema: { type: 'integer', minimum: 1, maximum: 100 },
              example: 20,
            },
            {
              name: 'cursor',
              in: 'query',
              required: false,
              description:
                "Opaque pagination cursor. Echo back the value from the response's `next` link to fetch the following page.",
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description:
                'A page of sequence summaries with a HAL `_links` catalog (`self`, `create-sequence`, and `next` when more remain).',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SequenceListResult' },
                },
              },
            },
            '400': errorResponse('Invalid limit or cursor.'),
            '401': errorResponse('Missing or invalid API key.'),
            '403': errorResponse('No team associated with the key.'),
            '429': errorResponse('Per-key rate limit exceeded (10 req/s).'),
          },
        },
        post: {
          tags: ['sequences'],
          summary: 'Create a video sequence (one-shot)',
          description:
            'Validate input, optionally enhance the script, resolve style/cast/locations/elements, then trigger async generation. Responds 202 with the created sequence id(s), workflow run id(s), a status URL, and a HAL `_links` catalog. With ?wait, blocks until each new sequence shows first progress (or a terminal state) and embeds that snapshot.',
          parameters: [waitParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateSequenceRequest' },
                example: EXAMPLE_CREATE_BODY,
              },
            },
          },
          responses: {
            '202': {
              description:
                'Sequence(s) created; generation is async. Without ?wait the entries are summaries; with ?wait each entry embeds a `state` snapshot plus `waitChanged`/`waitDone`.',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { $ref: '#/components/schemas/CreateSequenceResult' },
                      { $ref: '#/components/schemas/CreateSequenceWaitResult' },
                    ],
                  },
                },
              },
            },
            '400': errorResponse('Invalid JSON or request body.'),
            '401': errorResponse('Missing or invalid API key.'),
            '403': errorResponse('No team associated with the key.'),
            '429': errorResponse('Per-key rate limit exceeded (10 req/s).'),
          },
        },
      },
      [`${API_V1_BASE}/scripts/enhance`]: {
        post: {
          tags: ['scripts'],
          summary: 'Enhance a script (streaming)',
          description:
            'Enhance/expand a script WITHOUT creating a sequence, using the enhancement-relevant inputs (style, aspect ratio, target duration, video model clip grid, elements). Streams the result as Server-Sent Events: unnamed `data:` shots each carry `{ "delta": "..." }`; a mid-stream `event: replace` shot may replace the accumulated script (duration correction); a terminal `event: done` shot carries the full `{ "enhancedScript": "...", "duration": {...}, "_links": {...} }` — `duration` reports labeled vs snapped totals and a `message` when the brief cannot fit the target on the selected model\'s clip grid. The `create-sequence` affordance embeds a ready-to-POST example body using the enhanced script. A failure after streaming starts arrives as an `event: error` shot `{ code, message }`. Pre-stream failures (invalid body, unresolvable style, billing) return the JSON error envelope instead.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EnhanceScriptRequest' },
                example: EXAMPLE_ENHANCE_BODY,
              },
            },
          },
          responses: {
            '200': {
              description:
                'An SSE stream of the enhanced script. Delta shots, then a terminal `done` shot with the full text and a HAL `_links` catalog of next actions.',
              content: {
                'text/event-stream': {
                  schema: { type: 'string' },
                  example:
                    'data: {"delta":"INT. "}\n\ndata: {"delta":"LIGHTHOUSE"}\n\nevent: done\ndata: {"enhancedScript":"INT. LIGHTHOUSE - NIGHT\\n...","_links":{"create-sequence":{"href":"/api/v1/sequences","method":"POST"}}}\n\n',
                },
              },
            },
            '400': errorResponse('Invalid JSON or request body.'),
            '401': errorResponse('Missing or invalid API key.'),
            '403': errorResponse('No team associated with the key.'),
            '404': errorResponse('No style found matching the reference.'),
            '429': errorResponse('Per-key rate limit exceeded (10 req/s).'),
          },
        },
      },
      [`${API_V1_BASE}/styles`]: {
        get: {
          tags: ['styles'],
          summary: 'List styles',
          description:
            "Your team's library styles plus the public templates, as full documents. Sequence-bound automatic styles are excluded.",
          responses: {
            '200': {
              description: 'The style documents.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/StyleListResult' },
                },
              },
            },
            '401': errorResponse('Missing or invalid API key.'),
            '403': errorResponse('No team associated with the key.'),
            '429': errorResponse('Per-key rate limit exceeded (10 req/s).'),
          },
        },
        post: {
          tags: ['styles'],
          summary: 'Create a style',
          description:
            'Create a team-owned library style to pass as `style` when creating sequences. Send `name` and a complete v2 `config` (validated as-is; v1 is rejected). Public/template flags, usage counts and sequence binding are server-managed and cannot be set.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateStyleRequest' },
                example: EXAMPLE_CREATE_STYLE_BODY,
              },
            },
          },
          responses: {
            '201': {
              description:
                'The created style document, with a `create-sequence` link pre-filled with its id.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/StyleDocument' },
                },
              },
            },
            '400': errorResponse('Invalid JSON or request body.'),
            '401': errorResponse('Missing or invalid API key.'),
            '403': errorResponse('No team associated with the key.'),
            '409': errorResponse(
              "The name's URL slug collides with a style visible to this team."
            ),
            '429': errorResponse('Per-key rate limit exceeded (10 req/s).'),
          },
        },
      },
      [`${API_V1_BASE}/styles/{id}`]: {
        get: {
          tags: ['styles'],
          summary: 'Get a style',
          description:
            'The full style document (incl. the v2 `config` recipe). Resolves your own library styles and public templates.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'The style id (ULID).',
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'The style document.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/StyleDocument' },
                },
              },
            },
            '401': errorResponse('Missing or invalid API key.'),
            '403': errorResponse('No team associated with the key.'),
            '404': errorResponse('Style not found.'),
            '429': errorResponse('Per-key rate limit exceeded (10 req/s).'),
          },
        },
      },
      [`${API_V1_BASE}/sequences/{id}`]: {
        get: {
          tags: ['sequences'],
          summary: 'Get sequence status',
          description:
            'DB-derived status document: overall status, per-shot image/video status + URLs, music, poster, and ready/failed counts, plus a HAL `_links` catalog. With ?wait, long-polls until the sequence changes or reaches a terminal state.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'The sequence id (ULID).',
              schema: { type: 'string' },
            },
            waitParam,
          ],
          responses: {
            '200': {
              description: 'The sequence status document.',
              headers: {
                'X-Wait-Changed': {
                  description:
                    'Only present when ?wait was set. "true" if the sequence advanced during the wait, "false" if the wait timed out unchanged.',
                  schema: { type: 'string', enum: ['true', 'false'] },
                },
              },
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SequenceState' },
                },
              },
            },
            '401': errorResponse('Missing or invalid API key.'),
            '403': errorResponse('No team associated with the key.'),
            '404': errorResponse('No such sequence for this key.'),
            '429': errorResponse('Per-key rate limit exceeded (10 req/s).'),
          },
        },
      },
      [`${API_V1_BASE}/sequences/{id}/exports`]: {
        get: {
          tags: ['sequences'],
          summary: 'List server-side exports',
          description:
            "Lists this sequence's server-side MP4 exports in any status (processing/ready/failed), newest first. Poll until an entry is `ready`, then download its `url`. Pass `?wait=60s` to long-poll until no export is `processing`.",
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'The sequence id (ULID).',
              schema: { type: 'string' },
            },
            waitParam,
          ],
          responses: {
            '200': {
              description: 'The list of exports.',
              headers: {
                'X-Wait-Changed': {
                  description:
                    'Only present when ?wait was set. "true" if an export changed status during the wait, "false" if the wait timed out unchanged.',
                  schema: { type: 'string', enum: ['true', 'false'] },
                },
              },
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/SequenceExportsResult',
                  },
                },
              },
            },
            '401': errorResponse('Missing or invalid API key.'),
            '404': errorResponse('No such sequence for this key.'),
          },
        },
        post: {
          tags: ['sequences'],
          summary: 'Start a server-side MP4 export',
          description:
            "Stitches the sequence's scene videos and mixes music + dialogue into one MP4, rendered in a Cloudflare Container (mediabunny) and stored in R2. A ready export of the current cut (`sourceShotsHash`) is returned 200 and not re-rendered. Otherwise async: responds 202 with a `processing` export — poll the GET endpoint until it is `ready`. An already in-flight export is reused rather than duplicated. Takes no body.",
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'The sequence id (ULID).',
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  description: 'No parameters; send `{}` or an empty body.',
                },
              },
            },
          },
          responses: {
            '200': {
              description:
                'A ready export of the current cut already exists; returned as-is.',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/SequenceExportAccepted',
                  },
                },
              },
            },
            '202': {
              description: 'Export accepted (newly started or coalesced).',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/SequenceExportAccepted',
                  },
                },
              },
            },
            '401': errorResponse('Missing or invalid API key.'),
            '404': errorResponse('No such sequence for this key.'),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Send the API key as "Authorization: Bearer <key>".',
        },
        apiKeyHeader: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description: 'Send the API key as "x-api-key: <key>".',
        },
      },
      schemas: {
        CreateSequenceRequest: createRequest,
        ...defs,
        EnhanceScriptRequest: enhanceRequest,
        ...enhanceDefs,
        CreateStyleRequest: createStyleRequest,
        ...styleDefs,
        // Response documents, generated from the schemas their TypeScript
        // types are inferred from. Each contributes its own component plus any
        // nested named schema (SequenceStateShot, HalLink, StyleDocument, …).
        ...componentDefs(halLinksSchema),
        ...componentDefs(sequenceStateResourceSchema),
        ...componentDefs(sequenceListPageSchema),
        ...componentDefs(oneShotResultSchema),
        ...componentDefs(oneShotWaitResultSchema),
        ...componentDefs(sequenceExportsResultSchema),
        ...componentDefs(sequenceExportAcceptedSchema),
        ...componentDefs(styleListResultSchema),
        ...componentDefs(rootDocumentSchema),
        ...componentDefs(errorEnvelopeSchema),
      },
    },
  };
}
