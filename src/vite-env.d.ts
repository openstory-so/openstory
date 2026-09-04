/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_NAME: string | undefined;
  readonly VITE_APP_URL: string | undefined;
  readonly VITE_R2_PUBLIC_ASSETS_DOMAIN: string | undefined;
  readonly VITE_MODELS_ENABLED: string | undefined;
  /** Per-worktree Better Auth cookie prefix. Set only by `vite serve`. */
  readonly VITE_AUTH_COOKIE_PREFIX: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
