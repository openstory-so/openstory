import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/ui/shadcn/breadcrumb';
import { cn } from '@/ui/utils';
import type { AnyRouteMatch } from '@tanstack/react-router';
import { Link, useMatches } from '@tanstack/react-router';
import { Fragment } from 'react';

export type BreadcrumbCrumb = {
  label: React.ReactNode;
  to?: string;
  /** Search params for `to`, e.g. a list's filter to return to. */
  search?: Record<string, unknown>;
  /**
   * A phone shows one crumb. That is the current page unless an ancestor
   * names the thing better than the page does ("Scenes" says less than the
   * sequence title), in which case the ancestor sets this. A deeper page
   * with a name of its own (a character under that sequence) sets it too,
   * and the deepest wins.
   */
  keepOnMobile?: true;
};

// Subset of AnyRouteMatch that breadcrumb resolution actually needs. Defined
// structurally so AnyRouteMatch is assignable to it (production passes the
// full match) and tests can build minimal fixtures without an unsafe cast.
export type BreadcrumbMatch = {
  id: string;
  pathname: string;
  params: AnyRouteMatch['params'];
  staticData: AnyRouteMatch['staticData'];
};

export type BreadcrumbValue =
  | string
  | BreadcrumbCrumb
  | BreadcrumbCrumb[]
  | ((
      match: BreadcrumbMatch
    ) => string | BreadcrumbCrumb | BreadcrumbCrumb[] | null | undefined);

// See https://tanstack.com/router/latest/docs/guide/static-route-data#enforcing-static-data
declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    breadcrumb?: BreadcrumbValue;
  }
}

// `BreadcrumbMatch.params` is typed as `any`. TanStack guarantees the shape
// matches the file-route path segments, so breadcrumb callers can narrow it
// via this helper instead of casting inline (which trips
// `no-unsafe-type-assertion`).
export function routeParams<T>(match: BreadcrumbMatch): T {
  const params: T = match.params;
  return params;
}

export function resolveCrumbs(match: BreadcrumbMatch): BreadcrumbCrumb[] {
  const raw = match.staticData.breadcrumb;
  if (!raw) return [];

  const resolved = typeof raw === 'function' ? raw(match) : raw;
  if (!resolved) return [];

  if (typeof resolved === 'string') {
    return [{ label: resolved, to: match.pathname }];
  }
  if (Array.isArray(resolved)) return resolved;
  return [resolved];
}

/**
 * The one crumb a phone shows: the deepest that asks (`keepOnMobile`), else
 * the current page.
 */
export function mobileCrumbIndex(crumbs: BreadcrumbCrumb[]): number {
  const kept = crumbs.map((crumb) => crumb.keepOnMobile).lastIndexOf(true);
  return kept === -1 ? crumbs.length - 1 : kept;
}

export const Breadcrumbs: React.FC = () => {
  const matches = useMatches();
  const crumbs = matches.flatMap(resolveCrumbs);

  if (crumbs.length === 0) return null;
  const mobileIndex = mobileCrumbIndex(crumbs);

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          // shadcn sidebar-07: one crumb on small screens. Long titles
          // line-clamp instead of wrapping the header (which stretched the
          // vertical separator).
          const hideOnMobile = i !== mobileIndex;
          const labelText =
            typeof crumb.label === 'string' ? crumb.label : undefined;
          return (
            <Fragment
              key={`${i}-${typeof crumb.label === 'string' ? crumb.label : ''}`}
            >
              <BreadcrumbItem
                className={cn(hideOnMobile && 'hidden md:block', 'min-w-0')}
              >
                {isLast || !crumb.to ? (
                  <BreadcrumbPage className="line-clamp-1" title={labelText}>
                    {crumb.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild className="line-clamp-1">
                    <Link to={crumb.to} search={crumb.search} title={labelText}>
                      {crumb.label}
                    </Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!isLast && <BreadcrumbSeparator className="hidden md:block" />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
};
