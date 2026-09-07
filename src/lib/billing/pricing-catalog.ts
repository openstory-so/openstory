/**
 * Public model pricing catalog — single source for the /pricing page.
 * Combines live fal pricing (`model_pricing`, passed in by the server
 * function) with OpenRouter LLM token rates.
 *
 * Columns use **vendor** (who made the model) and **via** (which API we call).
 * Price cells are starting points — full rules live on the via platform.
 */

import type { EffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { estimateStrategy, knownUnitsPerCall } from '@/lib/ai/fal-cost';
import {
  geminiImageCost,
  geminiVideoDurationCost,
  isNativeGeminiVideoModel,
  nativeGeminiImageModel,
  nativeGeminiTextPricing,
} from '@/lib/ai/gemini-native';
import {
  grokImageCost,
  grokVideoDurationCost,
  isNativeGrokVideoModel,
  nativeGrokImageModel,
  nativeGrokTextPricing,
} from '@/lib/ai/grok-native';
import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import { SCRIPT_ANALYSIS_MODELS } from '@/lib/ai/models.config';
import {
  OPENROUTER_PRICING,
  OPENROUTER_PRICING_LAST_UPDATED,
} from '@/lib/ai/openrouter-pricing-data';
import { microsToUsd, type Microdollars } from '@/lib/billing/money';
import { typedEntries } from '@/shared/utils/typed-object';

type PricingVia = 'fal.ai' | 'OpenRouter' | 'BytePlus' | 'xAI' | 'Google';

/**
 * Which native vias the PLATFORM key reaches (#1519). Advisory, like
 * `getViaAvailabilityFn`: the page is public, so this is the platform's
 * route, not a team's BYOK one.
 */
export type PlatformVias = { byteplus: boolean; xai: boolean; google: boolean };

const XAI_DOCS_URL = 'https://docs.x.ai/developers/models';
const GOOGLE_DOCS_URL = 'https://ai.google.dev/gemini-api/docs/pricing';
const BYTEPLUS_DOCS_URL = 'https://docs.byteplus.com/en/docs/ModelArk/1544106';

type PricingRow = {
  name: string;
  /** Who trained / owns the model (xAI, ByteDance, Google, …). */
  vendor: string;
  /** Which API OpenStory calls for this model today. */
  via: PricingVia;
  /** Official pricing / model page on the via platform. */
  docsUrl: string;
  license?: 'open-weight' | 'proprietary';
  /** Short indicative rate — not the full tariff. */
  price: string;
  detail?: string;
};

type PricingSection = {
  id: string;
  title: string;
  description: string;
  rows: PricingRow[];
};

export type PricingCatalog = {
  sections: PricingSection[];
  lastUpdated: string;
};

/** Display label for a raw fal unit string. */
function falUnitLabel(unit: string): string {
  const u = unit.trim().toLowerCase();
  const known: Record<string, string> = {
    images: 'image',
    seconds: 'second',
    minutes: 'minute',
    megapixels: 'megapixel',
    'processed megapixels': 'megapixel',
    'compute seconds': 'compute second',
    videos: 'video',
    '1000 tokens': '1K tokens',
    units: 'generation',
  };
  return known[u] ?? (u || 'generation');
}

function formatUsd(amount: number): string {
  if (amount === 0) return 'Free';
  if (amount >= 0.01) return `$${amount.toFixed(2)}`;
  if (amount >= 0.0001) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(6)}`;
}

function falDocsUrl(endpointId: string): string {
  return `https://fal.ai/models/${endpointId}`;
}

function openRouterDocsUrl(modelId: string): string {
  return `https://openrouter.ai/models/${modelId}`;
}

function formatFalPrice(
  falPricing: Record<string, EffectiveFalPricing>,
  endpointId: string
): { price: string; detail?: string } {
  const pricing = falPricing[endpointId];
  if (!pricing) {
    return { price: 'See fal.ai', detail: 'Live rate unavailable — open docs' };
  }

  const unitUsd = microsToUsd(pricing.unitPrice);
  const unitLabel = falUnitLabel(pricing.unit);

  // For per-call-priced models, show the typical cost the credit gate uses
  // (e.g. gpt-image-2: unit_price=$1 but ~0.22 units → ~$0.22/image).
  // Duration/megapixel models keep their per-unit rate.
  const unitsPerCall =
    estimateStrategy(endpointId, pricing.unit) === 'per_call'
      ? knownUnitsPerCall(pricing)
      : undefined;
  const typical = unitsPerCall != null ? unitUsd * unitsPerCall : null;
  if (typical != null && Math.abs(typical - unitUsd) > unitUsd * 0.05) {
    return {
      price: `~${formatUsd(typical)} / generation`,
      detail: 'Indicative typical cost — billed from platform units',
    };
  }

  return {
    price: `from ${formatUsd(unitUsd)} / ${unitLabel}`,
    detail: 'Indicative unit rate — resolution, duration, and extras vary',
  };
}

function formatLlmPrice(
  pricing:
    | {
        promptPerMillionTokens: number;
        completionPerMillionTokens: number;
        webSearchPerQuery?: number;
      }
    | undefined,
  via: PricingVia
): { price: string; detail?: string } {
  if (!pricing) {
    return {
      price: `See ${via}`,
      detail: 'Billed at platform token rates',
    };
  }

  const input = formatUsd(pricing.promptPerMillionTokens);
  const output = formatUsd(pricing.completionPerMillionTokens);
  const detail =
    pricing.webSearchPerQuery != null
      ? `Web search: ${formatUsd(pricing.webSearchPerQuery)} / query · see ${via} for full tariff`
      : `Token rates — see ${via} for full tariff`;

  return {
    price: `${input} / M in · ${output} / M out`,
    detail,
  };
}

function perUnit(cost: Microdollars, unit: string): string {
  return `${formatUsd(microsToUsd(cost))} / ${unit}`;
}

type NativeRoute = Pick<PricingRow, 'via' | 'docsUrl' | 'price' | 'detail'>;

/** The native route an image model takes on the platform key, else undefined. */
function nativeImageRoute(
  key: TextToImageModel,
  vias: PlatformVias
): NativeRoute | undefined {
  const grok = vias.xai ? nativeGrokImageModel(key) : undefined;
  if (grok) {
    return {
      via: 'xAI',
      docsUrl: XAI_DOCS_URL,
      price: perUnit(grokImageCost(1, grok), 'image'),
      detail: 'Flat rate per image',
    };
  }
  const gemini = vias.google ? nativeGeminiImageModel(key) : undefined;
  if (gemini) {
    return {
      via: 'Google',
      docsUrl: GOOGLE_DOCS_URL,
      price: `from ${perUnit(geminiImageCost(1, gemini, '1K'), 'image')}`,
      detail: 'Advertised 1K rate — 2K and 4K tiers cost more',
    };
  }
  return undefined;
}

/** The native route a video model takes on the platform key, else undefined. */
function nativeVideoRoute(
  key: ImageToVideoModel,
  vias: PlatformVias
): NativeRoute | undefined {
  if (vias.xai && isNativeGrokVideoModel(key)) {
    return {
      via: 'xAI',
      docsUrl: XAI_DOCS_URL,
      price: `from ${perUnit(grokVideoDurationCost(1), 'second')}`,
      detail: 'Indicative unit rate — xAI reports the exact charge per clip',
    };
  }
  if (vias.google && isNativeGeminiVideoModel(key)) {
    return {
      via: 'Google',
      docsUrl: GOOGLE_DOCS_URL,
      price: `~${perUnit(geminiVideoDurationCost(1), 'second')}`,
      detail: 'Billed as video-output tokens at 720p',
    };
  }
  return undefined;
}

export function buildPricingCatalog(opts: {
  falPricing: Record<string, EffectiveFalPricing>;
  /** When the fal snapshot was last refreshed (null = never). */
  falUpdatedAt: Date | null;
  /**
   * Native vias the platform key reaches, so each row quotes the rate it will
   * actually be billed at: BytePlus for Seedance/Seedream (#1157), xAI for
   * Grok, Google for Gemini / Nano Banana. Precedence mirrors the submit
   * path (xAI → Google → BytePlus → fal).
   */
  vias: PlatformVias;
}): PricingCatalog {
  const { falPricing, vias } = opts;

  const toFalRow = (
    model: {
      id: string;
      name: string;
      vendor: string;
      license?: 'open-weight' | 'proprietary';
      byteplusId?: string;
    },
    native?: NativeRoute
  ): PricingRow => {
    if (native) {
      return {
        name: model.name,
        vendor: model.vendor,
        license: model.license,
        ...native,
      };
    }
    const viaByteplus = vias.byteplus && !!model.byteplusId;
    const pricingId = viaByteplus ? model.byteplusId : model.id;
    const { price, detail } = formatFalPrice(falPricing, pricingId ?? model.id);
    return {
      name: model.name,
      vendor: model.vendor,
      via: viaByteplus ? 'BytePlus' : 'fal.ai',
      docsUrl: viaByteplus ? BYTEPLUS_DOCS_URL : falDocsUrl(model.id),
      license: model.license,
      price,
      detail,
    };
  };

  const imageRows = typedEntries(IMAGE_MODELS)
    .filter(([, model]) => !('hidden' in model && model.hidden))
    .sort(([, a], [, b]) => a.qualityRank - b.qualityRank)
    .map(([key, model]) => toFalRow(model, nativeImageRoute(key, vias)));
  const videoRows = typedEntries(IMAGE_TO_VIDEO_MODELS)
    .filter(([, model]) => !('hidden' in model && model.hidden))
    .sort(([, a], [, b]) => a.qualityRank - b.qualityRank)
    .map(([key, model]) => toFalRow(model, nativeVideoRoute(key, vias)));
  const audioRows = Object.values(AUDIO_MODELS)
    .sort((a, b) => a.qualityRank - b.qualityRank)
    .map((model) => toFalRow(model));

  const llmRows: PricingRow[] = SCRIPT_ANALYSIS_MODELS.filter(
    (model) => !('hidden' in model && model.hidden)
  ).map((model) => {
    const grok = vias.xai ? nativeGrokTextPricing(model.id) : undefined;
    const gemini = vias.google ? nativeGeminiTextPricing(model.id) : undefined;
    const via: PricingVia = grok ? 'xAI' : gemini ? 'Google' : 'OpenRouter';
    const { price, detail } = formatLlmPrice(
      grok ?? gemini ?? OPENROUTER_PRICING[model.id],
      via
    );
    return {
      name: model.name,
      vendor: model.vendor,
      via,
      docsUrl: grok
        ? XAI_DOCS_URL
        : gemini
          ? GOOGLE_DOCS_URL
          : openRouterDocsUrl(model.id),
      license: model.license,
      price,
      detail,
    };
  });

  const dateFmt = { month: 'short', day: 'numeric', year: 'numeric' } as const;
  const falDate = opts.falUpdatedAt
    ? opts.falUpdatedAt.toLocaleDateString('en-US', dateFmt)
    : 'pending refresh';
  const orDate = new Date(OPENROUTER_PRICING_LAST_UPDATED).toLocaleDateString(
    'en-US',
    dateFmt
  );

  return {
    // Media first — script analysis is a smaller share of spend and sits last.
    sections: [
      {
        id: 'image',
        title: 'Image generation',
        description:
          'Shots, character sheets, location sheets, and style previews. Indicative rates — open each model’s Via link for resolution tiers and extras.',
        rows: imageRows,
      },
      {
        id: 'video',
        title: 'Video / motion',
        description:
          'Image-to-video per shot. Duration, resolution, and reference media often change the bill — use the Via link for the full tariff.',
        rows: videoRows,
      },
      {
        id: 'audio',
        title: 'Music & audio',
        description:
          'Background music and soundtracks. Billed per minute or second via fal.ai.',
        rows: audioRows,
      },
      {
        id: 'llm',
        title: 'Script analysis',
        description:
          'Script enhancement, scene splitting, character extraction, and motion prompts. Token rates via the listed platform.',
        rows: llmRows,
      },
    ],
    lastUpdated: `Media (fal.ai): ${falDate} · Script analysis (OpenRouter): ${orDate}`,
  };
}
