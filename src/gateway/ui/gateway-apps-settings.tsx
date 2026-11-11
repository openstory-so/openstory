/**
 * Settings → Developer → Apps: the organization's registered gateway apps
 * (docs/architecture/model-gateway.md § Apps and user-pays). Registering
 * creates a public PKCE client, or links one the signed-in user created.
 */

import { Badge } from '@/ui/shadcn/badge';
import { Button } from '@/ui/shadcn/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/ui/shadcn/card';
import { Input } from '@/ui/shadcn/input';
import { Label } from '@/ui/shadcn/label';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { Textarea } from '@/ui/shadcn/textarea';
import {
  listGatewayAppsFn,
  registerGatewayAppFn,
  type GatewayAppSummary,
} from '@/gateway/apps.fn';
import { errorMessage } from '@/platform/errors';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { Suspense, useId, type FormEvent } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

const GATEWAY_APPS_QUERY_KEY = ['gatewayApps'] as const;

const registerFormSchema = z.object({
  name: z.string().trim().min(1, 'Name the app').max(100),
  clientId: z.string().trim().max(512),
  redirectUris: z.string(),
});

export function GatewayAppsSettings() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Apps</CardTitle>
        <CardDescription>
          Apps this organization publishes. Users sign in to one with OpenStory
          and pay for its model calls from their own credits, up to the monthly
          cap they set.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <Suspense
          fallback={
            <div className="flex flex-col gap-3">
              <Skeleton className="h-14 w-full" />
            </div>
          }
        >
          <AppList />
        </Suspense>
        <RegisterAppForm />
      </CardContent>
    </Card>
  );
}

function AppList() {
  const { data: apps } = useSuspenseQuery({
    queryKey: GATEWAY_APPS_QUERY_KEY,
    queryFn: () => listGatewayAppsFn(),
  });
  if (apps.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No apps registered yet.</p>
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {apps.map((app) => (
        <AppRow key={app.id} app={app} />
      ))}
    </ul>
  );
}

function AppRow({ app }: { app: GatewayAppSummary }) {
  return (
    <li className="flex items-center justify-between gap-4 rounded-md border p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-medium">{app.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          Client ID <code className="font-mono">{app.oauthClientId}</code>
        </span>
      </div>
      <Badge variant={app.status === 'active' ? 'secondary' : 'destructive'}>
        {app.status === 'active' ? 'Active' : 'Suspended'}
      </Badge>
    </li>
  );
}

function RegisterAppForm() {
  const queryClient = useQueryClient();
  const id = useId();
  const register = useMutation({
    mutationFn: (data: {
      name: string;
      clientId?: string;
      redirectUris?: string[];
    }) => registerGatewayAppFn({ data }),
    onSuccess: (app) => {
      toast.success(`Registered ${app.name}`);
      void queryClient.invalidateQueries({ queryKey: GATEWAY_APPS_QUERY_KEY });
    },
    onError: (err) => toast.error(errorMessage(err, 'Failed to register')),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const parsed = registerFormSchema.safeParse(
      Object.fromEntries(new FormData(form))
    );
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the form');
      return;
    }
    const { name, clientId, redirectUris } = parsed.data;
    const uris = redirectUris
      .split(/\s+/)
      .map((uri) => uri.trim())
      .filter(Boolean);
    if (!clientId && uris.length === 0) {
      toast.error('Add a redirect URI, or the client ID of a client you made');
      return;
    }
    register.mutate(
      clientId ? { name, clientId } : { name, redirectUris: uris },
      { onSuccess: () => form.reset() }
    );
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-name`}>App name</Label>
        <Input
          id={`${id}-name`}
          name="name"
          autoComplete="off"
          className="text-base"
          maxLength={100}
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-uris`}>Redirect URIs</Label>
        <Textarea
          id={`${id}-uris`}
          name="redirectUris"
          className="text-base"
          placeholder="https://app.example/callback"
          aria-describedby={`${id}-uris-hint`}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <p id={`${id}-uris-hint`} className="text-sm text-muted-foreground">
          One per line. A public client with PKCE is created for you.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-client`}>Or an existing client ID</Label>
        <Input
          id={`${id}-client`}
          name="clientId"
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-base"
          aria-describedby={`${id}-client-hint`}
        />
        <p id={`${id}-client-hint`} className="text-sm text-muted-foreground">
          Only a client you created yourself. Leave empty to create one.
        </p>
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={register.isPending}>
          {register.isPending ? 'Registering…' : 'Register app'}
        </Button>
      </div>
    </form>
  );
}
