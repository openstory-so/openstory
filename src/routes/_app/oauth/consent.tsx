/**
 * /oauth/consent — approve an app's request for access (#1456).
 *
 * The OAuth provider redirects here with the client's signed authorization
 * query once the user is signed in. The page shows who is asking and for
 * what, and hands the decision back to the provider, which sends the browser
 * on to the app's `redirect_uri`.
 */

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  decideOAuthConsentFn,
  getOAuthConsentContextFn,
} from '@/functions/oauth-consent';
import { requireSessionOrRedirect } from '@/lib/auth/route-guards';
import { errorMessage } from '@/lib/errors';
import { useMutation, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

const CONSENT_STALE_MESSAGE =
  'This request is no longer valid. Start again from the app.';

// Display fields only. `.passthrough()` keeps `sig` / `exp` / `ba_*` / PKCE
// on the URL so Approve can echo the provider's signed query. Better Auth's
// own client reads `window.location.search` for the same reason — TanStack's
// `searchStr` is a re-serialized parse and can drop or rewrite those params.
const searchSchema = z
  .object({
    client_id: z.string().optional(),
    scope: z.string().optional(),
    redirect_uri: z.string().optional(),
  })
  .passthrough();

export const Route = createFileRoute('/_app/oauth/consent')({
  validateSearch: searchSchema,
  beforeLoad: async ({ context: { queryClient }, location }) => {
    await requireSessionOrRedirect(queryClient, location.href);
  },
  component: ConsentPage,
  staticData: { breadcrumb: 'Authorize app' },
});

function ConsentPage() {
  const { client_id, scope, redirect_uri } = Route.useSearch();

  return (
    <div className="mx-auto w-full max-w-md p-6">
      <Card>
        <CardHeader>
          <CardTitle>Authorize app</CardTitle>
          <CardDescription>
            An app wants to use your OpenStory account. Only approve requests
            you started yourself.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {client_id ? (
            <Suspense fallback={<Skeleton className="h-40 w-full" />}>
              <ConsentDecision
                clientId={client_id}
                scope={scope ?? ''}
                redirectUri={redirect_uri}
              />
            </Suspense>
          ) : (
            <p role="alert">
              This page is missing its authorization request. Start again from
              the app that sent you here.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ConsentDecision({
  clientId,
  scope,
  redirectUri,
}: {
  clientId: string;
  scope: string;
  redirectUri: string | undefined;
}) {
  const { data } = useSuspenseQuery({
    queryKey: ['oauthConsent', clientId, scope, redirectUri],
    queryFn: () =>
      getOAuthConsentContextFn({
        data: { clientId, scope, redirectUri },
      }),
  });

  const decide = useMutation({
    mutationFn: (accept: boolean) =>
      decideOAuthConsentFn({
        data: { accept, oauthQuery: window.location.search },
      }),
    onSuccess: ({ url }) => {
      if (!url || (!/^https?:\/\//i.test(url) && !url.startsWith('/'))) {
        toast.error(CONSENT_STALE_MESSAGE);
        return;
      }
      window.location.assign(url);
    },
    onError: (err) => {
      const text = errorMessage(err, CONSENT_STALE_MESSAGE).trim();
      toast.error(text || CONSENT_STALE_MESSAGE);
    },
  });

  if (!data.client) {
    return (
      <p role="alert">
        This app isn’t registered with OpenStory, or its registration has
        expired. Start again from the app.
      </p>
    );
  }

  const { client, scopes, team } = data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        {client.logoUri ? (
          <img
            src={client.logoUri}
            alt=""
            width={40}
            height={40}
            className="h-10 w-10 rounded-md object-cover"
          />
        ) : null}
        <div className="flex flex-col">
          <span className="font-semibold">{client.name}</span>
          {client.redirectOrigin ? (
            <span className="text-sm text-muted-foreground">
              Sends you back to{' '}
              <code className="font-mono">{client.redirectOrigin}</code>
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-sm">
          This will let it, on behalf of team <strong>{team.name}</strong>:
        </p>
        <ul className="list-disc pl-5 text-sm">
          {scopes.length > 0 ? (
            scopes.map((s) => <li key={s.id}>{s.description}</li>)
          ) : (
            <li>Confirm who you are</li>
          )}
        </ul>
      </div>

      <p className="text-sm text-muted-foreground">
        Anything it generates spends this team’s credits. You can revoke access
        any time under Settings → Developer.
      </p>

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          disabled={decide.isPending}
          onClick={() => decide.mutate(false)}
        >
          Deny
        </Button>
        <Button disabled={decide.isPending} onClick={() => decide.mutate(true)}>
          {decide.isPending ? 'Working…' : 'Approve'}
        </Button>
      </div>
    </div>
  );
}
