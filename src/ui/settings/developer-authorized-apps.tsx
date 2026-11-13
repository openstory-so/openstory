/**
 * Authorized apps — OAuth grants the user has approved (#1456): hosted MCP
 * clients, forks, anything that ran "login with OpenStory". Revoking deletes
 * the grant, its spend cap and its refresh tokens; the app has to ask again.
 * An app with `models:invoke` shows its monthly cap and this month's spend,
 * and asks the user to accept a margin or SKU price the app has raised.
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/ui/shadcn/alert-dialog';
import { Button } from '@/ui/shadcn/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/ui/shadcn/card';
import { Skeleton } from '@/ui/shadcn/skeleton';
import {
  acceptAuthorizedAppTermsFn,
  listAuthorizedAppsFn,
  revokeAuthorizedAppFn,
  setAuthorizedAppCapFn,
  type AuthorizedApp,
} from '@/platform/oauth-consent.fn';
import {
  formatMarginBps,
  termsNeedApproval,
  termsOfView,
} from '@/gateway/apps';
import {
  MAX_MONTHLY_CAP_USD,
  MIN_MONTHLY_CAP_USD,
  monthlyCapMicrosSchema,
  monthlyCapUsdToMicros,
} from '@/platform/auth/oauth-spend-cap';
import { micros, microsToDisplayUsd } from '@/billing/money';
import { errorMessage } from '@/platform/errors';
import { Input } from '@/ui/shadcn/input';
import { Label } from '@/ui/shadcn/label';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { ShieldCheck, Trash2 } from 'lucide-react';
import { Suspense, useId, type FormEvent } from 'react';
import { toast } from 'sonner';

const AUTHORIZED_APPS_QUERY_KEY = ['authorizedApps'] as const;

export function DeveloperAuthorizedApps() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
            <ShieldCheck className="h-5 w-5 text-primary" />
          </div>
          <div>
            <CardTitle>Authorized apps</CardTitle>
            <CardDescription>
              Apps and agents you have signed in to with your OpenStory account.
              Revoke one and it has to ask again.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Suspense fallback={<AppListSkeleton />}>
          <AppList />
        </Suspense>
      </CardContent>
    </Card>
  );
}

function AppListSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  );
}

function AppList() {
  const { data: apps } = useSuspenseQuery({
    queryKey: AUTHORIZED_APPS_QUERY_KEY,
    queryFn: () => listAuthorizedAppsFn(),
  });

  if (apps.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No apps have access yet. When an MCP client or another app asks to sign
        in with OpenStory, it will show up here.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {apps.map((app) => (
        <AppRow key={app.consentId} app={app} />
      ))}
    </ul>
  );
}

function AppRow({ app }: { app: AuthorizedApp }) {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () =>
      revokeAuthorizedAppFn({
        data: { consentId: app.consentId, clientId: app.client.clientId },
      }),
    onSuccess: () => {
      toast.success(`Revoked access for ${app.client.name}`);
      void queryClient.invalidateQueries({
        queryKey: AUTHORIZED_APPS_QUERY_KEY,
      });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to revoke'),
  });

  return (
    <li className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-medium">{app.client.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {app.client.redirectOrigin ?? app.client.clientId}
            {' · '}
            approved {app.createdAt.toLocaleDateString()}
            {app.organization ? (
              <span>{` · bills ${app.organization.name}`}</span>
            ) : null}
          </span>
          <span className="text-xs text-muted-foreground">
            {app.scopes.map((s) => s.description).join(' · ')}
          </span>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Revoke access for ${app.client.name}`}
              disabled={revoke.isPending}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke {app.client.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                It will not be able to get new tokens and has to ask you to sign
                in again. An access token already issued can keep working for up
                to an hour.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => revoke.mutate()}>
                Revoke
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {app.invokesModels && app.organization ? <SpendCap app={app} /> : null}
      {app.invokesModels && app.organization ? <AppTerms app={app} /> : null}
    </li>
  );
}

const usd = (value: number) => microsToDisplayUsd(micros(value));

/** The monthly cap, this month's spend and what remains, with a cap editor. */
function SpendCap({ app }: { app: AuthorizedApp }) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const { grant } = app;
  const setCap = useMutation({
    mutationFn: (monthlyCapMicros: number) =>
      setAuthorizedAppCapFn({
        data: { consentId: app.consentId, monthlyCapMicros },
      }),
    onMutate: async (monthlyCapMicros) => {
      await queryClient.cancelQueries({ queryKey: AUTHORIZED_APPS_QUERY_KEY });
      const previous = queryClient.getQueryData<AuthorizedApp[]>(
        AUTHORIZED_APPS_QUERY_KEY
      );
      queryClient.setQueryData<AuthorizedApp[]>(
        AUTHORIZED_APPS_QUERY_KEY,
        (apps) =>
          apps?.map((row) =>
            row.consentId === app.consentId && row.grant
              ? {
                  ...row,
                  grant: {
                    ...row.grant,
                    monthlyCapMicros,
                    remainingMicros: Math.max(
                      0,
                      monthlyCapMicros -
                        row.grant.spentMicros -
                        row.grant.heldMicros
                    ),
                  },
                }
              : row
          )
      );
      return { previous };
    },
    onError: (err, _cap, context) => {
      if (context?.previous) {
        queryClient.setQueryData(AUTHORIZED_APPS_QUERY_KEY, context.previous);
      }
      toast.error(errorMessage(err, 'Failed to change the cap'));
    },
    onSuccess: () => toast.success(`Spend cap updated for ${app.client.name}`),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: AUTHORIZED_APPS_QUERY_KEY,
      }),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('monthlyCapUsd');
    const raw = typeof value === 'string' ? value.trim() : '';
    const parsed = monthlyCapMicrosSchema.safeParse(
      /^\d+$/.test(raw) ? monthlyCapUsdToMicros(Number(raw)) : Number.NaN
    );
    if (!parsed.success) {
      toast.error(
        `Enter whole dollars from $${MIN_MONTHLY_CAP_USD} to $${MAX_MONTHLY_CAP_USD}.`
      );
      return;
    }
    setCap.mutate(parsed.data);
  };

  return (
    <div className="flex flex-col gap-2">
      {grant ? (
        <dl className="grid grid-cols-3 gap-2 text-sm tabular-nums">
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Monthly cap</dt>
            <dd>{usd(grant.monthlyCapMicros)}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Spent this month</dt>
            <dd>{usd(grant.spentMicros)}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Remaining</dt>
            <dd>{usd(grant.remainingMicros)}</dd>
          </div>
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">
          No spend cap yet, so this app cannot run models. Set one to let it
          spend up to that amount per calendar month (UTC).
        </p>
      )}
      <form onSubmit={onSubmit} className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={inputId}>Monthly cap (USD)</Label>
          <Input
            key={grant?.monthlyCapMicros ?? 'none'}
            id={inputId}
            name="monthlyCapUsd"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            className="w-32 text-base"
            defaultValue={
              grant ? String(grant.monthlyCapMicros / 1_000_000) : ''
            }
            required
          />
        </div>
        <Button type="submit" variant="outline" disabled={setCap.isPending}>
          {setCap.isPending ? 'Saving…' : grant ? 'Change cap' : 'Set cap'}
        </Button>
      </form>
    </div>
  );
}

/** The app's margin and SKU prices, and an accept when it asks for more than the user approved. */
function AppTerms({ app }: { app: AuthorizedApp }) {
  const queryClient = useQueryClient();
  const accept = useMutation({
    mutationFn: () =>
      acceptAuthorizedAppTermsFn({
        data: {
          consentId: app.consentId,
          shownTerms: termsOfView(app.appTerms),
        },
      }),
    onSuccess: () =>
      toast.success(`Accepted new prices for ${app.client.name}`),
    onError: (err) => toast.error(errorMessage(err, 'Failed to accept')),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: AUTHORIZED_APPS_QUERY_KEY,
      }),
  });
  const { appTerms, accepted } = app;
  if (!appTerms || !accepted) return null;
  if (appTerms.ownerOrganizationId === app.organization?.id) return null;
  const current = termsOfView(appTerms);
  if (current.marginBps === 0 && appTerms.skus.length === 0) return null;
  const needsApproval = termsNeedApproval(current, accepted);
  const marginRaised = current.marginBps > accepted.marginBps;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <dl className="flex flex-col gap-1 tabular-nums">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">
            Margin on model costs, paid to {appTerms.ownerOrganizationName}
          </dt>
          <dd>
            {marginRaised
              ? `${formatMarginBps(accepted.marginBps)} approved, now asks ${formatMarginBps(current.marginBps)}`
              : formatMarginBps(
                  Math.min(current.marginBps, accepted.marginBps)
                )}
          </dd>
        </div>
        {appTerms.skus.map((sku) => {
          const ok = accepted.skuPrices[sku.key];
          const price = usd(sku.priceMicros);
          return (
            <div key={sku.key} className="flex justify-between gap-2">
              <dt className="text-muted-foreground">{sku.name}</dt>
              <dd>
                {ok === undefined
                  ? `not approved, asks ${price}`
                  : sku.priceMicros > ok
                    ? `${usd(ok)} approved, now asks ${price}`
                    : price}
              </dd>
            </div>
          );
        })}
      </dl>
      {needsApproval ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-muted-foreground">
            Until you accept, it adds only the margin you approved and cannot
            charge a new or raised price.
          </p>
          <Button
            variant="outline"
            disabled={accept.isPending}
            onClick={() => accept.mutate()}
          >
            {accept.isPending ? 'Accepting…' : 'Accept new prices'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
