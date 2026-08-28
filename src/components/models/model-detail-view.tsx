/**
 * Model detail page body (#458): header, schema-driven parameter form, run →
 * poll → result loop, and the team's recent runs of this endpoint.
 *
 * The page itself is anonymous-browsable (schema + form render for everyone);
 * pressing Run goes through `useAuthGate().requireAuth`, the same login-dialog
 * gate every other action uses. The server re-validates the input against the
 * live schema — its per-field messages flow back into `<SchemaForm errors>`.
 */

import { useAuthGate } from '@/components/auth/auth-gate-provider';
import {
  ACTIVITY_ICONS,
  ACTIVITY_LABELS,
  categoryLabel,
} from '@/components/models/model-card';
import { AssetResult } from '@/components/schema-form/asset-result';
import { SchemaForm } from '@/components/schema-form/schema-form';
import {
  issuesToFieldErrors,
  seedFormValue,
} from '@/components/schema-form/widget-plan';
import { AppImage } from '@/components/ui/app-image';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  createGeneratedAssetFn,
  getGeneratedAssetFn,
  listGeneratedAssetsFn,
} from '@/functions/model-assets';
import { getModelDetailFn, getModelFamilyFn } from '@/functions/model-catalog';
import { BILLING_BALANCE_KEY } from '@/hooks/use-billing-balance';
import { useFalBillingGate } from '@/hooks/use-billing-gate';
import { isInsufficientCreditsError } from '@/lib/errors';
import type { GeneratedAsset } from '@/lib/db/schema';
import {
  CATALOG_ACTIVITIES,
  type CatalogActivity,
  type JsonValue,
  type ModelDetail,
} from '@/lib/models/catalog';
import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { AlertCircle, ExternalLink, SearchX, Sparkles } from 'lucide-react';
import type { FC } from 'react';
import { Suspense, useState } from 'react';

// ---------------------------------------------------------------------------
// Detail fetch (with activity fallback when the search param is absent)
// ---------------------------------------------------------------------------

/**
 * `getModelDetail` throws CatalogApiError(404, 'unknown_schema') when the
 * endpoint has no input schema. CatalogApiError extends OpenStoryError, so
 * the serialization adapter (#1087/#1099) delivers `code`/`statusCode` here —
 * match on those, never message prose. A modelschemas outage is 5xx and will
 * not match.
 */
function isNoSchemaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { statusCode, code } = error as {
    statusCode?: unknown;
    code?: unknown;
  };
  return statusCode === 404 && code === 'unknown_schema';
}

/**
 * Fetch the model detail; without an `activity` search param each catalog
 * activity is tried in turn (a deep link may omit it). Returns null when no
 * activity has a schema for this endpoint — the friendly no-schema state.
 */
async function fetchModelDetail(
  endpointId: string,
  activity: CatalogActivity | undefined
): Promise<ModelDetail | null> {
  const candidates = activity ? [activity] : [...CATALOG_ACTIVITIES];
  for (const candidate of candidates) {
    try {
      return await getModelDetailFn({
        data: { endpointId, activity: candidate },
      });
    } catch (error) {
      if (!isNoSchemaError(error)) throw error;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run mutation error handling
// ---------------------------------------------------------------------------

/**
 * A non-terminal run past the workflow's absolute budget (30 min) plus slack
 * is dead — the cron reconciler flips it to 'failed' out-of-band, so the
 * client stops burning a poll on it.
 */
const STALLED_RUN_CUTOFF_MS = 45 * 60 * 1000;

function isStalled(
  asset: Pick<GeneratedAsset, 'status' | 'updatedAt'>
): boolean {
  return (
    (asset.status === 'queued' || asset.status === 'running') &&
    Date.now() - asset.updatedAt.getTime() > STALLED_RUN_CUTOFF_MS
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

const DetailSkeleton: FC = () => (
  <div className="flex flex-col gap-8">
    <div className="flex flex-col gap-3">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-96" />
    </div>
    <div className="grid gap-8 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-2/3" />
      </div>
      <Skeleton className="aspect-video w-full rounded-lg" />
    </div>
  </div>
);

export const ModelDetailView: FC<{
  endpointId: string;
  activity: CatalogActivity | undefined;
}> = ({ endpointId, activity }) => (
  <Suspense fallback={<DetailSkeleton />}>
    <ModelDetailContent endpointId={endpointId} activity={activity} />
  </Suspense>
);

const ModelDetailContent: FC<{
  endpointId: string;
  activity: CatalogActivity | undefined;
}> = ({ endpointId, activity }) => {
  const { data: detail } = useSuspenseQuery({
    queryKey: ['model-detail', endpointId, activity ?? 'auto'],
    queryFn: () => fetchModelDetail(endpointId, activity),
    staleTime: 30 * 60 * 1000,
  });

  if (!detail) {
    return (
      <EmptyState
        icon={<SearchX className="h-12 w-12" />}
        title="No schema available"
        description={`We couldn't find a parameter schema for “${endpointId}”. It may be new, renamed, or not runnable directly.`}
      />
    );
  }

  return <ModelRunPanel key={detail.model.endpointId} detail={detail} />;
};

const ModelRunPanel: FC<{ detail: ModelDetail }> = ({ detail }) => {
  const { model, inputSchema } = detail;
  const queryClient = useQueryClient();
  const { requireAuth, isAuthenticated } = useAuthGate();
  const { showGate: showBillingGate } = useFalBillingGate();

  const [values, setValues] = useState<Record<string, JsonValue>>(() =>
    seedFormValue(inputSchema)
  );
  const [activeAssetId, setActiveAssetId] = useState<string>();

  const runMutation = useMutation({
    mutationFn: (input: Record<string, JsonValue>) =>
      createGeneratedAssetFn({
        data: {
          endpointId: model.endpointId,
          activity: model.activity,
          modelName: model.displayName,
          input,
        },
      }),
    onSuccess: (result) => {
      // `ok: false` is a validation failure — the issues render inline via
      // `fieldErrors` below; there is no run to show.
      if (!result.ok) return;
      setActiveAssetId(result.id);
      void queryClient.invalidateQueries({
        queryKey: ['generated-assets', model.endpointId],
      });
    },
    onError: (error) => {
      if (isInsufficientCreditsError(error)) {
        showBillingGate('insufficient');
        void queryClient.invalidateQueries({ queryKey: BILLING_BALANCE_KEY });
      }
    },
  });

  // The one in-flight/most recent run, polled until it settles. Polling
  // stops on fetch errors (the error panel renders instead — silently
  // spinning forever helps nobody) and on runs past the workflow's absolute
  // budget, which the cron reconciler flips to 'failed' out-of-band.
  const { data: activeAsset, error: activeAssetError } = useQuery({
    queryKey: ['generated-asset', activeAssetId],
    queryFn: activeAssetId
      ? () => getGeneratedAssetFn({ data: { id: activeAssetId } })
      : skipToken,
    refetchInterval: (query) => {
      if (query.state.error) return false;
      const asset = query.state.data;
      if (!asset) return 1500;
      if (asset.status === 'completed' || asset.status === 'failed') {
        return false;
      }
      return isStalled(asset) ? false : 1500;
    },
  });

  const runResult = runMutation.data;
  const fieldErrors =
    runResult && !runResult.ok
      ? issuesToFieldErrors(runResult.issues)
      : undefined;
  const generalError =
    fieldErrors?.[''] ??
    (runMutation.error && !isInsufficientCreditsError(runMutation.error)
      ? runMutation.error.message
      : undefined);

  const handleSubmit = () => {
    if (!requireAuth()) return;
    runMutation.mutate(values);
  };

  const Icon = ACTIVITY_ICONS[model.activity];

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {model.displayName}
          </h1>
          <Badge variant="secondary">
            <Icon aria-hidden="true" />
            {ACTIVITY_LABELS[model.activity]}
          </Badge>
          {model.category && (
            <Badge variant="outline">{categoryLabel(model.category)}</Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          <VariantSwitcher model={model} />
          <a
            href={`https://fal.ai/models/${model.endpointId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            View on fal.ai
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        </div>
      </header>

      <div className="grid gap-10 lg:grid-cols-2">
        <section aria-label="Parameters" className="flex flex-col gap-4">
          <h2 className="text-sm font-medium text-muted-foreground">
            Parameters
          </h2>
          <SchemaForm
            schema={inputSchema}
            value={values}
            onChange={setValues}
            onSubmit={handleSubmit}
            disabled={runMutation.isPending}
            errors={fieldErrors}
          >
            {generalError && (
              <p role="alert" className="text-sm text-destructive">
                {generalError}
              </p>
            )}
            <Button
              type="submit"
              disabled={runMutation.isPending}
              className="w-fit"
            >
              <Sparkles aria-hidden="true" />
              {runMutation.isPending ? 'Starting…' : 'Run'}
            </Button>
          </SchemaForm>
        </section>

        <section aria-label="Result" className="flex flex-col gap-4">
          <h2 className="text-sm font-medium text-muted-foreground">Result</h2>
          {activeAssetError ? (
            <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed">
              <p role="alert" className="text-sm text-destructive">
                Couldn't load the run status — check Recent runs below, or run
                again.
              </p>
            </div>
          ) : activeAsset ? (
            <AssetResult asset={activeAsset} />
          ) : (
            <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed">
              <p className="text-sm text-muted-foreground">
                Run the model to see the result here.
              </p>
            </div>
          )}
        </section>
      </div>

      {isAuthenticated && (
        <section aria-label="Recent runs" className="flex flex-col gap-4">
          <h2 className="text-sm font-medium text-muted-foreground">
            Recent runs
          </h2>
          <Suspense
            fallback={
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="aspect-square rounded-lg" />
                ))}
              </div>
            }
          >
            <RecentRuns
              endpointId={model.endpointId}
              activeAssetId={activeAssetId}
              onSelect={setActiveAssetId}
            />
          </Suspense>
        </section>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Variant switcher
// ---------------------------------------------------------------------------

/**
 * The endpoint-id line of the header. When the endpoint's family (see
 * model-families.ts) has siblings, it becomes a select that navigates to the
 * chosen variant; otherwise (single variant, family still loading, or lookup
 * failure) it stays a static code element — progressive enhancement, the page
 * never blocks on it.
 */
const VariantSwitcher: FC<{ model: ModelDetail['model'] }> = ({ model }) => {
  const navigate = useNavigate();
  const { data: family } = useQuery({
    queryKey: ['model-family', model.endpointId, model.activity],
    queryFn: () =>
      getModelFamilyFn({
        data: { endpointId: model.endpointId, activity: model.activity },
      }),
    staleTime: 5 * 60 * 1000,
  });

  const variants = family?.variants ?? [];
  if (variants.length <= 1) {
    return <code className="font-mono text-xs">{model.endpointId}</code>;
  }

  // Variants arrive sorted newest-version-first; group them for the listbox.
  const versionGroups = new Map<string, typeof variants>();
  for (const variant of variants) {
    const version = variant.version ?? 'other';
    versionGroups.set(version, [
      ...(versionGroups.get(version) ?? []),
      variant,
    ]);
  }
  const showVersionLabels = versionGroups.size > 1;

  return (
    <Select
      value={model.endpointId}
      onValueChange={(endpointId) =>
        void navigate({
          to: '/models/$',
          params: { _splat: endpointId },
          search: { activity: model.activity },
        })
      }
    >
      <SelectTrigger size="sm" aria-label="Switch variant" className="w-fit">
        <SelectValue>
          <code className="font-mono text-xs">{model.endpointId}</code>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {[...versionGroups.entries()].map(([version, group]) => (
          <SelectGroup key={version}>
            {showVersionLabels && <SelectLabel>{version}</SelectLabel>}
            {group.map((variant) => (
              <SelectItem key={variant.endpointId} value={variant.endpointId}>
                <span className="flex min-w-0 flex-col items-start">
                  <span className="truncate">
                    {variant.variantLabel || variant.displayName}
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {variant.endpointId}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
};

// ---------------------------------------------------------------------------
// Recent runs strip
// ---------------------------------------------------------------------------

const RunThumbnail: FC<{ asset: GeneratedAsset }> = ({ asset }) => {
  if (asset.status === 'failed') {
    return (
      <AlertCircle aria-hidden="true" className="size-6 text-destructive" />
    );
  }
  if (asset.status !== 'completed') {
    return (
      <span className="text-xs text-muted-foreground" aria-hidden="true">
        {asset.status === 'queued' ? 'Queued…' : 'Running…'}
      </span>
    );
  }
  const first = asset.outputs?.[0];
  if (first?.contentType.startsWith('image/')) {
    return (
      <AppImage
        src={first.url}
        alt=""
        width={200}
        height={200}
        className="size-full object-cover"
      />
    );
  }
  if (first?.contentType.startsWith('video/')) {
    return (
      <video
        src={first.url}
        muted
        playsInline
        preload="metadata"
        className="size-full object-cover"
      />
    );
  }
  const Icon = ACTIVITY_ICONS[asset.activity];
  return <Icon aria-hidden="true" className="size-6 text-muted-foreground" />;
};

const RecentRuns: FC<{
  endpointId: string;
  activeAssetId: string | undefined;
  onSelect: (id: string) => void;
}> = ({ endpointId, activeAssetId, onSelect }) => {
  // Self-polls while any listed run is still in flight, so rows settle into
  // their thumbnails without the panel having to orchestrate invalidations.
  // Stops on refetch errors and ignores stalled rows (see `isStalled`) so a
  // stranded run can't keep every visit to this page polling forever.
  const { data } = useSuspenseQuery({
    queryKey: ['generated-assets', endpointId],
    queryFn: () => listGeneratedAssetsFn({ data: { endpointId, limit: 12 } }),
    refetchInterval: (query) => {
      if (query.state.error) return false;
      return query.state.data?.assets.some(
        (asset) =>
          (asset.status === 'queued' || asset.status === 'running') &&
          !isStalled(asset)
      )
        ? 3000
        : false;
    },
  });

  if (data.assets.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No runs of this model yet.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
      {data.assets.map((asset) => (
        <button
          key={asset.id}
          type="button"
          aria-label={`View run from ${asset.createdAt.toLocaleString()}`}
          aria-pressed={asset.id === activeAssetId}
          onClick={() => onSelect(asset.id)}
          className={`flex aspect-square items-center justify-center overflow-hidden rounded-lg border bg-muted transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            asset.id === activeAssetId ? 'border-primary' : ''
          }`}
        >
          <RunThumbnail asset={asset} />
        </button>
      ))}
    </div>
  );
};
