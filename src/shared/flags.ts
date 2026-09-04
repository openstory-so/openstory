/**
 * Build-time feature flags. `import.meta.env.*` is define-replaced by Vite in
 * every target (client, SSR, workerd), so disabled branches are dead-code
 * eliminated from production bundles.
 */

/**
 * #458 direct model access — the /models catalog, run-any-model form, and
 * generated-asset server fns. Defaults ON in dev builds (set
 * VITE_MODELS_ENABLED=false to force off) and OFF in production builds
 * (set VITE_MODELS_ENABLED=true as a build env var to launch).
 */
export const MODELS_ENABLED = import.meta.env.DEV
  ? import.meta.env.VITE_MODELS_ENABLED !== 'false'
  : import.meta.env.VITE_MODELS_ENABLED === 'true';

/** Server-fn guard: the routes 404 when the flag is off, but the fns must not be callable directly either. */
export function assertModelsEnabled(): void {
  if (!MODELS_ENABLED) {
    throw new Error('Direct model access is not enabled');
  }
}
