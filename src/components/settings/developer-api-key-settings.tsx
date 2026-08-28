/**
 * Developer API Key Settings
 * Mint, view, and revoke keys that authenticate calls to the public OpenStory
 * API (`/api/v1/*`). Distinct from the "API Keys" tab, which manages a team's
 * provider keys (OpenRouter/Fal). The secret is shown exactly once, on creation.
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { copyTextToClipboard } from '@/lib/utils/clipboard';
import {
  createPublicApiKeyFn,
  listPublicApiKeysFn,
  revokePublicApiKeyFn,
} from '@/functions/public-api-keys';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { Check, Copy, KeyRound, Trash2 } from 'lucide-react';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

const PUBLIC_API_KEYS_QUERY_KEY = ['publicApiKeys'] as const;

const createFormSchema = z.object({
  name: z.string().min(1).max(32),
});

export function DeveloperApiKeySettings() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
            <KeyRound className="h-5 w-5 text-primary" />
          </div>
          <div>
            <CardTitle>API access</CardTitle>
            <CardDescription>
              Create keys to call the OpenStory API. Authenticate with{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                Authorization: Bearer &lt;key&gt;
              </code>
              .
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <CreateKeyForm />
        <div className="border-t" />
        <Suspense fallback={<KeyListSkeleton />}>
          <KeyList />
        </Suspense>
      </CardContent>
    </Card>
  );
}

function CreateKeyForm() {
  const queryClient = useQueryClient();
  const [createdKey, setCreatedKey] = useState<{
    name: string;
    key: string;
  } | null>(null);

  const createMutation = useMutation({
    mutationFn: (input: { name: string }) =>
      createPublicApiKeyFn({ data: input }),
    onSuccess: (result) => {
      setCreatedKey({ name: result.name, key: result.key });
      void queryClient.invalidateQueries({
        queryKey: PUBLIC_API_KEYS_QUERY_KEY,
      });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to create key');
    },
  });

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const parsed = createFormSchema.safeParse(
      Object.fromEntries(new FormData(e.currentTarget))
    );
    if (!parsed.success) {
      toast.error('Enter a name (1–32 characters).');
      return;
    }
    createMutation.mutate({ name: parsed.data.name });
    e.currentTarget.reset();
  };

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="flex gap-2">
        <Input
          name="name"
          placeholder="Key name (e.g. Production server)"
          maxLength={32}
          autoComplete="off"
          required
        />
        <Button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending ? 'Creating…' : 'Create key'}
        </Button>
      </form>

      {createdKey && (
        <NewKeyReveal
          name={createdKey.name}
          apiKey={createdKey.key}
          onDismiss={() => setCreatedKey(null)}
        />
      )}
    </div>
  );
}

function NewKeyReveal({
  name,
  apiKey,
  onDismiss,
}: {
  name: string;
  apiKey: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!(await copyTextToClipboard(apiKey))) {
      // The key is shown exactly once, so a silent failure would lose it.
      toast.error('Could not copy the key', {
        description:
          'Your browser blocked clipboard access. Select the key above and copy it manually before dismissing this.',
      });
      return;
    }
    setCopied(true);
    toast.success('Copied to clipboard');
  };

  return (
    <Alert>
      <KeyRound className="h-4 w-4" />
      <AlertTitle>Key “{name}” created</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <span>Copy it now — for your security it won’t be shown again.</span>
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-xs">
            {apiKey}
          </code>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => void copy()}
            aria-label="Copy API key"
          >
            {copied ? (
              <Check className="h-4 w-4" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
        </div>
        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            Done
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function KeyList() {
  const queryClient = useQueryClient();
  const { data: keys } = useSuspenseQuery({
    queryKey: PUBLIC_API_KEYS_QUERY_KEY,
    queryFn: () => listPublicApiKeysFn(),
  });

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => revokePublicApiKeyFn({ data: { keyId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: PUBLIC_API_KEYS_QUERY_KEY,
      });
      toast.success('Key revoked');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to revoke key');
    },
  });

  if (keys.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No API keys yet. Create one above to start using the API.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {keys.map((key) => (
        <li
          key={key.id}
          className="flex items-center justify-between rounded-lg border p-3"
        >
          <div className="flex items-center gap-3">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">
                {key.name ?? 'Untitled key'}
              </p>
              <p className="text-xs text-muted-foreground">
                {key.start ? `${key.start}…` : 'osk_…'}
                {key.expiresAt
                  ? ` · expires ${new Date(key.expiresAt).toLocaleDateString()}`
                  : ' · no expiry'}
                {key.lastRequest
                  ? ` · last used ${new Date(key.lastRequest).toLocaleDateString()}`
                  : ' · never used'}
              </p>
            </div>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Revoke ${key.name ?? 'key'}`}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Revoke this API key?</AlertDialogTitle>
                <AlertDialogDescription>
                  Any integration using “{key.name ?? 'this key'}” will stop
                  working immediately. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => revokeMutation.mutate(key.id)}
                >
                  Revoke
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </li>
      ))}
    </ul>
  );
}

function KeyListSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  );
}
