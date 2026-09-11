/**
 * Guards for CATALOG_LAG_MODELS and GEMINI_CATALOG_LAG_MODELS
 * (create-adapter.ts) — registry / native ids the installed adapter catalogs
 * don't know yet.
 *
 * The prune check is compile-time: when an `@tanstack/ai-openrouter` or
 * `@tanstack/ai-gemini` bump ships a lag id, `bun typecheck` fails here
 * naming the id — delete that entry in the same PR. Dependabot owns those
 * package bumps (#792 no longer touches npm deps).
 */
import type { GeminiTextModel } from '@tanstack/ai-gemini';
import type { OpenRouterModelOptionsByName } from '@tanstack/ai-openrouter';
import { describe, expectTypeOf, it } from 'vitest';
import type {
  CATALOG_LAG_MODELS,
  GEMINI_CATALOG_LAG_MODELS,
} from './create-adapter';
import type { NativeGeminiTextModel } from '@/models/gemini-native';
import type { AnalysisModelId } from '@/models/models.config';

type CatalogId = keyof OpenRouterModelOptionsByName;
type LagId = (typeof CATALOG_LAG_MODELS)['length'] extends 0
  ? never
  : (typeof CATALOG_LAG_MODELS)[number] extends { name: infer N }
    ? N
    : never;

/** Lag ids the upstream catalog now includes — must stay `never`. */
type StaleLagEntries = Extract<CatalogId, LagId>;

/** Lag ids that left the model registry — must stay `never`. */
type UnregisteredLagEntries = Exclude<LagId, AnalysisModelId>;

describe('CATALOG_LAG_MODELS', () => {
  it('contains no id the upstream catalog now ships (prune it when this fails)', () => {
    expectTypeOf<StaleLagEntries>().toBeNever();
  });

  it('only bridges ids that are still in the model registry', () => {
    expectTypeOf<UnregisteredLagEntries>().toBeNever();
  });
});

type GeminiLagId = (typeof GEMINI_CATALOG_LAG_MODELS)['length'] extends 0
  ? never
  : (typeof GEMINI_CATALOG_LAG_MODELS)[number] extends { name: infer N }
    ? N
    : never;

type StaleGeminiLagEntries = Extract<GeminiTextModel, GeminiLagId>;
type UnregisteredGeminiLagEntries = Exclude<GeminiLagId, NativeGeminiTextModel>;

describe('GEMINI_CATALOG_LAG_MODELS', () => {
  it('contains no id the upstream catalog now ships (prune it when this fails)', () => {
    expectTypeOf<StaleGeminiLagEntries>().toBeNever();
  });

  it('only bridges native Gemini names that are still routed', () => {
    expectTypeOf<UnregisteredGeminiLagEntries>().toBeNever();
  });
});
