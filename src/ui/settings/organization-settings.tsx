/**
 * Members of the active organization, pending invitations, and invites.
 */

import { authClient } from '@/platform/ui/auth/client';
import { Button } from '@/ui/shadcn/button';
import { Input } from '@/ui/shadcn/input';
import { Label } from '@/ui/shadcn/label';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Suspense, useEffect, useState } from 'react';
import { z } from 'zod';

const inviteSchema = z.object({
  email: z.string().email('Enter an email address'),
  role: z.enum(['member', 'admin']),
});

async function authData<T>(
  result: Promise<{
    data: T | null;
    error: { message?: string } | null;
  }>
): Promise<T> {
  const settled = await result;
  if (settled.error) {
    throw new Error(settled.error.message ?? 'Organization request failed');
  }
  if (settled.data == null) {
    throw new Error('Organization request failed');
  }
  return settled.data;
}

function OrganizationSettingsFallback() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

export function OrganizationSettings() {
  // The auth client builds its URL from window. Skip the server render.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);
  if (!ready) return <OrganizationSettingsFallback />;
  return (
    <Suspense fallback={<OrganizationSettingsFallback />}>
      <OrganizationPanel />
    </Suspense>
  );
}

function OrganizationPanel() {
  const members = useSuspenseQuery({
    queryKey: ['organization', 'members'],
    queryFn: () => authData(authClient.organization.listMembers()),
  });
  const invitations = useSuspenseQuery({
    queryKey: ['organization', 'invitations'],
    queryFn: () => authData(authClient.organization.listInvitations()),
  });
  const role = useSuspenseQuery({
    queryKey: ['organization', 'role'],
    queryFn: () => authData(authClient.organization.getActiveMemberRole()),
  });
  const canInvite = authClient.organization.checkRolePermission({
    role: role.data.role,
    permissions: { invitation: ['create'] },
  });
  const pending = invitations.data.filter(
    (invitation) => invitation.status === 'pending'
  );

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-medium">Members</h2>
        <ul className="flex flex-col gap-3">
          {members.data.members.map((member) => (
            <li key={member.id} className="flex flex-col gap-0.5">
              <span>{member.user.name}</span>
              <span className="text-sm text-muted-foreground">
                {member.user.email} · {member.role}
              </span>
            </li>
          ))}
        </ul>
      </section>
      {canInvite ? <InviteForm /> : null}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-medium">Pending invitations</h2>
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pending invitations.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {pending.map((invitation) => (
              <li key={invitation.id} className="text-sm">
                {invitation.email} · {invitation.role}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function InviteForm() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = new FormData(form);
    const parsed = inviteSchema.safeParse({
      email: body.get('email'),
      role: body.get('role'),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the invitation');
      return;
    }
    setPending(true);
    setError(null);
    const result = await authClient.organization.inviteMember({
      email: parsed.data.email,
      role: parsed.data.role,
    });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? 'Could not send the invitation');
      return;
    }
    form.reset();
    await queryClient.invalidateQueries({
      queryKey: ['organization', 'invitations'],
    });
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => void onSubmit(event)}
    >
      <h2 className="text-base font-medium">Invite</h2>
      <div className="flex flex-col gap-2">
        <Label htmlFor="organization-invite-email">Email</Label>
        <Input
          id="organization-invite-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          className="min-h-11 text-base"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="organization-invite-role">Role</Label>
        <select
          id="organization-invite-role"
          name="role"
          defaultValue="member"
          className="min-h-11 rounded-lg border border-input bg-transparent px-2.5 text-base"
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="min-h-11 w-fit">
        {pending ? 'Sending…' : 'Send invitation'}
      </Button>
    </form>
  );
}
