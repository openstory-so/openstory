/**
 * Publish-to-social dialog (#1267). Opened by the theatre's Publish button
 * once an MP4 for the current cut exists (`useSequenceExport().publishTarget`).
 *
 * Flow: pick an Upload-Post profile → tick the platforms connected on it →
 * caption → Publish. The upload is asynchronous on Upload-Post's side, so
 * after submit the dialog polls `getSocialPublishStatusFn` and lists each
 * platform's outcome (post link or error) as it lands.
 */

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  getSocialPublishStatusFn,
  listSocialProfilesFn,
  publishSequenceExportFn,
} from '@/functions/social-publish';
import {
  SOCIAL_PLATFORMS,
  type PublishStatus,
  type SocialPlatform,
} from '@/lib/social/upload-post';
import { usePostHog } from '@posthog/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, ExternalLink, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

function platformLabel(id: SocialPlatform): string {
  return SOCIAL_PLATFORMS.find((p) => p.id === id)?.label ?? id;
}

const STATUS_POLL_MS = 4_000;
const TERMINAL_STATUSES: readonly PublishStatus['status'][] = [
  'completed',
  'failed',
  'not_found',
];

export type PublishDialogProps = {
  open: boolean;
  onClose: () => void;
  sequenceId: string;
  teamId: string;
  exportId: string;
  defaultTitle: string;
};

export function PublishDialog(props: PublishDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={(next) => !next && props.onClose()}>
      <DialogContent className="sm:max-w-md">
        {/* Remount on open/export change so form + poll state start fresh. */}
        {props.open && <PublishDialogBody key={props.exportId} {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function PublishDialogBody({
  onClose,
  sequenceId,
  teamId,
  exportId,
  defaultTitle,
}: PublishDialogProps) {
  const posthog = usePostHog();
  const [profile, setProfile] = useState<string | null>(null);
  // `null` = "everything connected on the selected profile" — the default
  // until the user touches a checkbox, and reset on profile change so a stale
  // tick for an unconnected platform can't reach the server.
  const [platformPicks, setPlatformPicks] = useState<SocialPlatform[] | null>(
    null
  );
  const [title, setTitle] = useState(defaultTitle);
  const [requestId, setRequestId] = useState<string | null>(null);

  const profilesQuery = useQuery({
    queryKey: ['social-profiles', teamId],
    queryFn: () => listSocialProfilesFn({ data: { teamId } }),
    staleTime: 60_000,
  });

  const profiles = profilesQuery.data?.profiles ?? [];
  // Default to the first profile with something connected.
  const selectedProfile =
    profiles.find((p) => p.username === profile) ??
    profiles.find((p) => p.platforms.length > 0) ??
    profiles[0] ??
    null;
  const connected = selectedProfile?.platforms ?? [];
  const platforms = platformPicks ?? connected;

  const publishMutation = useMutation({
    mutationFn: () =>
      publishSequenceExportFn({
        data: {
          sequenceId,
          exportId,
          profile: selectedProfile?.username ?? '',
          platforms,
          title,
        },
      }),
    onSuccess: ({ requestId: id }) => {
      setRequestId(id);
      posthog.capture('sequence_published_to_social', {
        sequence_id: sequenceId,
        platforms,
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Publish failed');
      posthog.captureException(error, { sequence_id: sequenceId });
    },
  });

  const statusQuery = useQuery({
    queryKey: ['social-publish-status', teamId, requestId],
    queryFn: () =>
      getSocialPublishStatusFn({
        data: { teamId, requestId: requestId ?? '' },
      }),
    enabled: requestId !== null,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return STATUS_POLL_MS;
      const done =
        TERMINAL_STATUSES.includes(data.status) ||
        data.results.length >= platforms.length;
      return done ? false : STATUS_POLL_MS;
    },
  });

  if (profilesQuery.isLoading) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Publish to social media</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </>
    );
  }

  if (profilesQuery.isError || !profilesQuery.data?.configured) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Publish to social media</DialogTitle>
          <DialogDescription>
            {profilesQuery.isError
              ? profilesQuery.error instanceof Error
                ? profilesQuery.error.message
                : 'Could not load your Upload-Post profiles.'
              : 'Connect an Upload-Post API key to post exports straight to TikTok, Instagram, YouTube, X and more.'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {!profilesQuery.isError && (
            <Button asChild>
              <Link to="/settings/api-keys">Open API key settings</Link>
            </Button>
          )}
        </DialogFooter>
      </>
    );
  }

  if (requestId) {
    return (
      <PublishOutcome
        platforms={platforms}
        status={statusQuery.data ?? null}
        onClose={onClose}
      />
    );
  }

  const canPublish =
    selectedProfile !== null &&
    platforms.length > 0 &&
    title.trim().length > 0 &&
    !publishMutation.isPending;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canPublish) publishMutation.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Publish to social media</DialogTitle>
        <DialogDescription>
          Posts the current cut through Upload-Post. It's labeled as
          AI-generated where the platform supports it.
        </DialogDescription>
      </DialogHeader>

      {profiles.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Your Upload-Post account has no profiles yet. Create one and connect
          your social accounts at{' '}
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
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor="publish-profile">Profile</Label>
            <Select
              value={selectedProfile?.username ?? ''}
              onValueChange={(username) => {
                setProfile(username);
                setPlatformPicks(null);
              }}
            >
              <SelectTrigger id="publish-profile">
                <SelectValue placeholder="Pick a profile" />
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

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Platforms</legend>
            {connected.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No supported social accounts are connected on this profile.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {connected.map((platform) => {
                  const id = `publish-platform-${platform}`;
                  return (
                    <div key={platform} className="flex items-center gap-2">
                      <Checkbox
                        id={id}
                        checked={platforms.includes(platform)}
                        onCheckedChange={(checked) =>
                          setPlatformPicks(
                            checked === true
                              ? [...platforms, platform]
                              : platforms.filter((p) => p !== platform)
                          )
                        }
                      />
                      <Label htmlFor={id} className="font-normal">
                        {platformLabel(platform)}
                      </Label>
                    </div>
                  );
                })}
              </div>
            )}
          </fieldset>

          <div className="flex flex-col gap-2">
            <Label htmlFor="publish-title">Caption</Label>
            <Textarea
              id="publish-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              rows={3}
              maxLength={2200}
              required
            />
            <p className="text-xs text-muted-foreground">
              Used as the title on YouTube and the caption everywhere else.
            </p>
          </div>
        </>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        {profiles.length > 0 && (
          <Button type="submit" disabled={!canPublish}>
            {publishMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Publishing…
              </>
            ) : platforms.length === 1 ? (
              'Publish to 1 platform'
            ) : (
              `Publish to ${platforms.length} platforms`
            )}
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

function PublishOutcome({
  platforms,
  status,
  onClose,
}: {
  platforms: SocialPlatform[];
  status: PublishStatus | null;
  onClose: () => void;
}) {
  const finished =
    status !== null &&
    (TERMINAL_STATUSES.includes(status.status) ||
      status.results.length >= platforms.length);

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {finished ? 'Publish finished' : 'Publishing…'}
        </DialogTitle>
        <DialogDescription>
          {finished
            ? 'Each platform reports its own result below.'
            : 'Upload-Post is sending the video to each platform. You can close this and keep working — the posts will still go out.'}
        </DialogDescription>
      </DialogHeader>

      <ul className="flex flex-col gap-2">
        {platforms.map((platform) => {
          const result = status?.results.find((r) => r.platform === platform);
          return (
            <li
              key={platform}
              className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
            >
              <span className="flex items-center gap-2">
                {result ? (
                  result.success ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive" />
                  )
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
                {platformLabel(platform)}
              </span>
              {result?.postUrl ? (
                <a
                  href={result.postUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs underline underline-offset-2"
                >
                  View post
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : result && !result.success ? (
                <span
                  className="max-w-[60%] truncate text-xs text-destructive"
                  title={result.error ?? undefined}
                >
                  {result.error ?? 'Failed'}
                </span>
              ) : result?.success ? (
                <span className="text-xs text-muted-foreground">Published</span>
              ) : null}
            </li>
          );
        })}
      </ul>

      {status?.status === 'failed' && status.message && (
        <p className="text-xs text-destructive">{status.message}</p>
      )}

      <DialogFooter>
        <Button onClick={onClose}>{finished ? 'Done' : 'Close'}</Button>
      </DialogFooter>
    </>
  );
}
