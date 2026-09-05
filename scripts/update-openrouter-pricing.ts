/**
 * Fetch live pricing from OpenRouter and write src/lib/ai/openrouter-pricing-data.ts
 * Usage:
 *   bun scripts/update-openrouter-pricing.ts
 *
 * Only syncs models in SCRIPT_ANALYSIS_MODELS — the LLM models OpenStory uses.
 * Actual billing uses OpenRouter's per-request `usage.cost`; this file powers
 * the public pricing page and pre-flight estimates.
 */
import { writeFile } from 'node:fs/promises';
import { SCRIPT_ANALYSIS_MODELS } from '@/shared/ai/models.config';

type OpenRouterModel = {
  id: string;
  name: string;
  pricing?: {
    prompt?: string;
    completion?: string;
    web_search?: string;
  };
};

type OpenRouterModelsResponse = {
  data: OpenRouterModel[];
};

const MODEL_IDS = SCRIPT_ANALYSIS_MODELS.map((m) => m.id);

const response = await fetch('https://openrouter.ai/api/v1/models');
if (!response.ok) {
  console.error(`OpenRouter models API failed: ${response.status}`);
  process.exit(1);
}

const payload: OpenRouterModelsResponse = await response.json();
const byId = new Map(payload.data.map((m) => [m.id, m]));

const missing: string[] = [];
const entries: string[] = [];

for (const modelId of MODEL_IDS) {
  const model = byId.get(modelId);
  if (!model?.pricing?.prompt || !model.pricing.completion) {
    missing.push(modelId);
    continue;
  }

  const promptPerM = Number(model.pricing.prompt) * 1_000_000;
  const completionPerM = Number(model.pricing.completion) * 1_000_000;
  const webSearch = model.pricing.web_search
    ? Number(model.pricing.web_search)
    : null;

  entries.push(`  '${modelId}': {
    name: ${JSON.stringify(model.name)},
    promptPerMillionTokens: ${promptPerM},
    completionPerMillionTokens: ${completionPerM},${
      webSearch != null ? `\n    webSearchPerQuery: ${webSearch},` : ''
    }
  },`);
}

if (missing.length > 0) {
  console.warn('Missing pricing for models:', missing.join(', '));
}

const timestamp = new Date().toISOString();
const output = `// AUTO-GENERATED — do not edit manually. Run: bun scripts/update-openrouter-pricing.ts

export type OpenRouterPricing = {
  name: string;
  /** USD per 1M input tokens */
  promptPerMillionTokens: number;
  /** USD per 1M output tokens */
  completionPerMillionTokens: number;
  /** USD per web search query, when supported */
  webSearchPerQuery?: number;
};

export const OPENROUTER_PRICING: Record<string, OpenRouterPricing> = {
${entries.join('\n')}
};

export const OPENROUTER_PRICING_LAST_UPDATED = '${timestamp}';
`;

await writeFile('src/lib/ai/openrouter-pricing-data.ts', output);
console.log(
  `Wrote ${entries.length} model prices to src/lib/ai/openrouter-pricing-data.ts`
);
if (missing.length > 0) process.exit(1);
