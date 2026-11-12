/** The consent arithmetic: what is applied, what approving records, and when to ask again. */

import { describe, expect, it } from 'vitest';
import {
  appliedMarginBps,
  boundedTerms,
  formatMarginBps,
  termsNeedApproval,
  termsOfView,
} from './apps';

describe('appliedMarginBps', () => {
  it('is the lower of the app margin and the accepted one', () => {
    expect(appliedMarginBps(2000, 2000)).toBe(2000);
    // Lowered by the app: applies at once.
    expect(appliedMarginBps(1000, 2000)).toBe(1000);
    // Raised by the app: the user still pays what they accepted.
    expect(appliedMarginBps(3000, 2000)).toBe(2000);
    // A grant from before margins accepted nothing.
    expect(appliedMarginBps(2000, 0)).toBe(0);
  });
});

describe('boundedTerms', () => {
  const current = {
    marginBps: 2000,
    skuPrices: { hd: 500_000, pack: 2_000_000 },
  };

  it('records no more than was shown and no more than the app asks now', () => {
    expect(
      boundedTerms(
        { marginBps: 5000, skuPrices: { hd: 900_000, pack: 1_000_000 } },
        current
      )
    ).toEqual({
      marginBps: 2000,
      skuPrices: { hd: 500_000, pack: 1_000_000 },
    });
  });

  it('accepts only SKUs that were shown and still exist', () => {
    expect(
      boundedTerms(
        { marginBps: 0, skuPrices: { hd: 500_000, gone: 100 } },
        current
      )
    ).toEqual({ marginBps: 0, skuPrices: { hd: 500_000 } });
  });
});

describe('termsNeedApproval', () => {
  const accepted = { marginBps: 1000, skuPrices: { hd: 500_000 } };

  it('asks again for a raised margin, a raised price or a new SKU', () => {
    expect(termsNeedApproval(accepted, accepted)).toBe(false);
    expect(
      termsNeedApproval(
        { marginBps: 500, skuPrices: { hd: 400_000 } },
        accepted
      )
    ).toBe(false);
    expect(termsNeedApproval({ ...accepted, marginBps: 1500 }, accepted)).toBe(
      true
    );
    expect(
      termsNeedApproval(
        { marginBps: 1000, skuPrices: { hd: 600_000 } },
        accepted
      )
    ).toBe(true);
    expect(
      termsNeedApproval(
        { marginBps: 1000, skuPrices: { hd: 500_000, pack: 1 } },
        accepted
      )
    ).toBe(true);
  });
});

describe('termsOfView and formatMarginBps', () => {
  it('reads a view as terms and shows basis points as a percent', () => {
    expect(termsOfView(null)).toEqual({ marginBps: 0, skuPrices: {} });
    expect(
      termsOfView({
        appId: 'a',
        appName: 'A',
        ownerOrganizationId: 'o',
        ownerOrganizationName: 'O',
        marginBps: 2050,
        skus: [{ key: 'hd', name: 'HD', priceMicros: 5 }],
      })
    ).toEqual({ marginBps: 2050, skuPrices: { hd: 5 } });
    expect(formatMarginBps(2000)).toBe('20%');
    expect(formatMarginBps(2050)).toBe('20.5%');
    expect(formatMarginBps(5)).toBe('0.05%');
  });
});
