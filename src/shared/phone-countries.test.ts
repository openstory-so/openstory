import { describe, expect, it } from 'vitest';
import { composePhoneNumber, phoneCountries } from './phone-countries';

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
      [...list.map((c) => c.name)].sort((a, b) => a.localeCompare(b))
    );
  });

  it('composes E.164 and drops the trunk zero', () => {
    expect(composePhoneNumber('61', '0412 345 678')).toBe('+61412345678');
    expect(composePhoneNumber('1', '(555) 123-4567')).toBe('+15551234567');
  });
});
