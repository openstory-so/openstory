import { describe, expect, test } from 'vitest';
import {
  buildInstanceId,
  getEnvironmentSlug,
} from '@/lib/workflow/instance-id';

describe('getEnvironmentSlug', () => {
  test('returns "local" when VITE_APP_URL is unset', () => {
    expect(getEnvironmentSlug({})).toBe('local');
    expect(getEnvironmentSlug({ VITE_APP_URL: '' })).toBe('local');
  });

  test('slugifies a production hostname', () => {
    expect(getEnvironmentSlug({ VITE_APP_URL: 'https://openstory.so' })).toBe(
      'openstory-so'
    );
  });

  test('slugifies a PR-preview hostname so prod and preview do not collide', () => {
    const prod = getEnvironmentSlug({
      VITE_APP_URL: 'https://openstory.so',
    });
    const preview = getEnvironmentSlug({
      VITE_APP_URL: 'https://pr-123.openstory.dev',
    });
    expect(prod).not.toBe(preview);
    expect(preview).toBe('pr-123-openstory-dev');
  });

  test('falls back to "local" when VITE_APP_URL is not a valid URL', () => {
    expect(getEnvironmentSlug({ VITE_APP_URL: 'not a url' })).toBe('local');
  });
});

describe('buildInstanceId', () => {
  // CF enforces ^[a-zA-Z0-9_-]+$ on instance IDs — no colons or dots.
  const CF_VALID = /^[a-zA-Z0-9_-]+$/;

  test('composes envSlug + workflowName + suffix with underscore separators', () => {
    expect(
      buildInstanceId({
        env: { VITE_APP_URL: 'https://openstory.so' },
        workflowName: 'image',
        suffix: 'seq-123-shot-7',
      })
    ).toBe('openstory-so_image_seq-123-shot-7');
  });

  test('every generated ID matches CFs ^[a-zA-Z0-9_-]+$ rule', () => {
    const id = buildInstanceId({
      env: { VITE_APP_URL: 'https://pr-42.openstory.dev' },
      workflowName: 'analyze-script',
      suffix: '01KS23834FEGDBN8074VVPR3Q8:shot:7',
    });
    expect(id).toMatch(CF_VALID);
  });

  test('PR preview gets a distinct ID from production for the same suffix', () => {
    const prod = buildInstanceId({
      env: { VITE_APP_URL: 'https://openstory.so' },
      workflowName: 'image',
      suffix: 'seq-123-shot-7',
    });
    const preview = buildInstanceId({
      env: { VITE_APP_URL: 'https://pr-123.openstory.dev' },
      workflowName: 'image',
      suffix: 'seq-123-shot-7',
    });
    expect(prod).not.toBe(preview);
  });

  test('strips unsafe characters from the suffix (colons / spaces / asterisks)', () => {
    expect(
      buildInstanceId({
        env: { VITE_APP_URL: 'https://openstory.so' },
        workflowName: 'image',
        suffix: 'seq 123 / shot*7:variant.0',
      })
    ).toBe('openstory-so_image_seq-123-shot-7-variant-0');
  });

  test('truncates suffix to keep ID under 100 chars', () => {
    const id = buildInstanceId({
      env: { VITE_APP_URL: 'https://openstory.so' },
      workflowName: 'image',
      suffix: 'x'.repeat(200),
    });
    expect(id.length).toBeLessThanOrEqual(100);
    expect(id.startsWith('openstory-so_image_')).toBe(true);
  });

  // #1149: a dead instance must not pin its dedup key forever, so the trigger
  // walks generations. Generation 1 has to stay byte-identical to the untagged
  // id or every in-flight instance would be orphaned by the deploy.
  test('generation 1 is the bare id (no tag)', () => {
    const args = {
      env: { VITE_APP_URL: 'https://openstory.so' },
      workflowName: 'image',
      suffix: 'preview-h4sh-shot7',
    };
    expect(buildInstanceId({ ...args, generation: 1 })).toBe(
      buildInstanceId(args)
    );
  });

  test('later generations append _g<n>', () => {
    const args = {
      env: { VITE_APP_URL: 'https://openstory.so' },
      workflowName: 'image',
      suffix: 'preview-h4sh-shot7',
    };
    expect(buildInstanceId({ ...args, generation: 2 })).toBe(
      'openstory-so_image_preview-h4sh-shot7_g2'
    );
    expect(buildInstanceId({ ...args, generation: 3 })).toBe(
      'openstory-so_image_preview-h4sh-shot7_g3'
    );
  });

  // The tag is reserved for BEFORE the suffix is truncated. Appending it after
  // a naive `slice(0, room)` would push the id over 100 chars — and clamping
  // afterwards would shear the tag off, collapsing generation 2 onto
  // generation 1's id and re-creating the tombstone this fixes.
  test('a truncated suffix still yields a distinct, in-limit tagged id', () => {
    const args = {
      env: { VITE_APP_URL: 'https://openstory.so' },
      workflowName: 'image',
      suffix: 'x'.repeat(200),
    };
    const gen1 = buildInstanceId(args);
    const gen2 = buildInstanceId({ ...args, generation: 2 });

    expect(gen2.length).toBeLessThanOrEqual(100);
    expect(gen2).not.toBe(gen1);
    expect(gen2.endsWith('_g2')).toBe(true);
  });

  test('throws when prefix alone exceeds the 100-char limit', () => {
    expect(() =>
      buildInstanceId({
        env: { VITE_APP_URL: `https://${'x'.repeat(120)}.example.com` },
        workflowName: 'image',
        suffix: 'shot-7',
      })
    ).toThrow(/exceeds the 100-char limit/);
  });
});
