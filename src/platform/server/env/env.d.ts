// Vars the generated `Cloudflare.Env` (worker-configuration.d.ts) does not
// declare: test and local-dev hooks and optional keys, set per laptop or per
// deploy and absent from wrangler.jsonc. Declared here so `getEnv()` reads
// them typed instead of through a cast.
declare namespace Cloudflare {
  interface Env {
    /** aimock base URLs for the native vias and OpenRouter in e2e. */
    XAI_BASE_URL?: string;
    GEMINI_BASE_URL?: string;
    OPENROUTER_BASE_URL?: string;
    /** `'1'` while recording e2e fixtures against the real providers. */
    E2E_RECORD?: string;
    /** `'true'` when e2e runs real workflows instead of mock trigger ids. */
    E2E_FULL_PIPELINE?: string;
    /** Storage CDN domain; unset means the worker's `/r2/$` route serves. */
    R2_PUBLIC_STORAGE_DOMAIN?: string;
    /** Lifts modelschemas.com off its anonymous rate limit. */
    MODELSCHEMAS_API_KEY?: string;
    /** Local-dev export renderer (`bun dev:bunny`), never set in prod. */
    VIDEO_EXPORT_DEV_URL?: string;
    VIDEO_EXPORT_DEV_MEDIA_ORIGIN?: string;
  }
}
