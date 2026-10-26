// Optional vars and secrets. `worker-configuration.d.ts` types the required
// runtime secrets from the push catalog (`scripts/push-secrets.ts`, via
// `scripts/regen-worker-types.ts`) and the vars in wrangler.jsonc; everything
// the Worker runs without is declared here. `push-secrets.test.ts` checks
// every `optional` catalog entry is listed.
declare namespace Cloudflare {
  interface Env {
    // ── Optional secrets in the push catalog ──
    /** BytePlus Ark native via; unset leaves Seedance/Seedream on fal. */
    ARK_API_KEY?: string;
    ARK_BASE_URL?: string;
    BYTEPLUS_ACCESS_KEY?: string;
    BYTEPLUS_SECRET_KEY?: string;
    BYTEPLUS_ASSET_GROUP_ID?: string;
    BYTEPLUS_ASSET_SLOTS?: string;
    BYTEPLUS_OPENAPI_HOST?: string;
    /** ElevenLabs native via (voices, dialogue, music). */
    ELEVENLABS_API_KEY?: string;
    ELEVENLABS_BASE_URL?: string;
    /** Seed Audio voices and dialogue (#1765). */
    SEED_SPEECH_API_KEY?: string;
    SEED_SPEECH_BASE_URL?: string;
    SEED_SPEECH_QPM?: string;
    /** Lifts modelschemas.com off its anonymous rate limit. */
    MODELSCHEMAS_API_KEY?: string;
    /** Served at /.well-known/openai-apps-challenge (#2138). */
    OPENAI_APPS_CHALLENGE?: string;
    /** Storage CDN domain; unset means the worker's `/r2/$` route serves. */
    R2_PUBLIC_STORAGE_DOMAIN?: string;
    /** Plugin-directory reviewer sign-in (#2149). */
    REVIEW_LOGIN_EMAIL?: string;
    REVIEW_LOGIN_CODE?: string;

    /** BytePlus governor rates; defaults apply when unset. */
    BYTEPLUS_ASSET_WRITE_QPM?: string;
    BYTEPLUS_OPENAPI_QPM?: string;
    /** Where abuse reports are emailed. Unset means queue-only. */
    ABUSE_REPORT_NOTIFY_EMAIL?: string;
    /** Better Auth's base URL (read by Better Auth itself). */
    BETTER_AUTH_URL?: string;

    // ── Not in the push catalog: per deploy, per laptop, or test hooks ──
    /** `'true'` on PR-preview deploys. */
    VITE_IS_PREVIEW?: string;
    /** aimock base URLs for the native vias and OpenRouter in e2e. */
    XAI_BASE_URL?: string;
    GEMINI_BASE_URL?: string;
    OPENROUTER_BASE_URL?: string;
    /** `'1'` while recording e2e fixtures against the real providers. */
    E2E_RECORD?: string;
    /** `'true'` when e2e runs real workflows instead of mock trigger ids. */
    E2E_FULL_PIPELINE?: string;
    /** Local-dev export renderer (`bun dev:bunny`), never set in prod. */
    VIDEO_EXPORT_DEV_URL?: string;
    VIDEO_EXPORT_DEV_MEDIA_ORIGIN?: string;
  }
}
