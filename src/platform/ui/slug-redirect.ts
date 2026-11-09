import type { QueryClient } from '@tanstack/react-query';
import type { ParsedLocation } from '@tanstack/react-router';
import { notFound, redirect } from '@tanstack/react-router';
import { isValidId } from '@/platform/id';
import { resolveSlugFn, type SluggedKind } from '@/platform/slug.fn';
import { requireSessionOrRedirect } from '@/platform/ui/auth/route-guards';

/**
 * A slug in `${prefix}/<param>` redirects to the same URL with the ULID; a
 * ULID passes (#2222).
 */
export async function redirectSlugToId(params: {
  kind: SluggedKind;
  prefix: string;
  param: string;
  location: ParsedLocation;
  queryClient: QueryClient;
}): Promise<void> {
  const { kind, prefix, param, location, queryClient } = params;
  if (isValidId(param)) return;
  await requireSessionOrRedirect(queryClient, location.href);
  const id = await resolveSlugFn({ data: { kind, slug: param } });
  if (!id) throw notFound();
  throw redirect({
    // A resolved slug is [a-z0-9-], so it appears in the href as it is.
    href: location.href.replace(`${prefix}/${param}`, `${prefix}/${id}`),
    replace: true,
  });
}
