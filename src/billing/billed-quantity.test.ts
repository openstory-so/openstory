import { describe, expect, it } from 'vitest';
import { billedFields, readBilledUsage } from './billed-quantity';

describe('readBilledUsage', () => {
  it('reads the quantity and unit fal reports', () => {
    expect(readBilledUsage({ billed: { quantity: 5, unit: 'units' } })).toEqual(
      {
        status: 'reported',
        quantity: 5,
        unit: 'units',
      }
    );
  });

  it('is absent when the provider billed only in tokens', () => {
    expect(readBilledUsage({ promptTokens: 10 })).toEqual({ status: 'absent' });
    expect(readBilledUsage(undefined)).toEqual({ status: 'absent' });
    expect(readBilledUsage({ billed: undefined })).toEqual({
      status: 'absent',
    });
  });

  it('is malformed when billed is present but not a quantity and a unit', () => {
    expect(readBilledUsage({ unitsBilled: 5 })).toEqual({ status: 'absent' });
    expect(readBilledUsage({ billed: 5 })).toEqual({ status: 'malformed' });
    expect(readBilledUsage({ billed: { units: 5 } })).toEqual({
      status: 'malformed',
    });
    expect(
      readBilledUsage({ billed: { quantity: Number.NaN, unit: 'units' } })
    ).toEqual({ status: 'malformed' });
    expect(readBilledUsage({ billed: { quantity: 5, unit: '' } })).toEqual({
      status: 'malformed',
    });
  });
});

describe('billedFields', () => {
  it('keeps the count and the unit together', () => {
    expect(billedFields({ billed: { quantity: 8, unit: 'seconds' } })).toEqual({
      unitsBilled: 8,
      billedUnit: 'seconds',
    });
  });

  it('names a bad shape so the charge can say why it is zero', () => {
    expect(billedFields({ billed: { units: 5 } }).missingUnitsReason).toBe(
      'usage.billed did not match { quantity, unit }'
    );
  });
});
