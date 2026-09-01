/**
 * Anthropic strict-output grammar budget regression test (#1035).
 *
 * Anthropic compiles `response_format: json_schema, strict: true` into a
 * grammar with a hard, model-dependent size cap — measured live (2026-07-03):
 * Fable 5 / Sonnet 5 reject converted schemas at ~3.6KB. Every schema we send
 * as native structured output must stay under ANTHROPIC_GRAMMAR_BUDGET_BYTES
 * so a future schema addition fails CI instead of prod ("The compiled grammar
 * is too large"). Descriptions count toward the budget.
 *
 * The sweep test walks `src/` for `responseSchema:` / `outputSchema:` call
 * sites and fails if one names a schema this file doesn't measure — add new
 * schemas to MEASURED_SCHEMAS.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertSchemaToJsonSchema } from '@tanstack/ai';
import { describe, expect, test } from 'vitest';
import type { z } from 'zod';
import { elementVisionResponseSchema } from './element-vision';
import { talentMediaAnalysisSchema } from './talent-vision';
import { autoStyleResponseSchema } from '@/lib/style/auto-style';
import { softenImagePromptResponseSchema } from '@/lib/workflows/content-soften';
import {
  ANTHROPIC_GRAMMAR_BUDGET_BYTES,
  structuredOutputSchemaBytes,
} from './llm-client';
import {
  locationMatchResponseSchema,
  musicDesignResultSchema,
  sceneDurationResponseSchema,
  sceneSplitBiblesResultSchema,
  sceneSplitScenesResultSchema,
  styleRecommendationResponseSchema,
  talentMatchResponseSchema,
} from './response-schemas';
import {
  motionPromptSchema,
  visualPromptResultSchema,
} from './scene-analysis.schema';

const MEASURED_SCHEMAS: Record<string, z.ZodType> = {
  sceneSplitScenesResultSchema,
  sceneSplitBiblesResultSchema,
  talentMatchResponseSchema,
  locationMatchResponseSchema,
  musicDesignResultSchema,
  sceneDurationResponseSchema,
  styleRecommendationResponseSchema,
  motionPromptSchema,
  visualPromptResultSchema,
  elementVisionResponseSchema,
  talentMediaAnalysisSchema,
  autoStyleResponseSchema,
  softenImagePromptResponseSchema,
};

describe('structured-output schema budget', () => {
  test.each(Object.entries(MEASURED_SCHEMAS))(
    '%s fits the Anthropic grammar budget',
    (name, schema) => {
      const bytes = structuredOutputSchemaBytes(schema);
      expect
        .soft(
          bytes,
          `${name} converts to ${bytes} bytes of JSON Schema, over the ` +
            `${ANTHROPIC_GRAMMAR_BUDGET_BYTES}-byte Anthropic grammar budget — ` +
            `trim fields/descriptions or split the call (see #1035)`
        )
        .toBeLessThanOrEqual(ANTHROPIC_GRAMMAR_BUDGET_BYTES);
    }
  );

  test('every responseSchema/outputSchema call site is measured here', () => {
    const srcRoot = join(__dirname, '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__') continue;
          walk(full);
        } else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts')
        ) {
          files.push(full);
        }
      }
    };
    walk(srcRoot);

    const referenced = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(
        /(?:responseSchema|outputSchema):\s*([A-Za-z_$][\w$]*)/g
      )) {
        const identifier = match[1];
        // Only concrete schema value identifiers: lowercase-first, `Schema`
        // suffix. Skips generic plumbing (`config.responseSchema`, type
        // positions like `JsonSchema`, `undefined`).
        if (
          identifier !== undefined &&
          /^[a-z][\w$]*Schema$/.test(identifier)
        ) {
          referenced.add(identifier);
        }
      }
    }

    // The generic parameter name used by llm-client's own plumbing.
    referenced.delete('responseSchema');

    const unmeasured = [...referenced].filter(
      (name) => !(name in MEASURED_SCHEMAS)
    );
    expect(
      unmeasured,
      `Schemas sent as structured output but not size-budgeted here: ${unmeasured.join(', ')}`
    ).toEqual([]);
  });

  /**
   * Anthropic structured-output JSON Schema limitations
   * (https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations).
   * A 400 here in prod is a silent OpenRouter fallback (#1410).
   */
  test.each(Object.entries(MEASURED_SCHEMAS))(
    '%s complies with Anthropic JSON Schema limitations',
    (name, schema) => {
      const converted = convertSchemaToJsonSchema(schema, {
        forStructuredOutput: true,
      });
      expect(
        converted,
        `${name} failed to convert to JSON Schema`
      ).toBeDefined();
      const violations = collectAnthropicViolations(converted, name);
      expect(
        violations,
        `${name} is invalid for Anthropic structured output: ${violations.join('; ')}`
      ).toEqual([]);
    }
  );
});

/** JSON Schema keys that are values, not nested schemas. */
const NON_SCHEMA_KEYS = new Set([
  'enum',
  'const',
  'required',
  'type',
  'description',
  'title',
  'default',
  'examples',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'uniqueItems',
]);

const UNSUPPORTED_CONSTRAINTS: Record<string, string> = {
  minLength: 'string minLength is not supported',
  maxLength: 'string maxLength is not supported',
  minimum: 'numerical minimum is not supported',
  maximum: 'numerical maximum is not supported',
  exclusiveMinimum: 'exclusiveMinimum is not supported',
  exclusiveMaximum: 'exclusiveMaximum is not supported',
  multipleOf: 'multipleOf is not supported',
  maxItems: 'array maxItems is not supported',
  uniqueItems: 'uniqueItems is not supported',
};

function collectAnthropicViolations(node: unknown, path: string): string[] {
  if (node === null || typeof node !== 'object') return [];
  if (Array.isArray(node)) {
    return node.flatMap((item, i) =>
      collectAnthropicViolations(item, `${path}[${i}]`)
    );
  }
  const type = 'type' in node ? node.type : undefined;
  const enumValues = 'enum' in node ? node.enum : undefined;
  const properties = 'properties' in node ? node.properties : undefined;
  const additionalProperties =
    'additionalProperties' in node ? node.additionalProperties : undefined;
  const here: string[] = [];
  if (Array.isArray(type)) {
    here.push(
      `${path}: type=${JSON.stringify(type)}` +
        (Array.isArray(enumValues) ? ` enum=${JSON.stringify(enumValues)}` : '')
    );
  }
  const isObject =
    type === 'object' ||
    (type === undefined &&
      properties !== undefined &&
      typeof properties === 'object' &&
      properties !== null &&
      !Array.isArray(properties));
  if (isObject && additionalProperties !== false) {
    here.push(
      `${path}: object additionalProperties must be false (got ${JSON.stringify(additionalProperties)})`
    );
  }
  for (const [key, label] of Object.entries(UNSUPPORTED_CONSTRAINTS)) {
    if (Object.hasOwn(node, key)) {
      const value = Object.entries(node).find(([k]) => k === key)?.[1];
      here.push(`${path}: ${label} (${key}=${JSON.stringify(value)})`);
    }
  }
  if ('minItems' in node && node.minItems !== 0 && node.minItems !== 1) {
    here.push(
      `${path}: minItems=${JSON.stringify(node.minItems)} (only 0 or 1 supported)`
    );
  }
  const children = Object.entries(node).flatMap(([key, value]) =>
    NON_SCHEMA_KEYS.has(key)
      ? []
      : collectAnthropicViolations(value, `${path}.${key}`)
  );
  return [...here, ...children];
}
