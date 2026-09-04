import type { JsonSchema } from '@/lib/models/catalog';
import { describe, expect, it } from 'vitest';
import {
  CHIP_ENUM_MAX,
  MAX_FIELD_DEPTH,
  issuesToFieldErrors,
  matchVariant,
  orderedPropertyNames,
  parseJsonDraft,
  partitionObjectFields,
  planWidget,
  resolveRef,
  seedFormValue,
  seedValue,
  isOmittedFormValue,
  withOptionalField,
  variantsOf,
} from './widget-plan';

const emptyRoot: JsonSchema = {};

describe('resolveRef', () => {
  it('follows a $ref into $defs', () => {
    const root: JsonSchema = {
      $defs: { Size: { type: 'string', enum: ['square', 'portrait'] } },
    };
    const resolved = resolveRef({ $ref: '#/$defs/Size' }, root);
    expect(resolved.enum).toEqual(['square', 'portrait']);
  });

  it('follows chained refs', () => {
    const root: JsonSchema = {
      $defs: {
        A: { $ref: '#/$defs/B' },
        B: { type: 'integer' },
      },
    };
    expect(resolveRef({ $ref: '#/$defs/A' }, root).type).toBe('integer');
  });

  it('terminates on circular refs instead of hanging', () => {
    const root: JsonSchema = {
      $defs: {
        A: { $ref: '#/$defs/B' },
        B: { $ref: '#/$defs/A' },
      },
    };
    const resolved = resolveRef({ $ref: '#/$defs/A' }, root);
    expect(resolved.$ref).toMatch(/#\/\$defs\//);
  });

  it('returns the node unchanged when the def is missing', () => {
    const node: JsonSchema = { $ref: '#/$defs/Nope', title: 'orphan' };
    expect(resolveRef(node, emptyRoot)).toBe(node);
  });
});

describe('orderedPropertyNames', () => {
  it('honors x-fal-order-properties, drops unknown names, appends unlisted', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { a: {}, b: {}, c: {} },
      'x-fal-order-properties': ['c', 'ghost', 'a'],
    };
    expect(orderedPropertyNames(schema)).toEqual(['c', 'a', 'b']);
  });

  it('falls back to required-first in declaration order', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { optional1: {}, req1: {}, optional2: {}, req2: {} },
      required: ['req1', 'req2'],
    };
    expect(orderedPropertyNames(schema)).toEqual([
      'req1',
      'req2',
      'optional1',
      'optional2',
    ]);
  });
});

describe('partitionObjectFields', () => {
  it('puts the prompt first and parks long-tail optionals in Advanced', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        seed: { type: 'integer' },
        prompt: { type: 'string' },
        enable_safety_checker: { type: 'boolean' },
        num_images: { type: 'integer' },
        image_url: { type: 'string' },
      },
      required: ['prompt'],
    };
    expect(partitionObjectFields(schema)).toEqual({
      primary: ['prompt', 'image_url', 'num_images'],
      advanced: ['seed', 'enable_safety_checker'],
    });
  });

  it('keeps required fields on the main form even when they are not common knobs', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        enable_safety_checker: { type: 'boolean' },
        prompt: { type: 'string' },
      },
      required: ['prompt', 'enable_safety_checker'],
    };
    expect(partitionObjectFields(schema)).toEqual({
      primary: ['prompt', 'enable_safety_checker'],
      advanced: [],
    });
  });
});

describe('isOmittedFormValue / withOptionalField', () => {
  it('treats empty widgets as omit, but keeps 0', () => {
    expect(isOmittedFormValue(undefined)).toBe(true);
    expect(isOmittedFormValue('')).toBe(true);
    expect(isOmittedFormValue(false)).toBe(false);
    expect(isOmittedFormValue([])).toBe(true);
    expect(isOmittedFormValue({})).toBe(true);
    expect(isOmittedFormValue(0)).toBe(false);
    expect(isOmittedFormValue('a fox')).toBe(false);
  });

  it('drops an optional key when the widget is cleared', () => {
    expect(
      withOptionalField({ prompt: 'fox', seed: 3 }, 'seed', '', false)
    ).toEqual({ prompt: 'fox' });
    expect(withOptionalField({ prompt: 'fox' }, 'seed', 12, false)).toEqual({
      prompt: 'fox',
      seed: 12,
    });
  });

  it('never drops a required field', () => {
    expect(withOptionalField({ prompt: 'fox' }, 'prompt', '', true)).toEqual({
      prompt: '',
    });
  });
});

describe('planWidget', () => {
  const plan = (
    name: string,
    schema: JsonSchema,
    root: JsonSchema = emptyRoot
  ) => planWidget(name, schema, root, 0);

  it('renders const as read-only', () => {
    expect(plan('mode', { const: 'fixed' })).toEqual({
      kind: 'const',
      value: 'fixed',
    });
  });

  it('renders small enums as chips and large enums as a select', () => {
    const atCap = plan('size', {
      enum: Array.from({ length: CHIP_ENUM_MAX }, (_, i) => `option-${i}`),
    });
    expect(atCap).toMatchObject({ kind: 'enum', style: 'chips' });
    const overCap = plan('size', {
      enum: Array.from({ length: CHIP_ENUM_MAX + 1 }, (_, i) => `option-${i}`),
    });
    expect(overCap).toMatchObject({ kind: 'enum', style: 'select' });
  });

  it('renders booleans as a switch', () => {
    expect(plan('enable_safety_checker', { type: 'boolean' })).toEqual({
      kind: 'boolean',
    });
  });

  it('renders bounded numbers as a slider and unbounded as an input', () => {
    const bounded = plan('guidance_scale', {
      type: 'number',
      minimum: 1,
      maximum: 20,
    });
    expect(bounded).toMatchObject({
      kind: 'number',
      slider: true,
      min: 1,
      max: 20,
    });

    const unbounded = plan('seed', { type: 'integer', minimum: 0 });
    expect(unbounded).toMatchObject({
      kind: 'number',
      slider: false,
      integer: true,
      step: 1,
    });
  });

  it('uses integer step 1 and multipleOf when present', () => {
    expect(
      plan('steps', { type: 'integer', minimum: 1, maximum: 50 })
    ).toMatchObject({ step: 1 });
    expect(
      plan('strength', {
        type: 'number',
        minimum: 0,
        maximum: 1,
        multipleOf: 0.05,
      })
    ).toMatchObject({ step: 0.05 });
  });

  it('detects URL fields by format and by name, with image preview hints', () => {
    expect(plan('source', { type: 'string', format: 'uri' })).toMatchObject({
      kind: 'url',
    });
    expect(plan('image_url', { type: 'string' })).toEqual({
      kind: 'url',
      imagePreview: true,
    });
    expect(plan('audio_url', { type: 'string' })).toEqual({
      kind: 'url',
      imagePreview: false,
    });
  });

  it('detects long text by name and maxLength', () => {
    expect(plan('prompt', { type: 'string' })).toEqual({
      kind: 'text',
      long: true,
    });
    expect(plan('negative_prompt', { type: 'string' })).toEqual({
      kind: 'text',
      long: true,
    });
    expect(plan('title', { type: 'string', maxLength: 500 })).toEqual({
      kind: 'text',
      long: true,
    });
    expect(plan('title', { type: 'string', maxLength: 80 })).toEqual({
      kind: 'text',
      long: false,
    });
  });

  it('collapses nullable anyOf to the single real variant', () => {
    const nullable: JsonSchema = {
      anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }],
    };
    expect(plan('seed', nullable)).toMatchObject({
      kind: 'number',
      integer: true,
    });
  });

  it('renders multi-variant anyOf as variant tabs', () => {
    const union: JsonSchema = {
      anyOf: [
        { type: 'string', enum: ['square_hd', 'portrait_4_3'] },
        {
          type: 'object',
          properties: {
            width: { type: 'integer' },
            height: { type: 'integer' },
          },
        },
      ],
    };
    const result = plan('image_size', union);
    expect(result.kind).toBe('variants');
    if (result.kind === 'variants') {
      expect(result.variants).toHaveLength(2);
    }
  });

  it('unwraps single-entry allOf (OpenAPI enum-ref pattern)', () => {
    const root: JsonSchema = {
      $defs: { Format: { type: 'string', enum: ['jpeg', 'png'] } },
    };
    expect(
      plan('output_format', { allOf: [{ $ref: '#/$defs/Format' }] }, root)
    ).toMatchObject({ kind: 'enum' });
  });

  it('plans arrays and objects recursively, raw when unplannable', () => {
    expect(
      plan('voice_ids', { type: 'array', items: { type: 'string' } })
    ).toMatchObject({ kind: 'array' });
    expect(
      plan('image_size', {
        type: 'object',
        properties: { width: { type: 'integer' } },
      })
    ).toEqual({ kind: 'object' });
    expect(plan('mystery', {})).toEqual({ kind: 'raw' });
    expect(plan('untyped_object', { properties: { a: {} } })).toEqual({
      kind: 'object',
    });
  });

  it('falls back to raw JSON past the depth cap', () => {
    expect(
      planWidget('deep', { type: 'string' }, emptyRoot, MAX_FIELD_DEPTH + 1)
    ).toEqual({ kind: 'raw' });
  });
});

describe('planWidget cycle safety', () => {
  it('terminates on a self-referential $def reached via anyOf (single-variant collapse)', () => {
    const root: JsonSchema = {
      $defs: { Node: { anyOf: [{ $ref: '#/$defs/Node' }] } },
    };
    const node = root.$defs?.Node;
    if (!node) throw new Error('test setup');
    // Before the depth+1 fix this recursed forever: the collapse re-planned
    // the same schema at the same depth, so neither guard ever fired.
    expect(planWidget('node', node, root, 0)).toEqual({ kind: 'raw' });
  });

  it('terminates on a self-referential $def reached via allOf unwrap', () => {
    const root: JsonSchema = {
      $defs: { Loop: { allOf: [{ $ref: '#/$defs/Loop' }] } },
    };
    const loop = root.$defs?.Loop;
    if (!loop) throw new Error('test setup');
    expect(planWidget('loop', loop, root, 0)).toEqual({ kind: 'raw' });
  });
});

describe('variantsOf', () => {
  it('drops null variants and resolves refs', () => {
    const root: JsonSchema = { $defs: { S: { type: 'string' } } };
    const variants = variantsOf(
      { anyOf: [{ $ref: '#/$defs/S' }, { type: 'null' }] },
      root
    );
    expect(variants).toHaveLength(1);
    expect(variants?.[0]?.type).toBe('string');
  });

  it('returns undefined without oneOf/anyOf', () => {
    expect(variantsOf({ type: 'string' }, emptyRoot)).toBeUndefined();
  });
});

describe('seedValue / seedFormValue', () => {
  it('prefers default, then const, then first enum option', () => {
    expect(seedValue({ type: 'integer', default: 4 }, emptyRoot)).toBe(4);
    expect(seedValue({ const: 'fixed' }, emptyRoot)).toBe('fixed');
    expect(seedValue({ enum: ['a', 'b'] }, emptyRoot)).toBe('a');
  });

  it('seeds by type when nothing else applies', () => {
    expect(seedValue({ type: 'string' }, emptyRoot)).toBe('');
    expect(seedValue({ type: 'number', minimum: 2 }, emptyRoot)).toBe(2);
    expect(seedValue({ type: 'boolean' }, emptyRoot)).toBe(false);
    expect(seedValue({ type: 'array' }, emptyRoot)).toEqual([]);
  });

  it('seeds strictly above a bare exclusiveMinimum', () => {
    // exclusiveMinimum: 0 seeding 0 would fail server validation immediately.
    expect(seedValue({ type: 'integer', exclusiveMinimum: 0 }, emptyRoot)).toBe(
      1
    );
    expect(
      seedValue(
        { type: 'number', exclusiveMinimum: 0, multipleOf: 0.5 },
        emptyRoot
      )
    ).toBe(0.5);
    // An inclusive minimum still wins.
    expect(
      seedValue({ type: 'number', minimum: 2, exclusiveMinimum: 0 }, emptyRoot)
    ).toBe(2);
  });

  it('seeds arrays up to minItems', () => {
    expect(
      seedValue(
        { type: 'array', minItems: 2, items: { type: 'string', default: 'x' } },
        emptyRoot
      )
    ).toEqual(['x', 'x']);
  });

  it('seeds objects with required properties only', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        num_images: { type: 'integer', default: 1 },
        seed: { type: 'integer' },
      },
      required: ['prompt', 'num_images'],
    };
    expect(seedFormValue(schema)).toEqual({ prompt: '', num_images: 1 });
  });

  it('seeds through $refs and variant unions', () => {
    const root: JsonSchema = {
      type: 'object',
      properties: {
        image_size: {
          anyOf: [
            { $ref: '#/$defs/SizeEnum' },
            { type: 'object', properties: {} },
          ],
        },
      },
      required: ['image_size'],
      $defs: { SizeEnum: { type: 'string', enum: ['square_hd', 'portrait'] } },
    };
    expect(seedFormValue(root)).toEqual({ image_size: 'square_hd' });
  });
});

describe('matchVariant', () => {
  const variants: JsonSchema[] = [
    { type: 'string', enum: ['square_hd', 'portrait'] },
    {
      type: 'object',
      properties: { width: { type: 'integer' }, height: { type: 'integer' } },
    },
  ];

  it('matches an enum value to the enum variant', () => {
    expect(matchVariant('portrait', variants)).toBe(0);
  });

  it('matches an object value to the object variant', () => {
    expect(matchVariant({ width: 512, height: 512 }, variants)).toBe(1);
  });

  it('defaults to the first variant for undefined values', () => {
    expect(matchVariant(undefined, variants)).toBe(0);
  });
});

describe('parseJsonDraft', () => {
  it('parses valid JSON and rejects invalid drafts', () => {
    expect(parseJsonDraft('{"a": 1}')).toEqual({ a: 1 });
    expect(parseJsonDraft('nope{')).toBeUndefined();
  });
});

describe('issuesToFieldErrors', () => {
  it('folds typed issues into per-field messages, first message per path winning', () => {
    expect(
      issuesToFieldErrors([
        { path: 'prompt', message: 'Required' },
        { path: 'image_size.width', message: 'Too small' },
        { path: 'prompt', message: 'A later duplicate' },
      ])
    ).toEqual({
      prompt: 'Required',
      'image_size.width': 'Too small',
    });
  });

  it('keys pathless issues under the empty string, even with separator-laden messages', () => {
    // Zod messages routinely contain ': ' and '; ' — the typed contract must
    // not care (this is what killed the old string-parsing approach).
    expect(
      issuesToFieldErrors([
        {
          path: '',
          message: 'Invalid input: expected string; received number',
        },
      ])
    ).toEqual({ '': 'Invalid input: expected string; received number' });
  });
});
