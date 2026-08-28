/**
 * Tests for the transient-error classifiers added for issue #839 (June 6
 * mass-abort cascade). Message strings mirror what Cloudflare emitted in
 * production logs — the thrown values' classes aren't part of CF's public
 * API, so matching is message-based and these fixtures are the contract.
 */

import { describe, expect, test } from 'vitest';
import {
  isEngineAbortError,
  isInstanceAlreadyExistsError,
  isRecipientInFiniteStateError,
} from './errors';

describe('isEngineAbortError', () => {
  test('matches the exact prod engine-abort message', () => {
    expect(
      isEngineAbortError(new Error('Aborting engine: Grace period complete'))
    ).toBe(true);
  });

  test('matches when wrapped in a child-failure message', () => {
    expect(
      isEngineAbortError(
        new Error(
          'Child workflow analyze-script:01SEQ failed: Aborting engine: Grace period complete'
        )
      )
    ).toBe(true);
  });

  test('matches plain strings', () => {
    expect(isEngineAbortError('Aborting engine: Grace period complete')).toBe(
      true
    );
  });

  test('matches the deploy-time Durable Object reset (#1331)', () => {
    expect(
      isEngineAbortError(
        new Error('Durable Object reset because its code was updated.')
      )
    ).toBe(true);
    // ElementSheet aggregates per-entry rejections into one message; the
    // reset phrase must still classify when it is buried in that summary.
    expect(
      isEngineAbortError(
        new Error(
          'Element reference generation failed for 1/1 element(s) — lantern: Durable Object reset because its code was updated.'
        )
      )
    ).toBe(true);
  });

  test('does not match unrelated errors that mention a grace period', () => {
    // A true positive skips onFailure and parent notification, so a bare
    // "grace period" token from another layer must never classify as an
    // engine abort.
    expect(
      isEngineAbortError(new Error('subscription grace period expired'))
    ).toBe(false);
    expect(
      isEngineAbortError(new Error('grace period: 30 days remaining'))
    ).toBe(false);
    expect(isEngineAbortError(new Error('password reset failed'))).toBe(false);
  });

  test('does not match ordinary failures', () => {
    expect(isEngineAbortError(new Error('fal request failed: 500'))).toBe(
      false
    );
    expect(
      isEngineAbortError(
        new Error('WorkflowTimeoutError: Execution timed out after 1800000ms')
      )
    ).toBe(false);
    expect(isEngineAbortError(null)).toBe(false);
    expect(isEngineAbortError(undefined)).toBe(false);
    expect(isEngineAbortError(42)).toBe(false);
  });
});

describe('isInstanceAlreadyExistsError', () => {
  test('matches the exact prod already_exists message', () => {
    expect(
      isInstanceAlreadyExistsError(
        new Error('(instance.already_exists) Instance already exists')
      )
    ).toBe(true);
  });

  test('matches when wrapped in a child-failure message', () => {
    expect(
      isInstanceAlreadyExistsError(
        new Error(
          'Child workflow image:01SEQ failed: (instance.already_exists) Instance already exists'
        )
      )
    ).toBe(true);
  });

  test('matches plain strings', () => {
    expect(isInstanceAlreadyExistsError('Instance already exists')).toBe(true);
  });

  test('does not match unrelated "already exists" errors from other layers', () => {
    // Swallowing one of these as a successful trigger would mask a real
    // failure — the matcher is anchored on the `instance` token.
    expect(isInstanceAlreadyExistsError(new Error('user already exists'))).toBe(
      false
    );
    expect(
      isInstanceAlreadyExistsError(new Error('bucket already exists'))
    ).toBe(false);
    expect(
      isInstanceAlreadyExistsError(new Error('table shots already exists'))
    ).toBe(false);
  });

  test('does not match ordinary failures', () => {
    expect(isInstanceAlreadyExistsError(new Error('network down'))).toBe(false);
    expect(isInstanceAlreadyExistsError(new Error('instance not found'))).toBe(
      false
    );
    expect(isInstanceAlreadyExistsError(null)).toBe(false);
    expect(isInstanceAlreadyExistsError(undefined)).toBe(false);
    expect(isInstanceAlreadyExistsError(42)).toBe(false);
  });
});

describe('isRecipientInFiniteStateError', () => {
  test('matches the exact prod in_finite_state message', () => {
    expect(
      isRecipientInFiniteStateError(
        new Error(
          '(instance.in_finite_state) Instance reached a finite state, cannot send events to it'
        )
      )
    ).toBe(true);
  });

  test('matches the NonRetryableError re-wrap (message preserved)', () => {
    // await-child's sendEventFailFast re-throws with the original message.
    expect(
      isRecipientInFiniteStateError(
        new Error('Instance reached a finite state, cannot send events to it')
      )
    ).toBe(true);
  });

  test('does not match ordinary failures', () => {
    expect(isRecipientInFiniteStateError(new Error('network down'))).toBe(
      false
    );
    expect(
      isRecipientInFiniteStateError(
        new Error('Aborting engine: Grace period complete')
      )
    ).toBe(false);
    expect(isRecipientInFiniteStateError(null)).toBe(false);
  });
});
