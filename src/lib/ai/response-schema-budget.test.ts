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
});
