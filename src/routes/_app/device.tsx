/**
 * /device — approve a device-code login (#1219). The agent shows the user a
 * short code and this URL; the user signs in, confirms the code, and approves.
 * Approval mints a normal API key, revocable under Settings → Developer.
 */

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
import {
  decideDeviceGrantFn,
  lookupDeviceGrantFn,
} from '@/functions/device-auth';
import { requireSessionOrRedirect } from '@/lib/auth/route-guards';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

const searchSchema = z.object({ user_code: z.string().optional() });

export const Route = createFileRoute('/_app/device')({
  validateSearch: searchSchema,
  beforeLoad: async ({ context: { queryClient }, location }) => {
    await requireSessionOrRedirect(queryClient, location.href);
  },
  component: DevicePage,
  staticData: { breadcrumb: 'Device login' },
});

function DevicePage() {
  const { user_code } = Route.useSearch();
  const navigate = Route.useNavigate();

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const field = new FormData(e.currentTarget).get('user_code');
    const code = typeof field === 'string' ? field : '';
    void navigate({ search: { user_code: code }, replace: true });
  };

  return (
    <div className="mx-auto w-full max-w-md p-6">
      <Card>
        <CardHeader>
          <CardTitle>Device login</CardTitle>
          <CardDescription>
            Enter the code shown by your agent or CLI to give it access to the
            OpenStory API.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form onSubmit={onSubmit} className="flex gap-2">
            <Input
              name="user_code"
              defaultValue={user_code ?? ''}
              placeholder="ABCD-EFGH"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="font-mono uppercase"
              required
            />
            <Button type="submit" variant="outline">
              Check
            </Button>
          </form>
          {user_code && (
            <Suspense fallback={<Skeleton className="h-20 w-full" />}>
              <GrantDecision userCode={user_code} />
            </Suspense>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function GrantDecision({ userCode }: { userCode: string }) {
  const [decided, setDecided] = useState<'approved' | 'denied' | null>(null);
  const { data } = useSuspenseQuery({
    queryKey: ['deviceGrant', userCode],
    queryFn: () => lookupDeviceGrantFn({ data: { userCode } }),
  });
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      decideDeviceGrantFn({ data: { userCode, approve } }),
    onSuccess: ({ error }, approve) => {
      if (error) {
        toast.error(
          error === 'access_denied'
            ? 'This code was requested under a different account. Sign in as that account to approve it.'
            : 'This code is no longer valid. Ask your agent for a new one.'
        );
        void queryClient.invalidateQueries({
          queryKey: ['deviceGrant', userCode],
        });
        return;
      }
      setDecided(approve ? 'approved' : 'denied');
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Something went wrong'),
  });

  if (decided === 'approved') {
    return (
      <output className="block">
        Approved. Return to your agent — it now has a key named “Agent login”,
        which you can revoke any time under Settings → Developer.
      </output>
    );
  }
  if (decided === 'denied') {
    return (
      <output className="block">
        Denied. The agent will not receive a key.
      </output>
    );
  }
  if (data.status === 'approved' || data.status === 'denied') {
    return (
      <output className="block">
        Code <code className="font-mono">{userCode}</code> has already been{' '}
        {data.status}.
      </output>
    );
  }
  if (data.status === 'invalid') {
    return (
      <p role="alert">
        Code <code className="font-mono">{userCode}</code> isn’t valid or has
        expired. Check it and try again, or ask your agent for a new one.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p>
        Give the device showing{' '}
        <code className="font-mono font-semibold">{userCode}</code> an API key
        for team <strong>{data.teamName}</strong>? Only approve codes you
        requested yourself.
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
