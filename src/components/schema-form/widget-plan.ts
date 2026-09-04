/**
 * Pure schema→widget planning for `<SchemaForm />` (#458).
 *
 * Walks a fal endpoint's input JSON Schema (self-contained; `$ref`s point
 * into the root `$defs`) and decides, per field, which widget renders it.
 * All heuristics live here — the React layer in schema-form.tsx is a thin
 * switch over `WidgetPlan` — so widget selection, ordering, and value
 * seeding are unit-testable without rendering.
 *
 * The server remains the validator of record (`createGeneratedAssetFn`
 * re-validates against the live schema); everything here is UX.
 */

import type { JsonSchema, JsonValue } from '@/lib/models/catalog';

/**
 * Beyond this nesting depth a field falls back to the raw-JSON escape hatch.
 * Real fal schemas are 2–3 levels deep; the cap exists for `$defs` cycles
 * that `resolveRef`'s hop limit alone can't unwind (recursion through
 * `properties`/`items`/`anyOf`/`allOf` never terminates by ref-resolution
 * alone). Every recursion — including the single-variant collapse and the
 * allOf unwrap in `planWidget` — must therefore advance `depth`.
 */
export const MAX_FIELD_DEPTH = 8;

/** Enums up to this size render as a chip group; larger ones as a Select. */
export const CHIP_ENUM_MAX = 6;

const REF_HOP_LIMIT = 16;

/** Follow `$ref: "#/$defs/Name"` chains against the root schema's `$defs`. */
export function resolveRef(schema: JsonSchema, root: JsonSchema): JsonSchema {
  let current = schema;
  for (let hop = 0; hop < REF_HOP_LIMIT; hop++) {
    const ref = current.$ref;
    if (!ref || !ref.startsWith('#/$defs/')) return current;
    const target = root.$defs?.[ref.slice('#/$defs/'.length)];
    if (!target) return current;
    current = target;
  }
  return current;
}

/** The `type` keyword, taking the first entry when it is an array. */
function schemaTypeOf(schema: JsonSchema): string | undefined {
  return Array.isArray(schema.type) ? schema.type[0] : schema.type;
}

function isNullSchema(schema: JsonSchema): boolean {
  return schemaTypeOf(schema) === 'null' && !schema.enum && !schema.properties;
}

/**
 * `anyOf`/`oneOf` variants, resolved against the root, with bare `null`
 * variants dropped — fal expresses optionality as `anyOf: [X, {type:null}]`,
 * and the "not provided" case is the omitted-field chip, not a tab.
 */
export function variantsOf(
  schema: JsonSchema,
  root: JsonSchema
): JsonSchema[] | undefined {
  const list = schema.oneOf ?? schema.anyOf;
  if (!list) return undefined;
  const variants = list
    .map((variant) => resolveRef(variant, root))
    .filter((variant) => !isNullSchema(variant));
  return variants.length > 0 ? variants : undefined;
}

// ---------------------------------------------------------------------------
// Widget plans
// ---------------------------------------------------------------------------

export type WidgetPlan =
  | { kind: 'const'; value: JsonValue }
  | { kind: 'enum'; options: JsonValue[]; style: 'chips' | 'select' }
  | { kind: 'boolean' }
  | {
      kind: 'number';
      integer: boolean;
      min?: number;
      max?: number;
      step: number;
      slider: boolean;
    }
  | { kind: 'url'; imagePreview: boolean }
  | { kind: 'text'; long: boolean }
  | { kind: 'array'; items: JsonSchema }
  | { kind: 'object' }
  | { kind: 'variants'; variants: JsonSchema[] }
  | { kind: 'raw' };

const URL_NAME_HINT = /(^|_)(url|uri)$|image|img/i;
const IMAGE_HINT = /image|img/i;
const LONG_TEXT_NAME_HINT = /prompt|description|instruction|lyrics|script/i;
const LONG_TEXT_MAX_LENGTH = 160;
const LONG_TEXT_EXAMPLE_LENGTH = 120;

function planString(name: string, schema: JsonSchema): WidgetPlan {
  const description = schema.description ?? '';
  if (
    schema.format === 'uri' ||
    URL_NAME_HINT.test(name) ||
    /image url/i.test(description)
  ) {
    return {
      kind: 'url',
      imagePreview: IMAGE_HINT.test(name) || /image url/i.test(description),
    };
  }
  const example = schema.examples?.[0];
  const long =
    LONG_TEXT_NAME_HINT.test(name) ||
    (schema.maxLength ?? 0) > LONG_TEXT_MAX_LENGTH ||
    (typeof example === 'string' && example.length > LONG_TEXT_EXAMPLE_LENGTH);
  return { kind: 'text', long };
}

function planNumber(schema: JsonSchema, integer: boolean): WidgetPlan {
  const min = schema.minimum ?? schema.exclusiveMinimum;
  const max = schema.maximum ?? schema.exclusiveMaximum;
  const slider = min !== undefined && max !== undefined && max > min;
  const rangeStep =
    min !== undefined && max !== undefined && max > min
      ? Math.max((max - min) / 100, 0.001)
      : 0.1;
  const step = schema.multipleOf ?? (integer ? 1 : rangeStep);
  return { kind: 'number', integer, min, max, step, slider };
}

/**
 * Decide the widget for one (already `$ref`-resolved) field schema. `name`
 * feeds the string heuristics (image/url/prompt detection); `depth` is the
 * current nesting level, capped at MAX_FIELD_DEPTH.
 */
export function planWidget(
  name: string,
  schema: JsonSchema,
  root: JsonSchema,
  depth: number
): WidgetPlan {
  if (depth > MAX_FIELD_DEPTH) return { kind: 'raw' };

  if (schema.const !== undefined && !schema.enum) {
    return { kind: 'const', value: schema.const };
  }

  if (schema.enum && schema.enum.length > 0) {
    return {
      kind: 'enum',
      options: schema.enum,
      style: schema.enum.length <= CHIP_ENUM_MAX ? 'chips' : 'select',
    };
  }

  const variants = variantsOf(schema, root);
  if (variants) {
    const only = variants.length === 1 ? variants[0] : undefined;
    if (only) return planWidget(name, only, root, depth + 1);
    return { kind: 'variants', variants };
  }

  // OpenAPI-derived schemas wrap enum refs as `allOf: [$ref]`.
  const allOfOnly = schema.allOf?.length === 1 ? schema.allOf[0] : undefined;
  if (allOfOnly) {
    return planWidget(name, resolveRef(allOfOnly, root), root, depth + 1);
  }

  switch (schemaTypeOf(schema)) {
    case 'boolean':
      return { kind: 'boolean' };
    case 'integer':
      return planNumber(schema, true);
    case 'number':
      return planNumber(schema, false);
    case 'string':
      return planString(name, schema);
    case 'array':
      return schema.items
        ? { kind: 'array', items: schema.items }
        : { kind: 'raw' };
    case 'object':
      return schema.properties ? { kind: 'object' } : { kind: 'raw' };
    default:
      // Untyped but structurally an object (some fal $defs omit `type`).
      return schema.properties ? { kind: 'object' } : { kind: 'raw' };
  }
}

// ---------------------------------------------------------------------------
// Property ordering
// ---------------------------------------------------------------------------

/**
 * Field order for an object schema: fal's `x-fal-order-properties` when
 * present (unknown names dropped, unlisted properties appended), otherwise
 * required properties first, each group in declaration order.
 */
export function orderedPropertyNames(schema: JsonSchema): string[] {
  const names = Object.keys(schema.properties ?? {});
  const falOrder = schema['x-fal-order-properties'];
  if (falOrder) {
    const known = falOrder.filter((name) => names.includes(name));
    const listed = new Set(known);
    return [...known, ...names.filter((name) => !listed.has(name))];
  }
  const required = new Set(schema.required ?? []);
  return [
    ...names.filter((name) => required.has(name)),
    ...names.filter((name) => !required.has(name)),
  ];
}

/**
 * Names that stay on the main form even when optional: the prompt, media
 * URLs, and a handful of always-used generation knobs. Everything else
 * optional goes under Advanced. Required fields are always primary.
 */
const PRIMARY_FIELD_NAME =
  /^(prompt|text|negative_prompt|image_url|image_urls|reference_image_urls|image|end_image_url|start_image_url|video_url|video_urls|reference_video_urls|audio_url|audio_urls|reference_audio_urls|aspect_ratio|duration|num_images)$/i;

function isPrimaryFieldName(name: string): boolean {
  return PRIMARY_FIELD_NAME.test(name);
}

function primaryRank(name: string): number {
  if (/^(prompt|text)$/i.test(name)) return 0;
  if (/^negative_prompt$/i.test(name)) return 1;
  if (
    /^(image_url|image_urls|reference_image_urls|image|end_image_url|start_image_url|video_url|video_urls|reference_video_urls|audio_url|audio_urls|reference_audio_urls)$/i.test(
      name
    )
  ) {
    return 2;
  }
  if (/^(aspect_ratio|duration|num_images)$/i.test(name)) return 3;
  return 4;
}

/** Split an object schema into always-visible vs Advanced optional fields. */
export function partitionObjectFields(schema: JsonSchema): {
  primary: string[];
  advanced: string[];
} {
  const ordered = orderedPropertyNames(schema);
  const required = new Set(schema.required ?? []);
  const primary: string[] = [];
  const advanced: string[] = [];
  for (const name of ordered) {
    if (required.has(name) || isPrimaryFieldName(name)) {
      primary.push(name);
    } else {
      advanced.push(name);
    }
  }
  primary.sort((a, b) => {
    const rank = primaryRank(a) - primaryRank(b);
    if (rank !== 0) return rank;
    return ordered.indexOf(a) - ordered.indexOf(b);
  });
  return { primary, advanced };
}

/**
 * Empty optional controls omit the key (fal treats omit ≠ default). A
 * required field is never omitted here — the caller must keep it.
 */
export function isOmittedFormValue(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    return true;
  }
  return false;
}

/**
 * Set or drop a field. Empty optional widgets never reach the payload;
 * `undefined` drops the key whether or not the field is required.
 */
export function withOptionalField(
  value: Record<string, JsonValue>,
  name: string,
  next: JsonValue | undefined,
  required: boolean
): Record<string, JsonValue> {
  if (!required && isOmittedFormValue(next)) {
    const { [name]: _dropped, ...rest } = value;
    return rest;
  }
  if (next === undefined) {
    const { [name]: _dropped, ...rest } = value;
    return rest;
  }
  return { ...value, [name]: next };
}

// ---------------------------------------------------------------------------
// Value seeding
// ---------------------------------------------------------------------------

/**
 * Starter value for a schema: default → const → enum[0] → first variant →
 * type seed. Object seeds cover required properties only — optional fields
 * stay absent until the user fills them (empty = omit).
 */
export function seedValue(
  schema: JsonSchema,
  root: JsonSchema,
  depth = 0
): JsonValue {
  if (depth > MAX_FIELD_DEPTH) return null;
  const resolved = resolveRef(schema, root);

  if (resolved.default !== undefined) return resolved.default;
  if (resolved.const !== undefined) return resolved.const;
  const first = resolved.enum?.[0];
  if (first !== undefined) return first;

  const firstVariant = variantsOf(resolved, root)?.[0];
  if (firstVariant) return seedValue(firstVariant, root, depth + 1);
  const allOfOnly =
    resolved.allOf?.length === 1 ? resolved.allOf[0] : undefined;
  if (allOfOnly) return seedValue(allOfOnly, root, depth + 1);

  switch (schemaTypeOf(resolved)) {
    case 'string':
      return '';
    case 'integer':
    case 'number': {
      if (resolved.minimum !== undefined) return resolved.minimum;
      // `exclusiveMinimum` alone: seed just above it, or the server-side
      // validation rejects the seed (e.g. exclusiveMinimum: 0 seeding 0).
      if (resolved.exclusiveMinimum !== undefined) {
        const step =
          resolved.multipleOf ??
          (schemaTypeOf(resolved) === 'integer' ? 1 : 0.01);
        return resolved.exclusiveMinimum + step;
      }
      return 0;
    }
    case 'boolean':
      return false;
    case 'array': {
      const minItems = resolved.minItems ?? 0;
      if (minItems > 0 && resolved.items) {
        const items = resolved.items;
        return Array.from({ length: minItems }, () =>
          seedValue(items, root, depth + 1)
        );
      }
      return [];
    }
    case 'object':
      return seedObjectValue(resolved, root, depth);
    default:
      return resolved.properties
        ? seedObjectValue(resolved, root, depth)
        : null;
  }
}

function seedObjectValue(
  schema: JsonSchema,
  root: JsonSchema,
  depth: number
): Record<string, JsonValue> {
  const seeded: Record<string, JsonValue> = {};
  const required = new Set(schema.required ?? []);
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (required.has(name)) {
      seeded[name] = seedValue(property, root, depth + 1);
    }
  }
  return seeded;
}

/** Initial form value for a root input schema: its required fields, seeded. */
export function seedFormValue(root: JsonSchema): Record<string, JsonValue> {
  return seedObjectValue(resolveRef(root, root), root, 0);
}

/**
 * Fold `createGeneratedAssetFn`'s typed issue list into per-field messages
 * for `<SchemaForm errors>` (first message per path wins; issues without a
 * path key under '').
 */
export function issuesToFieldErrors(
  issues: Array<{ path: string; message: string }>
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    errors[issue.path] ??= issue.message;
  }
  return errors;
}

/** Parse the raw-JSON escape hatch's draft text, or undefined when invalid. */
export function parseJsonDraft(text: string): JsonValue | undefined {
  try {
    // eslint-disable-next-line @typescript/no-unsafe-type-assertion -- JSON.parse can only produce JSON values
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * Index of the variant whose shape best matches the current value, so the
 * variant Tabs open on the tab the value already conforms to.
 */
export function matchVariant(
  value: JsonValue | undefined,
  variants: JsonSchema[]
): number {
  if (value === undefined) return 0;
  let best = 0;
  let bestScore = -1;
  variants.forEach((variant, index) => {
    let score = 0;
    const type = schemaTypeOf(variant);
    const valueType = Array.isArray(value) ? 'array' : typeof value;
    if (type === valueType) score += 1;
    if (type === 'integer' && valueType === 'number') score += 1;
    if (variant.enum?.some((option) => option === value)) score += 2;
    if (
      type === 'object' &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      for (const name of Object.keys(variant.properties ?? {})) {
        if (name in value) score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

/** Short human label for a schema — variant tab titles, array item labels. */
export function schemaLabel(schema: JsonSchema, fallback: string): string {
  if (schema.title) return schema.title;
  if (typeof schema.const === 'string') return schema.const;
  const type = schemaTypeOf(schema);
  if (type) return type;
  if (schema.enum) return 'choice';
  return fallback;
}
