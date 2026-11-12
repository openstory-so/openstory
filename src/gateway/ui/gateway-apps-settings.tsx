/**
 * Settings → Developer → Apps: the organization's registered gateway apps
 * (docs/architecture/model-gateway.md § Apps and user-pays). Registering
 * creates a public PKCE client, or links one the signed-in user created.
 * Each app shows its margin, its SKUs and its earnings (read-only).
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
  archiveGatewayAppSkuFn,
  listGatewayAppsFn,
  registerGatewayAppFn,
  saveGatewayAppSkuFn,
  setGatewayAppMarginFn,
  type GatewayAppDetails,
} from '@/gateway/apps.fn';
import {
  APP_SKU_KEY_PATTERN,
  MAX_APP_MARGIN_BPS,
  MAX_APP_SKU_PRICE_MICROS,
  formatMarginBps,
} from '@/gateway/apps';
import { EARNING_HOLD_DAYS } from '@/billing/charge-lines';
import { micros, microsToDisplayUsd, usdToMicros } from '@/billing/money';
import { errorMessage } from '@/platform/errors';
import { Archive } from 'lucide-react';
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

const usd = (value: number) => microsToDisplayUsd(micros(value));

const marginFormSchema = z.object({
  marginPercent: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, 'Enter a percent with up to two decimals')
    .transform((value) => Math.round(Number(value) * 100))
    .refine((bps) => bps <= MAX_APP_MARGIN_BPS, {
      message: `At most ${formatMarginBps(MAX_APP_MARGIN_BPS)}`,
    }),
});

const skuFormSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(
      APP_SKU_KEY_PATTERN,
      'Key: lowercase letters, digits, _ and -, up to 64'
    ),
  name: z.string().trim().min(1, 'Name the SKU').max(100),
  priceUsd: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/, 'Enter a price in dollars')
    .transform((value) => usdToMicros(Number(value)))
    .refine((price) => price > 0 && price <= MAX_APP_SKU_PRICE_MICROS, {
      message: `A price above $0 and at most ${usd(MAX_APP_SKU_PRICE_MICROS)}`,
    }),
});

function useInvalidateApps() {
  const queryClient = useQueryClient();
  return () =>
    void queryClient.invalidateQueries({ queryKey: GATEWAY_APPS_QUERY_KEY });
}

function AppRow({ app }: { app: GatewayAppDetails }) {
  return (
    <li className="flex flex-col gap-4 rounded-md border p-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-medium">{app.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            Client ID <code className="font-mono">{app.oauthClientId}</code>
          </span>
        </div>
        <Badge variant={app.status === 'active' ? 'secondary' : 'destructive'}>
          {app.status === 'active' ? 'Active' : 'Suspended'}
        </Badge>
      </div>
      <MarginForm app={app} />
      <AppSkus app={app} />
      <AppEarnings app={app} />
    </li>
  );
}

function MarginForm({ app }: { app: GatewayAppDetails }) {
  const id = useId();
  const invalidate = useInvalidateApps();
  const save = useMutation({
    mutationFn: (marginBps: number) =>
      setGatewayAppMarginFn({ data: { appId: app.id, marginBps } }),
    onSuccess: (_result, marginBps) =>
      toast.success(`Margin set to ${formatMarginBps(marginBps)}`),
    onError: (err) => toast.error(errorMessage(err, 'Failed to save margin')),
    onSettled: invalidate,
  });
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = marginFormSchema.safeParse(
      Object.fromEntries(new FormData(event.currentTarget))
    );
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the margin');
      return;
    }
    save.mutate(parsed.data.marginPercent);
  };
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-margin`}>Margin (%)</Label>
          <Input
            key={app.marginBps}
            id={`${id}-margin`}
            name="marginPercent"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            className="w-32 text-base"
            defaultValue={String(app.marginBps / 100)}
            aria-describedby={`${id}-margin-hint`}
            required
          />
        </div>
        <Button type="submit" variant="outline" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save margin'}
        </Button>
      </div>
      <p id={`${id}-margin-hint`} className="text-sm text-muted-foreground">
        Added on top of model costs when a user runs models through this app,
        paid to this organization. Up to {formatMarginBps(MAX_APP_MARGIN_BPS)}.
        Lowering it applies at once; raising it applies to each user only once
        they approve it again.
      </p>
    </form>
  );
}

function AppSkus({ app }: { app: GatewayAppDetails }) {
  const id = useId();
  const invalidate = useInvalidateApps();
  const save = useMutation({
    mutationFn: (sku: { key: string; name: string; priceMicros: number }) =>
      saveGatewayAppSkuFn({ data: { appId: app.id, ...sku } }),
    onSuccess: (_result, sku) => toast.success(`Saved ${sku.name}`),
    onError: (err) => toast.error(errorMessage(err, 'Failed to save SKU')),
    onSettled: invalidate,
  });
  const archive = useMutation({
    mutationFn: (key: string) =>
      archiveGatewayAppSkuFn({ data: { appId: app.id, key } }),
    onSuccess: (_result, key) => toast.success(`Archived ${key}`),
    onError: (err) => toast.error(errorMessage(err, 'Failed to archive SKU')),
    onSettled: invalidate,
  });
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const parsed = skuFormSchema.safeParse(
      Object.fromEntries(new FormData(form))
    );
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the SKU');
      return;
    }
    const { key, name, priceUsd } = parsed.data;
    save.mutate(
      { key, name, priceMicros: priceUsd },
      { onSuccess: () => form.reset() }
    );
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">SKUs</span>
      {app.skus.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No SKUs. Declare one to charge users for it with POST
          /api/v1/gateway/charges.
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {app.skus.map((sku) => (
            <li
              key={sku.key}
              className="flex items-center justify-between gap-2"
            >
              <span className="min-w-0 truncate">
                <code className="font-mono">{sku.key}</code> · {sku.name}
              </span>
              <span className="flex items-center gap-2 tabular-nums">
                {usd(sku.priceMicros)}
                {sku.status === 'active' ? (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Archive ${sku.key}`}
                        disabled={archive.isPending}
                      >
                        <Archive className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Archive {sku.key}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          The app can no longer charge for it. Offering it again
                          needs every user to approve its price again.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => archive.mutate(sku.key)}
                        >
                          Archive
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : (
                  <Badge variant="outline">Archived</Badge>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-key`}>Key</Label>
          <Input
            id={`${id}-key`}
            name="key"
            autoComplete="off"
            spellCheck={false}
            className="w-36 font-mono text-base"
            maxLength={64}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            name="name"
            autoComplete="off"
            className="w-40 text-base"
            maxLength={100}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-price`}>Price (USD)</Label>
          <Input
            id={`${id}-price`}
            name="priceUsd"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            className="w-28 text-base"
            required
          />
        </div>
        <Button type="submit" variant="outline" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save SKU'}
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        Saving an existing key changes its name or price. A user is charged a
        SKU only at a price they approved: a raised price, or a new SKU, waits
        for them to approve it again.
      </p>
    </div>
  );
}

function AppEarnings({ app }: { app: GatewayAppDetails }) {
  const { earnings } = app;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">Earnings</span>
      <dl className="grid grid-cols-2 gap-2 text-sm tabular-nums">
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">Pending</dt>
          <dd>{usd(earnings.pendingMicros)}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">Matured</dt>
          <dd>{usd(earnings.maturedMicros)}</dd>
        </div>
      </dl>
      {earnings.recent.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {earnings.recent.map((row) => (
            <li
              key={row.id}
              className="flex justify-between gap-2 tabular-nums"
            >
              <span className="text-muted-foreground">
                {row.createdAt.toLocaleDateString()}
              </span>
              <span>
                {usd(row.amountMicros)}
                {' · '}
                {row.status === 'pending'
                  ? `available ${row.availableAt.toLocaleDateString()}`
                  : row.status}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Earnings are credits in this organization’s wallet, held{' '}
        {EARNING_HOLD_DAYS} days before they can be spent. They cannot be
        transferred or paid out as cash.
      </p>
    </div>
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
