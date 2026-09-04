/**
 * LLMTR routing + pricing tests.
 *
 * Two things break silently and expensively if they drift, so both are pinned
 * here: a registry id whose LLMTR slug is wrong 404s at generation time (LLMTR
 * namespaces some vendors differently from OpenRouter), and a mapped model
 * with no rate bills $0 — LLMTR reports token counts but no `cost`, so the
 * rate table is the only thing standing between a real call and a free one.
 */

import { describe, expect, it } from 'vitest';
import {
  LLMTR_BASE_URL,
  LLMTR_ONLY_MODEL_IDS,
  LLMTR_RESPONSES_ONLY_MODEL_IDS,
  LLMTR_TEXT_MODELS,
  LLMTR_UNMAPPED_MODEL_IDS,
  llmtrCompatibleApi,
  llmtrTextCostFromUsage,
  llmtrTextModel,
} from './llmtr';
import { SCRIPT_ANALYSIS_MODELS } from './models.config';
import { microsToUsd, ZERO_MICROS } from '@/lib/billing/money';
import { typedEntries } from '@/shared/utils/typed-object';

const usage = (promptTokens: number, completionTokens: number) => ({
  promptTokens,
  completionTokens,
  totalTokens: promptTokens + completionTokens,
});

describe('llmtrTextModel', () => {
  it('translates the vendor prefixes LLMTR spells differently', () => {
    expect(llmtrTextModel('x-ai/grok-4.6')).toBe('xai/grok-4.6');
    expect(llmtrTextModel('z-ai/glm-5.3-flash')).toBe('zai/glm-5.3-flash');
    expect(llmtrTextModel('mistralai/mistral-small-2603')).toBe(
      'mistral/mistral-small-latest'
    );
  });

  it('passes through the ids LLMTR spells the same way', () => {
    expect(llmtrTextModel('anthropic/claude-sonnet-5')).toBe(
      'anthropic/claude-sonnet-5'
    );
    expect(llmtrTextModel('google/gemini-3-flash-preview')).toBe(
      'google/gemini-3-flash-preview'
    );
  });

  it('returns undefined for registry models LLMTR does not carry', () => {
    // Not an oversight: substituting a near neighbour would silently change
    // the model the caller asked for. These stay on OpenRouter/fal.
    expect(llmtrTextModel('anthropic/claude-opus-5-fast')).toBeUndefined();
    expect(llmtrTextModel('deepseek/deepseek-v3.2')).toBeUndefined();
    expect(llmtrTextModel('bytedance-seed/seed-2.0-mini')).toBeUndefined();
  });

  it('returns undefined for an id that is not in the registry at all', () => {
    expect(llmtrTextModel('openai/gpt-4o')).toBeUndefined();
    expect(llmtrTextModel('')).toBeUndefined();
  });

  it('covers every registry id as mapped or explicitly unmapped', () => {
    const registryIds = SCRIPT_ANALYSIS_MODELS.map((model) => model.id);
    const mapped = new Set<string>(
      typedEntries(LLMTR_TEXT_MODELS).map(([id]) => id)
    );
    const unmapped = new Set<string>(LLMTR_UNMAPPED_MODEL_IDS);
    for (const id of registryIds) {
      expect(
        mapped.has(id) || unmapped.has(id),
        `${id} is neither in LLMTR_TEXT_MODELS nor LLMTR_UNMAPPED_MODEL_IDS`
      ).toBe(true);
    }
    for (const [id] of typedEntries(LLMTR_TEXT_MODELS)) {
      expect(registryIds).toContain(id);
    }
  });

  it('lists exactly the mapped slugs that are not valid OpenRouter ids', () => {
    // Renamed slugs are the ones that would 404 if we sent the registry id
    // straight through. An extra or missing entry here is a map-drift signal.
    const renamed = typedEntries(LLMTR_TEXT_MODELS)
      .filter(([registryId, llmtrId]) => registryId !== llmtrId)
      .map(([, llmtrId]) => llmtrId)
      .sort();
    expect([...LLMTR_ONLY_MODEL_IDS].sort()).toEqual(renamed);
  });

  it('sends every OpenAI model and Grok to /v1/responses', () => {
    expect(llmtrCompatibleApi('openai/gpt-5.6-luna')).toBe('responses');
    expect(llmtrCompatibleApi('openai/gpt-5.4-mini')).toBe('responses');
    expect(llmtrCompatibleApi('x-ai/grok-4.6')).toBe('responses');
    expect(llmtrCompatibleApi('anthropic/claude-sonnet-5')).toBe(
      'chat-completions'
    );
    const catalogIds = new Set(Object.values(LLMTR_TEXT_MODELS));
    for (const id of LLMTR_RESPONSES_ONLY_MODEL_IDS) {
      expect(catalogIds.has(id), `${id} is not an LLMTR catalog id`).toBe(true);
    }
  });
});

describe('llmtrTextCostFromUsage', () => {
  it('prices a call from the catalog rates', () => {
    // claude-sonnet-5: $2/M in, $10/M out.
    const cost = llmtrTextCostFromUsage(
      usage(500_000, 100_000),
      'anthropic/claude-sonnet-5'
    );
    expect(cost).toBeDefined();
    expect(microsToUsd(cost ?? ZERO_MICROS)).toBeCloseTo(2, 6);
  });

  it('prices a renamed model under its registry id, not its LLMTR id', () => {
    // Callers only ever hold the registry id — the translation is internal.
    const cost = llmtrTextCostFromUsage(usage(1_000_000, 0), 'x-ai/grok-4.6');
    expect(microsToUsd(cost ?? ZERO_MICROS)).toBeCloseTo(2, 6);
    expect(
      llmtrTextCostFromUsage(usage(1_000_000, 0), 'xai/grok-4.6')
    ).toBeUndefined();
  });

  it('has a rate for every model it routes', () => {
    // A mapped model with no rate would bill $0 forever, silently.
    for (const [registryId] of typedEntries(LLMTR_TEXT_MODELS)) {
      const cost = llmtrTextCostFromUsage(
        usage(1_000_000, 1_000_000),
        registryId
      );
      expect(cost, `no rate for ${registryId}`).toBeDefined();
      expect(cost ?? ZERO_MICROS).toBeGreaterThan(0);
    }
  });

  it('returns undefined rather than inventing a rate', () => {
    // The caller reports these as missing costs; a guessed rate would be
    // indistinguishable from a real charge in the ledger.
    expect(
      llmtrTextCostFromUsage(undefined, 'anthropic/claude-sonnet-5')
    ).toBeUndefined();
    expect(
      llmtrTextCostFromUsage(usage(10, 10), 'anthropic/claude-opus-5-fast')
    ).toBeUndefined();
  });
});

describe('LLMTR_BASE_URL', () => {
  it('carries the /v1 suffix the SDK appends paths onto', () => {
    expect(LLMTR_BASE_URL).toBe('https://llmtr.com/v1');
  });
});
