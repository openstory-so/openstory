import { describe, expect, test } from 'vitest';
import {
  mobileCrumbIndex,
  resolveCrumbs,
  type BreadcrumbMatch,
  type BreadcrumbValue,
} from './breadcrumbs';

function makeMatch(
  breadcrumb: BreadcrumbValue | undefined,
  overrides: Partial<BreadcrumbMatch> = {}
): BreadcrumbMatch {
  return {
    id: 'match-1',
    pathname: '/sequences',
    params: {},
    staticData: breadcrumb === undefined ? {} : { breadcrumb },
    ...overrides,
  };
}

describe('resolveCrumbs', () => {
  test('returns [] when staticData has no breadcrumb', () => {
    expect(resolveCrumbs(makeMatch(undefined))).toEqual([]);
  });

  test('wraps a string as a single crumb linking to match.pathname', () => {
    const crumbs = resolveCrumbs(makeMatch('Sequences'));
    expect(crumbs).toEqual([{ label: 'Sequences', to: '/sequences' }]);
  });

  test('passes an array through unchanged', () => {
    const value: BreadcrumbValue = [
      { label: 'Sequences', to: '/sequences' },
      { label: 'New sequence' },
    ];
    expect(resolveCrumbs(makeMatch(value))).toEqual(value);
  });

  test('wraps a single object in an array', () => {
    const crumbs = resolveCrumbs(makeMatch({ label: 'Talent' }));
    expect(crumbs).toEqual([{ label: 'Talent' }]);
  });

  test('invokes a function with the match', () => {
    const match = makeMatch(
      (m) => [{ label: 'Seq', to: `/sequences/${String(m.params.id)}` }],
      { params: { id: 'abc' } }
    );
    expect(resolveCrumbs(match)).toEqual([
      { label: 'Seq', to: '/sequences/abc' },
    ]);
  });

  test('treats null/undefined from a function as no crumbs', () => {
    expect(resolveCrumbs(makeMatch(() => null))).toEqual([]);
    expect(resolveCrumbs(makeMatch(() => undefined))).toEqual([]);
  });
});

describe('mobileCrumbIndex', () => {
  test('the current page when no crumb asks', () => {
    expect(mobileCrumbIndex([{ label: 'Sequences' }, { label: 'New' }])).toBe(
      1
    );
  });

  test('an ancestor that asks beats a generic page name', () => {
    expect(
      mobileCrumbIndex([
        { label: 'Sequences' },
        { label: 'Golden Hour Surf', keepOnMobile: true },
        { label: 'Scenes' },
      ])
    ).toBe(1);
  });

  test('the deepest crumb that asks wins', () => {
    expect(
      mobileCrumbIndex([
        { label: 'Sequences' },
        { label: 'Golden Hour Surf', keepOnMobile: true },
        { label: 'John', keepOnMobile: true },
      ])
    ).toBe(2);
  });
});
