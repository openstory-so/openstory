import { describe, expect, it } from 'vitest';
import { isPersonFromUploadLedger, registersWithArk } from './likeness';

describe('registersWithArk', () => {
  it('registers a person, and a missing value on in-flight payloads', () => {
    expect(registersWithArk(true)).toBe(true);
    expect(registersWithArk(undefined)).toBe(true);
    expect(registersWithArk(null)).toBe(true);
  });

  it('does not register a non-person sheet', () => {
    expect(registersWithArk(false)).toBe(false);
  });
});

describe('isPersonFromUploadLedger', () => {
  it('is a person when the ledger is a signed portrait', () => {
    expect(isPersonFromUploadLedger(true, 'real')).toBe(true);
    expect(isPersonFromUploadLedger(false, 'real')).toBe(true);
  });

  it('keeps the bible value when the ledger is cleared or missing', () => {
    expect(isPersonFromUploadLedger(true, 'none')).toBe(true);
    expect(isPersonFromUploadLedger(false, 'none')).toBe(false);
    expect(isPersonFromUploadLedger(true, null)).toBe(true);
    expect(isPersonFromUploadLedger(false, undefined)).toBe(false);
  });
});
