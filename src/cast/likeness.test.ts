import { describe, expect, it } from 'vitest';
import { isPersonFromTalentCast, registersWithArk } from './likeness';

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

describe('isPersonFromTalentCast', () => {
  it('is a person when the talent has a signed release', () => {
    expect(isPersonFromTalentCast(true, true)).toBe(true);
    expect(isPersonFromTalentCast(false, true)).toBe(true);
  });

  it('keeps the bible value when the talent is unsigned', () => {
    expect(isPersonFromTalentCast(true, false)).toBe(true);
    expect(isPersonFromTalentCast(false, false)).toBe(false);
    expect(isPersonFromTalentCast(true, undefined)).toBe(true);
  });
});
