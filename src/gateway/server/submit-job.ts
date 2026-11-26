/**
 * `POST /api/v1/gateway/{provider}/{model}` (docs/architecture/model-gateway.md).
 * Order: replay, model, platform key, schema, compliance, upload rights, price, row, hold,
 * trigger. A refused request leaves no row and no hold.
 */

import type { Microdollars } from '@/billing/money';
import { releaseReservationOnThrow } from '@/billing/server/preflight';
import type { LikenessRequestContext } from '@/cast/server/upload-rights';
import { requireCheckedUploadRights } from '@/cast/server/upload-check';
import {
  ConflictError,
  InsufficientCreditsError,
  OpenStoryError,
  ValidationError,
} from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import { sha256Hex } from '@/platform/compliance/hash';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { GatewayJob, JsonValue } from '@/platform/server/db/schema';
import { requireGenerationAllowed } from '@/platform/server/compliance/generation-gate';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import {
  GATEWAY_PLATFORM_FEE_BPS,
  gatewayCharge,
} from '@/gateway/charge-lines';
import {
  BYTEPLUS_ENDPOINTS,
  GATEWAY_ERROR_MESSAGES,
  GATEWAY_VIA,
  type GatewayJobInput,
  type GatewayProvider,
} from '@/gateway/schema';
import { getGatewayModel, type GatewayModel } from '@/gateway/server/catalog';
import { withPlatformLlmKey } from '@/gateway/server/platform-credentials';
import { GATEWAY_DRIVERS } from '@/gateway/server/providers';
import type { GatewayRun } from '@/gateway/server/phases';
import {
  COUNT_FIELDS,
  countFieldWhere,
  priceGatewayJob,
} from '@/gateway/server/price';
import type { GatewayGenerationWorkflowInput } from '@/gateway/server/workflows/gateway-generation-workflow';
import { cardParams, RateCardError } from '@modelschemas/rate-card/evaluator';
import { z } from 'zod';

const logger = getLogger(['openstory', 'gateway', 'submit']);

export type GatewaySubmitContext = {
  scopedDb: ScopedDb;
  request: LikenessRequestContext;
  /** The `Idempotency-Key` header, when sent. */
  idempotencyKey: string | null;
  /** `context.oauth?.clientId`; null for an `osk_` key or a session. */
  oauthClientId: string | null;
};

export type GatewaySubmitResult = { job: GatewayJob; replay: boolean };

/** An in-process caller's word that it ran `requireUploadRights` on every URL; JSON cannot carry it. */
export const UPLOAD_RIGHTS_CHECKED: unique symbol = Symbol(
  'upload rights checked'
);

/** How a body's media is checked: here against the request, or already by an in-process caller. */
export type GatewayRights =
  | { scopedDb: ScopedDb; request: LikenessRequestContext }
  | typeof UPLOAD_RIGHTS_CHECKED;

/** What the hold writes: met by `ScopedDb` at a trigger and by `WorkflowScopedDb` in a step. */
export type GatewayHoldDb = Pick<
  WorkflowScopedDb,
  'organizationId' | 'userId'
> & {
  gatewayJobs: Pick<
    WorkflowScopedDb['gatewayJobs'],
    'create' | 'deleteUnstarted'
  >;
  billing: Pick<WorkflowScopedDb['billing'], 'createReservation'>;
};

/** The `Idempotency-Key` header, trimmed; refused past 255 characters. */
export function readIdempotencyKey(headers: Headers): string | null {
  const key = headers.get('idempotency-key')?.trim();
  if (!key) return null;
  if (key.length > 255) {
    throw new ValidationError('Idempotency-Key is longer than 255 characters');
  }
  return key;
}

/** Providers that read the model from the body; the path's model is always written there. */
const MODEL_IN_BODY: ReadonlySet<GatewayProvider> = new Set([
  'grok',
  'byteplus',
]);

function isObject(
  value: JsonValue | undefined
): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The body checked against the provider's schema. Three refusals keep the
 * price honest: a `model` that differs from the path, a field the schema
 * does not name, and more than one output the card does not price.
 */
/** Keys sorted, so a replay that only reorders fields is the same request. */
function canonical(value: JsonValue): string {
  return JSON.stringify(value, (_key, inner: JsonValue) =>
    isObject(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))
        )
      : inner
  );
}

/** The row's copy of the body: inline media becomes its digest, so a clip never fills the row (D1 caps one at 2 MB). */
async function rowBody(body: GatewayJobInput): Promise<GatewayJobInput> {
  const entries = await Promise.all(
    Object.entries(body).map(
      async ([key, inner]): Promise<[string, JsonValue]> => {
        return [
          key,
          INLINE_KEYS.has(key)
            ? await digest(canonical(inner))
            : await rowValue(inner),
        ];
      }
    )
  );
  return Object.fromEntries(entries);
}

async function rowValue(value: JsonValue): Promise<JsonValue> {
  if (Array.isArray(value)) return Promise.all(value.map(rowValue));
  if (isObject(value)) return rowBody(value);
  // A `data:` URL in any field is media too; a short one stays as it is.
  return typeof value === 'string' &&
    value.length > DATA_URL_DIGEST_FROM &&
    /^data:/i.test(value)
    ? digest(value)
    : value;
}

const DATA_URL_DIGEST_FROM = 256;

async function digest(text: string): Promise<JsonValue> {
  return { sha256: await sha256Hex(text), length: text.length };
}

/** Refuses a replayed key that carries a different request; `model` is the path's, so it is left out. */
async function requireSameRequest(
  job: GatewayJob,
  via: GatewayJob['via'],
  modelId: string,
  body: GatewayJobInput
): Promise<void> {
  const { model: _stored, ...stored } = job.input;
  const { model: _sent, ...sent } = body;
  if (
    job.via !== via ||
    job.modelKey !== modelId ||
    canonical(stored) !== canonical(await rowBody(sent))
  ) {
    throw new ConflictError(
      'This idempotency key was already used for a different request'
    );
  }
}

export function validatedBody(
  model: GatewayModel,
  raw: GatewayJobInput
): GatewayJobInput {
  const modelInBody = MODEL_IN_BODY.has(model.provider);
  if (modelInBody && raw.model !== undefined && raw.model !== model.id) {
    throw new ValidationError('`model` in the body differs from the path');
  }
  const body = modelInBody ? { ...raw, model: model.id } : raw;

  const { properties, additionalProperties } = model.inputSchema;
  if (isObject(properties) && !additionalProperties) {
    const unknown = Object.keys(body).filter(
      (key) =>
        !Object.hasOwn(properties, key) && !(modelInBody && key === 'model')
    );
    if (unknown.length > 0) {
      throw new ValidationError(
        `The model schema has no field named ${unknown.join(', ')}`
      );
    }
  }
  const parsed = z.fromJSONSchema(model.inputSchema).safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('The body does not match the model schema', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const malformed = countFieldWhere(
    body,
    (count) => !Number.isInteger(count) || Number(count) < 1
  );
  if (malformed) {
    throw new ValidationError(
      `\`${malformed}\` must be a whole number of at least 1`
    );
  }
  const priced = new Set(cardParams(model.card).request);
  const unpriced =
    COUNT_FIELDS.find((field) => {
      const count = body[field];
      return typeof count === 'number' && count > 1 && !priced.has(field);
    }) ??
    Object.values(body)
      .map((inner) => countFieldWhere(inner, (count) => Number(count) > 1))
      .find(Boolean);
  if (unpriced) {
    throw new ValidationError(
      `The rate card does not price \`${unpriced}\` above 1 for this model`
    );
  }
  return body;
}

/** The likeness check cannot hear whose voice a clip is; only the product's own voice flow, with its own rights step, clones. */
function refuseVoiceClone(model: GatewayModel, body: GatewayJobInput): void {
  if (
    model.provider === 'byteplus' &&
    model.endpointId === BYTEPLUS_ENDPOINTS.speech &&
    Array.isArray(body.references) &&
    body.references.some(
      (entry) =>
        isObject(entry) && ('audio_url' in entry || 'audio_data' in entry)
    )
  ) {
    throw new ValidationError(
      'Cloning a voice from a clip is not served; use a `speaker`'
    );
  }
}

const INLINE = 'Send media as a URL, not inline data';
// WHATWG special schemes: `https:host` and `https:/host` still parse as URLs.
const FETCHED_SCHEMES = new Set(['http', 'https', 'ftp']);
// Bare base64 with no `data:` prefix: Gemini's parts and Seed Audio's references.
const INLINE_KEYS = new Set([
  'inlineData',
  'inline_data',
  'audio_data',
  'image_data',
]);

/** Percent-encodes what the URL parser may encode, so a written URL and its href compare. */
function encodeLikeParser(url: string): string {
  return url.replace(/[^\x21-\x7e]|["'<>`{}|^]/gu, (char) =>
    [...new TextEncoder().encode(char)]
      .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
      .join('')
  );
}

/**
 * The href of a plain http(s) URL, or null. It must read back as written,
 * up to scheme and host case, the root slash and percent-encoding.
 */
function plainHttpHref(body: string): string | null {
  if (body.includes('\\')) return null;
  let url: URL;
  try {
    url = new URL(body);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const written = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/is.exec(body);
  if (!written) return null;
  const [, scheme = '', authority = '', rest = ''] = written;
  const at = authority.lastIndexOf('@') + 1;
  const normalised = `${scheme.toLowerCase()}://${authority.slice(0, at)}${authority.slice(at).toLowerCase()}${rest.startsWith('/') ? '' : '/'}${rest}`;
  return encodeLikeParser(normalised) === encodeLikeParser(url.href)
    ? url.href
    : null;
}

/**
 * Every URL in the body, for the likeness check. Anything else that could
 * carry media is refused: the check is keyed on a URL, and bytes it cannot
 * see must not reach a model.
 */
export function gatedUrls(body: JsonValue, found: string[] = []): string[] {
  if (typeof body === 'string') {
    // As a URL parser reads it: C0 controls and spaces at either end are dropped.
    // oxlint-disable-next-line no-control-regex
    const trimmed = body.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
    // `data:<type>,<bytes>` and `blob:<url>`; a prompt that starts "Data: ..." is neither.
    if (/^data:[^\s,]*,/i.test(trimmed) || /^blob:\S/i.test(trimmed)) {
      throw new ValidationError(INLINE);
    }
    // The parser also drops every tab, LF and CR inside the string.
    const parsed = trimmed.replace(/[\t\n\r]/g, '');
    const [, fetched = '', next = ''] =
      /^([a-z][a-z0-9+.-]*):(.?)/i.exec(parsed) ?? [];
    const urlLike =
      /^[\\/]{2}/.test(parsed) ||
      // `http: the old protocol` is prose: no host follows the scheme.
      (FETCHED_SCHEMES.has(fetched.toLowerCase()) &&
        next !== '' &&
        !/\s/.test(next)) ||
      // Any other scheme with an authority, as written: `Label:\n//note` is prose.
      /^[a-z][a-z0-9+.-]*:[\\/]{2}/i.test(trimmed);
    if (urlLike) {
      // Only http(s), as the parser writes it: a provider may fetch what we did not check.
      const href = plainHttpHref(body);
      if (href === null) {
        throw new ValidationError('Media URLs must be plain http(s) URLs');
      }
      found.push(href);
    } else if (trimmed.startsWith('/r2/')) {
      // Our own stored uploads are origin-relative; they are checked too.
      found.push(trimmed);
    }
  } else if (Array.isArray(body)) {
    for (const item of body) gatedUrls(item, found);
  } else if (body !== null && typeof body === 'object') {
    for (const [key, value] of Object.entries(body)) {
      if (INLINE_KEYS.has(key)) {
        throw new ValidationError(INLINE);
      }
      gatedUrls(value, found);
    }
  }
  return found;
}

/** The hold on a card estimate: every line of the charge it would settle to. Pre-flight quotes read this too. */
export function gatewayHoldMicros(estimate: Microdollars): Microdollars {
  return gatewayCharge({
    providerCostMicros: estimate,
    platformFeeBps: GATEWAY_PLATFORM_FEE_BPS,
  }).totalMicros;
}

/**
 * Validate and hold: the platform key, the body, the account, the media,
 * the price, the row and the reservation. A refused request leaves no row and
 * no hold. A replayed idempotency key returns its job and the same hold.
 */
export async function holdGatewayJob(
  model: GatewayModel,
  body: GatewayJobInput,
  ctx: {
    scopedDb: GatewayHoldDb;
    rights: GatewayRights;
    idempotencyKey: string | null;
    oauthClientId: string | null;
    /** The trusted caller's own run reservation to charge against, or null to hold here. */
    runReservationId: string | null;
  }
): Promise<{ job: GatewayJob; created: boolean; run: GatewayRun }> {
  const { scopedDb, rights } = ctx;
  // Before the hold: a run with no key would fail after taking the caller's money.
  if (!GATEWAY_DRIVERS[model.provider].configured(model.endpointId)) {
    throw new OpenStoryError(
      'This provider is not configured on this server',
      'PROVIDER_NOT_CONFIGURED',
      503
    );
  }
  const input = validatedBody(model, body);

  await requireGenerationAllowed({
    userId: scopedDb.userId,
    organizationId: scopedDb.organizationId,
  });
  if (rights !== UPLOAD_RIGHTS_CHECKED) {
    // Saved voices are slots on the shared platform account; the gateway does not own them per organization.
    if (model.provider === 'elevenlabs') {
      throw new ValidationError(
        'ElevenLabs is served only to OpenStory itself'
      );
    }
    refuseVoiceClone(model, input);
    await requireCheckedUploadRights(
      withPlatformLlmKey(rights.scopedDb),
      gatedUrls(input),
      rights.request
    );
  }

  let estimate: Microdollars;
  try {
    estimate = priceGatewayJob(model.card, input);
  } catch (error) {
    if (!(error instanceof RateCardError)) throw error;
    // No floor and no guess: a request the card cannot price is not run.
    throw new ValidationError(
      `This request cannot be priced before it runs (${error.message})`
    );
  }

  const platformFeeBps = GATEWAY_PLATFORM_FEE_BPS;
  const hold = gatewayHoldMicros(estimate);

  const { job, created } = await scopedDb.gatewayJobs.create({
    kind: model.kind,
    modelKey: model.id,
    via: GATEWAY_VIA[model.provider],
    input: await rowBody(input),
    idempotencyKey: ctx.idempotencyKey,
    oauthClientId: ctx.oauthClientId,
  });
  if (!created) {
    await requireSameRequest(job, GATEWAY_VIA[model.provider], model.id, input);
  }

  // Platform keys only: always held, whatever keys the organization has. A replay reuses the hold.
  let reservationId = ctx.runReservationId;
  if (!reservationId) {
    const reserved = await scopedDb.billing.createReservation(hold, {
      idempotencyKey: `gateway:${job.id}`,
    });
    if (!reserved.ok) {
      if (created) await scopedDb.gatewayJobs.deleteUnstarted(job.id);
      throw new InsufficientCreditsError('Insufficient credits for this model');
    }
    reservationId = reserved.reservationId;
  }
  return {
    job,
    created,
    run: {
      jobId: job.id,
      provider: model.provider,
      kind: model.kind,
      target: { modelId: model.id, endpointId: model.endpointId },
      card: model.card,
      input,
      estimateMicros: estimate,
      platformFeeBps,
      oauthClientId: ctx.oauthClientId,
      reservationId,
      ownsReservation: !ctx.runReservationId,
    },
  };
}

/** The public submit: replay, hold, then the run on `GatewayGenerationWorkflow`. */
export async function submitGatewayJob(
  request: {
    provider: GatewayProvider;
    modelId: string;
    body: GatewayJobInput;
  },
  ctx: GatewaySubmitContext
): Promise<GatewaySubmitResult> {
  const { scopedDb } = ctx;
  if (ctx.idempotencyKey) {
    const existing = await scopedDb.gatewayJobs.getByIdempotencyKey(
      ctx.idempotencyKey
    );
    if (existing) {
      await requireSameRequest(
        existing,
        GATEWAY_VIA[request.provider],
        request.modelId,
        request.body
      );
      return { job: existing, replay: true };
    }
  }

  const model = await getGatewayModel(request.provider, request.modelId);
  const { job, created, run } = await holdGatewayJob(model, request.body, {
    scopedDb,
    rights: { scopedDb, request: ctx.request },
    idempotencyKey: ctx.idempotencyKey,
    oauthClientId: ctx.oauthClientId,
    // The public endpoint always holds its own.
    runReservationId: null,
  });
  if (!created) return { job, replay: true };
  const { reservationId } = run;

  const payload: GatewayGenerationWorkflowInput = {
    ...run,
    userId: scopedDb.userId,
    organizationId: scopedDb.organizationId,
    ownsReservation: true,
  };
  const workflowRunId = await releaseReservationOnThrow(
    scopedDb,
    reservationId,
    async () => {
      try {
        return await triggerWorkflow('/gateway', payload, {
          deduplicationId: `gateway-${job.id}`,
        });
      } catch (error) {
        await scopedDb.gatewayJobs.markFailed(job.id, {
          code: 'NOT_STARTED',
          message: GATEWAY_ERROR_MESSAGES.NOT_STARTED,
        });
        throw error;
      }
    }
  );

  try {
    await scopedDb.gatewayJobs.attachRun(job.id, {
      reservationId,
      workflowRunId,
    });
  } catch (error) {
    logger.error(
      `Failed to record run ${workflowRunId} on gateway job ${job.id}`,
      {
        err: error,
      }
    );
  }
  return {
    job: (await scopedDb.gatewayJobs.getById(job.id)) ?? job,
    replay: false,
  };
}
