/**
 * /oauth/consent — approve an app's request for access (#1456).
 *
 * Better Auth sends the signed query to `/oauth/consent-start`, which packs it
 * into `q` and 302s here so TanStack cannot collapse repeated `ba_param`.
 *
 * Who is asking, for what, and which team the grant bills to load in the
 * route loader so the first HTML already has Approve — no client fetch, no
 * skeleton.
 */

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  decideOAuthConsentFn,
  getOAuthConsentContextFn,
  type OAuthConsentContext,
} from '@/functions/oauth-consent';
import {
  consentPageHref,
  displayFieldsFromOAuthQuery,
  needsOAuthQueryPack,
  pickOAuthQuery,
  resolveOAuthQuery,
} from '@/shared/auth/oauth-query-snapshot';
import { requireSessionOrRedirect } from '@/shared/auth/route-guards';
import { errorMessage } from '@/shared/errors';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

const CONSENT_STALE_MESSAGE =
  'This request is no longer valid. Start again from the app.';

declare global {
  interface Window {
    __OPENSTORY_OAUTH_QUERY__?: string;
  }
}

/**
 * Prefer the incoming request URL (server) or a head-script snapshot (client)
 * over TanStack's parsed `location.search`. Packed `q` is immune to qss;
 * this still covers a stray hit on `/oauth/consent` with the raw signed query.
 */
const readConsentOAuthQuery = createIsomorphicFn()
  .server(() => new URL(getRequest().url).search)
  .client(() => window.__OPENSTORY_OAUTH_QUERY__ || window.location.search);

export const Route = createFileRoute('/_app/oauth/consent')({
  head: () => ({
    scripts: [
      {
        children:
          'window.__OPENSTORY_OAUTH_QUERY__=window.__OPENSTORY_OAUTH_QUERY__||window.location.search',
      },
    ],
  }),
  // One-shot signed request — don't background-refetch after SSR.
  staleTime: Infinity,
  loader: async () => {
    const oauthQuery = resolveOAuthQuery(readConsentOAuthQuery());
    const { clientId, scope, redirectUri } =
      displayFieldsFromOAuthQuery(oauthQuery);
    const consent: OAuthConsentContext | null = clientId
      ? await getOAuthConsentContextFn({
          data: { clientId, scope, redirectUri },
        })
      : null;
    return { oauthQuery, consent };
  },
  beforeLoad: async ({ context: { queryClient } }) => {
    const rawSearch = readConsentOAuthQuery();
    const href = consentPageHref(rawSearch);
    if (needsOAuthQueryPack(rawSearch)) {
      throw redirect({ href });
    }
    await requireSessionOrRedirect(queryClient, href);
  },
  component: ConsentPage,
  staticData: { breadcrumb: 'Authorize app' },
});

function ConsentPage() {
  const { oauthQuery: loaderQuery, consent } = Route.useLoaderData();
  const oauthQuery = pickOAuthQuery([
    resolveOAuthQuery(loaderQuery),
    typeof window !== 'undefined'
      ? resolveOAuthQuery(
          window.__OPENSTORY_OAUTH_QUERY__ || window.location.search
        )
      : undefined,
  ]);

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
          {consent ? (
            <ConsentDecision consent={consent} oauthQuery={oauthQuery} />
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
  consent,
  oauthQuery,
}: {
  consent: OAuthConsentContext;
  oauthQuery: string;
}) {
  const [outcome, setOutcome] = useState<'granted' | 'denied' | null>(null);

  const decide = useMutation({
    // Suppress the global MutationCache toast — we render our own below.
    meta: { inlineError: true },
    mutationFn: (accept: boolean) =>
      decideOAuthConsentFn({
        data: { accept, oauthQuery },
      }),
    onSuccess: ({ url }, accept) => {
      if (!url || (!/^https?:\/\//i.test(url) && !url.startsWith('/'))) {
        toast.error(CONSENT_STALE_MESSAGE);
        return;
      }
      setOutcome(accept ? 'granted' : 'denied');
      window.setTimeout(() => {
        window.location.assign(url);
      }, 800);
    },
    onError: (err) => {
      const text = errorMessage(err, CONSENT_STALE_MESSAGE).trim();
      toast.error(text || CONSENT_STALE_MESSAGE);
    },
  });

  if (!consent.client) {
    return (
      <p role="alert">
        This app isn’t registered with OpenStory, or its registration has
        expired. Start again from the app.
      </p>
    );
  }

  if (outcome) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Check className="h-5 w-5" aria-hidden />
          <p className="font-semibold">
            {outcome === 'granted' ? 'Access granted' : 'Request denied'}
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          You can close this tab. Sending you back to the app…
        </p>
      </div>
    );
  }

  const { client, scopes, team } = consent;

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
