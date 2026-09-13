import { describe, expect, it } from 'vitest';
import { EXPECTED_REJECTION_CODES } from './middleware.fn';

describe('EXPECTED_REJECTION_CODES', () => {
  it('warns on user-completable 4xx outcomes, not faults', () => {
    expect(EXPECTED_REJECTION_CODES.has('INSUFFICIENT_CREDITS')).toBe(true);
    expect(EXPECTED_REJECTION_CODES.has('VALIDATION_ERROR')).toBe(true);
    expect(EXPECTED_REJECTION_CODES.has('NOT_FOUND')).toBe(true);
    expect(EXPECTED_REJECTION_CODES.has('ATTESTATION_REQUIRED')).toBe(true);
    expect(EXPECTED_REJECTION_CODES.has('WELCOME_CARD_ALREADY_CLAIMED')).toBe(
      true
    );
  });
});
