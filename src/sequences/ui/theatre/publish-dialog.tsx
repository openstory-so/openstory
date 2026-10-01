/**
 * Publish to social (#1267). Three steps: pick the profile, platforms and
 * caption; review exactly what will be sent; then follow each platform's
 * outcome. What the review shows is what the server receives — changing
 * anything means going back and reviewing again, and the request id is
 * derived from those same values, so a repeat is found, not re-posted.
 *
 * Once a publish may have gone out, its tracking outlives the dialog: closing
 * and re-opening shows the same request, never a fresh form, until it has
 * definitely finished or failed. A lost reply from our own server counts as
 * "may have gone out" too.
 */

import { Button } from '@/ui/shadcn/button';
import { Checkbox } from '@/ui/shadcn/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/shadcn/dialog';
import { Input } from '@/ui/shadcn/input';
import { Label } from '@/ui/shadcn/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/shadcn/select';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { Textarea } from '@/ui/shadcn/textarea';
import {
  getSocialPublishStatusFn,
  listSocialProfilesFn,
  publishSequenceExportFn,
} from '@/sequences/social-publish.fn';
import {
  captionLimit,
  derivePublishRequestId,
  publishInputSchema,
  socialPlatformLabel,
  SOCIAL_PLATFORMS,
  TIKTOK_PRIVACY,
  TIKTOK_PRIVACY_LABELS,
  YOUTUBE_PRIVACY,
  YOUTUBE_PRIVACY_LABELS,
  type PublishInput,
  type PublishOutcome,
  type PublishStatus,
  type SocialPlatform,
} from '@/sequences/social-publish';
import { usePostHog } from '@posthog/react';
import {
  QueryErrorResetBoundary,
  useMutation,
  useQuery,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { errorMessage } from '@/platform/errors';
import { CatchBoundary } from '@tanstack/react-router';
import { Suspense, useId, useState, useSyncExternalStore } from 'react';

type Tracked = Exclude<PublishOutcome, { state: 'not_sent' }> & {
  startedAt: number;
};

// Publishes that may have gone out, by export id. Page memory, so it survives
// the dialog closing and is shared by both Download menus; a reload drops it,
// and then the server's own lookup finds a repeat of the same post.
const tracked = new Map<string, Tracked>();
const trackedListeners = new Set<() => void>();

function setTracked(exportId: string, value: Tracked | null): void {
  if (value) tracked.set(exportId, value);
  else tracked.delete(exportId);
  for (const listener of trackedListeners) listener();
}

function subscribeTracked(listener: () => void): () => void {
  trackedListeners.add(listener);
  return () => trackedListeners.delete(listener);
}

function useTracked(exportId: string): Tracked | null {
  return useSyncExternalStore(
    subscribeTracked,
    () => tracked.get(exportId) ?? null,
    () => null
  );
}

type PublishDialogProps = {
  onClose: () => void;
  teamId: string;
  sequenceId: string;
  /** The ready render of the current cut. Captured when the dialog opens. */
  exportId: string;
  defaultTitle: string;
};

type Step =
  | { kind: 'form'; draft: PublishInput | null }
  | { kind: 'review'; input: PublishInput };

export function PublishDialog(props: PublishDialogProps) {
  const { onClose, teamId, exportId } = props;
  const current = useTracked(exportId);
  const [step, setStep] = useState<Step>({ kind: 'form', draft: null });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Publish to social</DialogTitle>
          <DialogDescription>
            Post this render to your connected accounts through Upload-Post.
          </DialogDescription>
        </DialogHeader>
        {current ? (
          <PublishTracking
            teamId={teamId}
            tracked={current}
            onClose={onClose}
            onNewPost={() => {
              setStep({ kind: 'form', draft: null });
              setTracked(exportId, null);
            }}
          />
        ) : step.kind === 'review' ? (
          <PublishReview
            teamId={teamId}
            input={step.input}
            onBack={() => setStep({ kind: 'form', draft: step.input })}
            onPublished={(outcome) =>
              setTracked(exportId, { ...outcome, startedAt: Date.now() })
            }
          />
        ) : (
          <QueryErrorResetBoundary>
            {({ reset: resetQueries }) => (
              <CatchBoundary
                getResetKey={() => exportId}
                errorComponent={({ error, reset }) => (
                  <div className="flex flex-col gap-4">
                    <p role="alert" className="text-sm text-destructive">
                      {errorMessage(error)}
                    </p>
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={onClose}>
                        Close
                      </Button>
                      <Button
                        type="button"
                        onClick={() => {
                          resetQueries();
                          reset();
                        }}
                      >
                        Try again
                      </Button>
                    </DialogFooter>
                  </div>
                )}
              >
                <Suspense
                  fallback={
                    <div className="flex flex-col gap-4">
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-24 w-full" />
                      <Skeleton className="h-10 w-full" />
                    </div>
                  }
                >
                  <PublishForm
                    {...props}
                    draft={step.draft}
                    onReview={(input) => setStep({ kind: 'review', input })}
                  />
                </Suspense>
              </CatchBoundary>
            )}
          </QueryErrorResetBoundary>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PublishForm({
  teamId,
  sequenceId,
  exportId,
  defaultTitle,
  draft,
  onReview,
  onClose,
}: PublishDialogProps & {
  draft: PublishInput | null;
  onReview: (input: PublishInput) => void;
}) {
  const id = useId();
  const { data: profiles } = useSuspenseQuery({
    queryKey: ['social-profiles', teamId],
    queryFn: () => listSocialProfilesFn({ data: { teamId } }),
    staleTime: 60_000,
  });
  const [profileName, setProfileName] = useState(
    draft?.profile ??
      (profiles.length === 1 ? (profiles[0]?.username ?? '') : '')
  );
  const [platforms, setPlatforms] = useState<SocialPlatform[]>(
    draft?.platforms ?? []
  );
  const [error, setError] = useState<string | null>(null);
  const profile = profiles.find((p) => p.username === profileName);
  const limit = captionLimit(platforms);

  if (profiles.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          No Upload-Post profiles. Create one at{' '}
          <a
            href="https://app.upload-post.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            app.upload-post.com
          </a>
          .
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </div>
    );
  }

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = publishInputSchema.safeParse({
      sequenceId,
      exportId,
      profile: profileName,
      platforms,
      title: form.get('title'),
      description: form.get('description'),
      youtubePrivacy: form.get('youtubePrivacy'),
      tiktokPrivacy: form.get('tiktokPrivacy'),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form');
      return;
    }
    setError(null);
    onReview(parsed.data);
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label>Upload-Post profile</Label>
        <Select
          value={profileName}
          onValueChange={(value) => {
            setProfileName(value ?? '');
            setPlatforms([]);
          }}
        >
          <SelectTrigger aria-label="Upload-Post profile">
            <SelectValue placeholder="Choose a profile" />
          </SelectTrigger>
          <SelectContent>
            {profiles.map((p) => (
              <SelectItem key={p.username} value={p.username}>
                {p.username}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {profile && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Platforms</legend>
          {profile.platforms.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No accounts connected on this profile.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {SOCIAL_PLATFORMS.filter((p) =>
                profile.platforms.includes(p.id)
              ).map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={platforms.includes(p.id)}
                    onCheckedChange={(checked) =>
                      setPlatforms((current) =>
                        checked === true
                          ? [...current, p.id]
                          : current.filter((id) => id !== p.id)
                      )
                    }
                  />
                  {p.label}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-title`}>Caption</Label>
        <Input
          id={`${id}-title`}
          name="title"
          defaultValue={draft?.title ?? defaultTitle}
          required
          autoComplete="off"
        />
        {limit && (
          <p className="text-xs text-muted-foreground">
            {limit.label}: {limit.max} characters max.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-description`}>Description (optional)</Label>
        <Textarea
          id={`${id}-description`}
          name="description"
          rows={3}
          defaultValue={draft?.description}
        />
        <p className="text-xs text-muted-foreground">
          Used on YouTube, LinkedIn and Facebook.
        </p>
      </div>

      {/* Hidden, not unmounted, so the form always submits both values. */}
      <div
        className={
          platforms.includes('youtube') ? 'flex flex-col gap-2' : 'hidden'
        }
      >
        <Label htmlFor={`${id}-youtube`}>YouTube visibility</Label>
        <Select
          name="youtubePrivacy"
          defaultValue={draft?.youtubePrivacy ?? 'private'}
        >
          <SelectTrigger id={`${id}-youtube`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {YOUTUBE_PRIVACY.map((value) => (
              <SelectItem key={value} value={value}>
                {YOUTUBE_PRIVACY_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div
        className={
          platforms.includes('tiktok') ? 'flex flex-col gap-2' : 'hidden'
        }
      >
        <Label htmlFor={`${id}-tiktok`}>TikTok visibility</Label>
        <Select
          name="tiktokPrivacy"
          defaultValue={draft?.tiktokPrivacy ?? 'account_default'}
        >
          <SelectTrigger id={`${id}-tiktok`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIKTOK_PRIVACY.map((value) => (
              <SelectItem key={value} value={value}>
                {TIKTOK_PRIVACY_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={platforms.length === 0}>
          Review
        </Button>
      </DialogFooter>
    </form>
  );
}

function PublishReview({
  teamId,
  input,
  onBack,
  onPublished,
}: {
  teamId: string;
  input: PublishInput;
  onBack: () => void;
  onPublished: (outcome: Omit<Tracked, 'startedAt'>) => void;
}) {
  const posthog = usePostHog();
  const publish = useMutation({
    mutationFn: async (): Promise<PublishOutcome> => {
      const requestId = await derivePublishRequestId({ ...input, teamId });
      try {
        return await publishSequenceExportFn({ data: input });
      } catch {
        // Our server's reply was lost or it failed mid-call, so the post may
        // have gone out. Track the request rather than offer an edit — an
        // edited resend would be a new request id, i.e. a second post.
        return { requestId, state: 'unconfirmed' };
      }
    },
    onSuccess: (outcome) => {
      if (outcome.state === 'not_sent') return;
      onPublished(outcome);
      posthog.capture('social_publish_submitted', {
        sequence_id: input.sequenceId,
        platforms: input.platforms,
        state: outcome.state,
      });
    },
  });
  const notSent =
    publish.data?.state === 'not_sent' ? publish.data.message : null;

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Profile</dt>
        <dd>{input.profile}</dd>
        <dt className="text-muted-foreground">Platforms</dt>
        <dd>{input.platforms.map(socialPlatformLabel).join(', ')}</dd>
        <dt className="text-muted-foreground">Caption</dt>
        <dd className="break-words">{input.title}</dd>
        {input.description && (
          <>
            <dt className="text-muted-foreground">Description</dt>
            <dd className="break-words whitespace-pre-wrap">
              {input.description}
            </dd>
          </>
        )}
        {input.platforms.includes('youtube') && (
          <>
            <dt className="text-muted-foreground">YouTube</dt>
            <dd>{YOUTUBE_PRIVACY_LABELS[input.youtubePrivacy]}</dd>
          </>
        )}
        {input.platforms.includes('tiktok') && (
          <>
            <dt className="text-muted-foreground">TikTok</dt>
            <dd>{TIKTOK_PRIVACY_LABELS[input.tiktokPrivacy]}</dd>
          </>
        )}
      </dl>
      <p className="text-xs text-muted-foreground">
        Posts are labelled as AI-generated where the platform supports it.
        Published posts can't be undone from here.
      </p>
      {notSent && (
        <p role="alert" className="text-sm text-destructive">
          Not sent: {notSent}
        </p>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onBack}
          disabled={publish.isPending}
        >
          Back
        </Button>
        <Button
          type="button"
          onClick={() => publish.mutate()}
          disabled={publish.isPending}
        >
          {publish.isPending ? 'Publishing…' : 'Publish'}
        </Button>
      </DialogFooter>
    </div>
  );
}

// Upload-Post caches "not found" for a short while, and an unconfirmed call
// may still be registering, so give the request id this long to appear
// before saying it could not be confirmed.
const REGISTER_GRACE_MS = 2 * 60 * 1000;
// Stop polling a request that is still running after this long.
const MAX_TRACK_MS = 15 * 60 * 1000;
const POLL_MS = 5_000;

function trackingMessage(
  tracked: Tracked,
  status: PublishStatus | undefined,
  age: number
): string {
  const progress = progressMessage(tracked, status, age);
  return tracked.state === 'resumed'
    ? `This exact post was already sent, so nothing was sent again. ${progress}`
    : progress;
}

function progressMessage(
  tracked: Tracked,
  status: PublishStatus | undefined,
  age: number
): string {
  if (status?.state === 'done') return 'Finished.';
  if (status?.state === 'failed') {
    return `Publishing failed${status.message ? `: ${status.message}` : '.'}`;
  }
  if (status?.state === 'not_found' && age > REGISTER_GRACE_MS) {
    return 'Upload-Post has no record of this post yet. It may still appear — check again in a few minutes before publishing again.';
  }
  if (status?.state === 'running' && age > MAX_TRACK_MS) {
    return 'Still processing at Upload-Post. See app.upload-post.com for the result.';
  }
  if (tracked.state === 'unconfirmed') {
    return 'Upload-Post did not confirm the request. Checking whether it arrived…';
  }
  return 'Publishing…';
}

function PublishTracking({
  teamId,
  tracked,
  onClose,
  onNewPost,
}: {
  teamId: string;
  tracked: Tracked;
  onClose: () => void;
  onNewPost: () => void;
}) {
  const { requestId, startedAt } = tracked;
  const {
    data: status,
    error,
    refetch,
    isFetching,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ['social-publish-status', requestId],
    queryFn: () => getSocialPublishStatusFn({ data: { teamId, requestId } }),
    refetchInterval: (query) => {
      if (query.state.status === 'error') return false;
      const state = query.state.data?.state;
      if (state === 'done' || state === 'failed') return false;
      const age = query.state.dataUpdatedAt - startedAt;
      if (state === 'not_found' && age > REGISTER_GRACE_MS) return false;
      if (age > MAX_TRACK_MS) return false;
      return POLL_MS;
    },
  });
  // Age at the last poll: render stays pure, and the poll that crosses a
  // threshold is the one that re-renders with it.
  const age = dataUpdatedAt - startedAt;
  const finished = status?.state === 'done' || status?.state === 'failed';
  // Polling has stopped short of an outcome: offer a manual check.
  const stopped =
    !finished &&
    (Boolean(error) ||
      (status?.state === 'not_found' && age > REGISTER_GRACE_MS) ||
      age > MAX_TRACK_MS);

  return (
    <div className="flex flex-col gap-4">
      <p aria-live="polite" className="text-sm">
        {trackingMessage(tracked, status, age)}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          Couldn't check progress: {errorMessage(error)}
        </p>
      )}
      {status && status.results.length > 0 && (
        <ul className="flex flex-col gap-2 text-sm">
          {status.results.map((result) => (
            <li key={result.platform} className="flex flex-col gap-0.5">
              <span className="font-medium">
                {socialPlatformLabel(result.platform)} —{' '}
                {result.state === 'pending' ? 'in progress' : result.state}
              </span>
              {result.url && (
                <a
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-muted-foreground underline underline-offset-2"
                >
                  {result.url}
                </a>
              )}
              {(result.error ?? result.note) && (
                <span className="text-muted-foreground">
                  {result.error ?? result.note}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {status?.message && status.state === 'done' && (
        <p className="text-sm text-muted-foreground">{status.message}</p>
      )}
      <DialogFooter>
        {finished && (
          <Button type="button" variant="outline" onClick={onNewPost}>
            New post
          </Button>
        )}
        {stopped && (
          <Button
            type="button"
            variant="outline"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? 'Checking…' : 'Check again'}
          </Button>
        )}
        <Button type="button" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </div>
  );
}
