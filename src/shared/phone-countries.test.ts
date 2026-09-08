import { describe, expect, it } from 'vitest';
import { phoneCountries, splitDialCode } from './phone-countries';

describe('phone countries', () => {
  it('names and flags every dial code, sorted by name', () => {
    const list = phoneCountries();
    expect(list.length).toBeGreaterThan(200);
    const au = list.find((c) => c.iso === 'AU');
    expect(au).toEqual({
      iso: 'AU',
      dialCode: '61',
      name: 'Australia',
      flag: '🇦🇺',
    });
    expect(list.map((c) => c.name)).toEqual(
      list.map((c) => c.name).sort((a, b) => a.localeCompare(b))
    );
  });

  it('splits a typed +number into country and the rest', () => {
    expect(splitDialCode('+61 412', 'GB')).toEqual({
      iso: 'AU',
      dialCode: '61',
      national: '412',
    });
    expect(splitDialCode('+1684 5', 'US')?.iso).toBe('AS');
    expect(splitDialCode('+1 555', 'GB')?.iso).toBe('US');
    expect(splitDialCode('+1 555', 'CA')?.iso).toBe('CA');
    expect(splitDialCode('0412', 'AU')).toBeNull();
    expect(splitDialCode('+', 'AU')).toBeNull();
  });
});
