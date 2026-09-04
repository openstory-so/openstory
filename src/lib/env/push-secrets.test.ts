import { describe, expect, it } from 'vitest';
import {
  SECRETS,
  TOOLING_OR_LEGACY,
  buildPushPayload,
  formatSecretsTable,
  secretAction,
  secretRows,
  type SecretNeed,
} from '../../../scripts/push-secrets';

const catalog: Record<string, SecretNeed> = {
  ADMIN_EMAILS: { runtime: true, build: false },
  VITE_APP_URL: { runtime: true, build: true },
  VITE_R2_PUBLIC_ASSETS_DOMAIN: { runtime: false, build: true },
  LANGFUSE_SECRET_KEY: { runtime: false, build: false },
};

describe('secretAction', () => {
  const runtime: SecretNeed = { runtime: true, build: false };

  it('reports update when a runtime secret is in Doppler and on the Worker', () => {
    expect(secretAction(runtime, true, true)).toBe('update');
  });

  it('reports CREATE when a runtime secret is in Doppler but not on the Worker', () => {
    expect(secretAction(runtime, true, false)).toBe('CREATE');
  });

  it('reports worker-only when a runtime secret is on the Worker but not in Doppler', () => {
    expect(secretAction(runtime, false, true)).toBe(
      'worker-only (not in Doppler)'
    );
  });

  it('reports MISSING when a runtime secret is in neither store', () => {
    expect(secretAction(runtime, false, false)).toBe('MISSING');
  });

  it('reports build-only regardless of Doppler/Worker presence', () => {
    const build: SecretNeed = { runtime: false, build: true };
    expect(secretAction(build, true, true)).toBe(
      'build-only - set in Workers Builds'
    );
    expect(secretAction(build, false, false)).toBe(
      'build-only - set in Workers Builds'
    );
  });

  it('reports unused regardless of Doppler/Worker presence', () => {
    const unused: SecretNeed = { runtime: false, build: false };
    expect(secretAction(unused, true, true)).toBe('unused - nothing reads it');
    expect(secretAction(unused, false, false)).toBe(
      'unused - nothing reads it'
    );
  });

  it('still pushes dual runtime+build secrets (action is the push verb)', () => {
    const both: SecretNeed = { runtime: true, build: true };
    expect(secretAction(both, true, true)).toBe('update');
    expect(secretAction(both, true, false)).toBe('CREATE');
  });
});

describe('buildPushPayload', () => {
  it('includes only runtime secrets with a non-empty Doppler value', () => {
    const payload = buildPushPayload(catalog, {
      ADMIN_EMAILS: 'a@example.com',
      VITE_APP_URL: 'https://openstory.so',
      VITE_R2_PUBLIC_ASSETS_DOMAIN: 'assets.openstory.so',
      LANGFUSE_SECRET_KEY: 'lf-secret',
    });
    expect(payload).toEqual({
      ADMIN_EMAILS: 'a@example.com',
      VITE_APP_URL: 'https://openstory.so',
    });
  });

  it('never emits build-only, unused, empty, or missing keys', () => {
    const payload = buildPushPayload(catalog, {
      ADMIN_EMAILS: '',
      VITE_R2_PUBLIC_ASSETS_DOMAIN: 'assets.openstory.so',
      LANGFUSE_SECRET_KEY: 'lf-secret',
    });
    expect(payload).toEqual({});
  });

  it('never serializes nulls so wrangler cannot delete', () => {
    const payload = buildPushPayload(SECRETS, {
      FAL_KEY: 'fal-key',
      VITE_R2_PUBLIC_ASSETS_DOMAIN: 'assets.openstory.so',
      LANGFUSE_SECRET_KEY: 'lf-secret',
      R2_PUBLIC_ASSETS_DOMAIN: 'assets.openstory.so',
    });
    const parsed: unknown = JSON.parse(JSON.stringify(payload));
    expect(parsed).toEqual({ FAL_KEY: 'fal-key' });
    expect(JSON.stringify(payload)).not.toContain(':null');
  });
});

describe('SECRETS catalog (#1502)', () => {
  it('classifies VITE_R2_PUBLIC_ASSETS_DOMAIN as build-only', () => {
    expect(SECRETS.VITE_R2_PUBLIC_ASSETS_DOMAIN).toEqual({
      runtime: false,
      build: true,
    });
  });

  it('classifies LANGFUSE_* and R2_PUBLIC_ASSETS_DOMAIN as unused', () => {
    expect(SECRETS.LANGFUSE_BASE_URL).toEqual({ runtime: false, build: false });
    expect(SECRETS.LANGFUSE_PROMPTS_ENABLED).toEqual({
      runtime: false,
      build: false,
    });
    expect(SECRETS.LANGFUSE_PUBLIC_KEY).toEqual({
      runtime: false,
      build: false,
    });
    expect(SECRETS.LANGFUSE_SECRET_KEY).toEqual({
      runtime: false,
      build: false,
    });
    expect(SECRETS.R2_PUBLIC_ASSETS_DOMAIN).toEqual({
      runtime: false,
      build: false,
    });
  });

  it('keeps FAL_PRICING_KEY in tooling/legacy, not the catalog', () => {
    expect('FAL_PRICING_KEY' in SECRETS).toBe(false);
    expect(TOOLING_OR_LEGACY.has('FAL_PRICING_KEY')).toBe(true);
  });

  it('keeps LLMTR_API_KEY in tooling/legacy — team BYOK, never a Worker secret', () => {
    expect('LLMTR_API_KEY' in SECRETS).toBe(false);
    expect(TOOLING_OR_LEGACY.has('LLMTR_API_KEY')).toBe(true);
  });

  it('classifies VITE_APP_* and PostHog as both runtime and build', () => {
    expect(SECRETS.VITE_APP_NAME).toEqual({ runtime: true, build: true });
    expect(SECRETS.VITE_APP_URL).toEqual({ runtime: true, build: true });
    expect(SECRETS.VITE_PUBLIC_POSTHOG_HOST).toEqual({
      runtime: true,
      build: true,
    });
    expect(SECRETS.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN).toEqual({
      runtime: true,
      build: true,
    });
  });
});

describe('formatSecretsTable', () => {
  it('prints runtime / build / doppler / worker columns and an action', () => {
    const table = formatSecretsTable(
      secretRows(
        catalog,
        new Set(['ADMIN_EMAILS', 'VITE_APP_URL', 'LANGFUSE_SECRET_KEY']),
        new Set([
          'ADMIN_EMAILS',
          'VITE_APP_URL',
          'VITE_R2_PUBLIC_ASSETS_DOMAIN',
        ])
      )
    );
    expect(table).toContain('SECRET');
    expect(table).toContain('runtime');
    expect(table).toContain('build');
    expect(table).toContain('doppler');
    expect(table).toContain('worker');
    expect(table).toContain('action');
    expect(table).toContain('update');
    expect(table).toContain('build-only - set in Workers Builds');
    expect(table).toContain('unused - nothing reads it');
  });
});
