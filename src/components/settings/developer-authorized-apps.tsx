/**
 * Authorized apps — OAuth grants the user has approved (#1456): hosted MCP
 * clients, forks, anything that ran "login with OpenStory". Revoking deletes
 * the grant and its refresh tokens; the app has to ask again.
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
} from '@/components/ui/alert-dialog';
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
  listAuthorizedAppsFn,
  revokeAuthorizedAppFn,
  type AuthorizedApp,
} from '@/functions/oauth-consent';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { ShieldCheck, Trash2 } from 'lucide-react';
import { Suspense } from 'react';
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
    <li className="flex items-center justify-between gap-4 rounded-md border p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-medium">{app.client.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {app.client.redirectOrigin ?? app.client.clientId}
          {' · '}
          approved {app.createdAt.toLocaleDateString()}
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
    </li>
  );
}
