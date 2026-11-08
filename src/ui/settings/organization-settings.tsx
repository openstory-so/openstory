/**
 * Invite, pending invitations and members of the active organization.
 * Controls appear only for roles the server would accept them from.
 */

import { authClient, authData } from '@/platform/ui/auth/client';
import { useOrganizationPermission } from '@/platform/ui/auth/organization-permission';
import { useUser } from '@/platform/ui/use-user';
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
import { Avatar, AvatarFallback, AvatarImage } from '@/ui/shadcn/avatar';
import { Button } from '@/ui/shadcn/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/ui/shadcn/card';
import { Input } from '@/ui/shadcn/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/shadcn/select';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { avatarStyle, getInitials } from '@/ui/utils';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

const roleSchema = z.enum(['member', 'admin']);
const ROLE_LABELS = { member: 'Member', admin: 'Admin', owner: 'Owner' };
const inviteSchema = z.object({
  email: z.string().email('Enter an email address'),
  role: roleSchema,
});
type InviteRole = z.infer<typeof roleSchema>;

function OrganizationSettingsFallback() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
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

/** Refetch members and invitations after a change; surface a refusal. */
function useOrganizationMutation<T>(
  run: (
    input: T
  ) => Promise<{ data: unknown; error: { message?: string } | null }>,
  failed: string
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: T) => authData(run(input)),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['organization'] }),
    onError: (error) => toast.error(failed, { description: error.message }),
  });
}

function RoleSelect({
  value,
  onChange,
  ...props
}: {
  value: string;
  onChange: (role: InviteRole) => void;
} & Omit<React.ComponentProps<typeof SelectTrigger>, 'onChange'>) {
  return (
    <Select
      items={ROLE_LABELS}
      value={value}
      onValueChange={(next) => {
        const role = roleSchema.safeParse(next);
        if (role.success) onChange(role.data);
      }}
    >
      <SelectTrigger className="w-32" {...props}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="member">Member</SelectItem>
        <SelectItem value="admin">Admin</SelectItem>
        {value === 'owner' ? (
          <SelectItem value="owner">Owner</SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  );
}

function OrganizationPanel() {
  const { data: user } = useUser();
  const members = useSuspenseQuery({
    queryKey: ['organization', 'members'],
    queryFn: () => authData(authClient.organization.listMembers()),
  });
  // 1.7.16 refuses list-invitations without invitation:create. A member's
  // 403 must not take down the member list, which shares this suspense.
  const canInvite = useOrganizationPermission({ invitation: ['create'] });
  const canCancel = useOrganizationPermission({ invitation: ['cancel'] });
  const canEditMembers = useOrganizationPermission({
    member: ['update', 'delete'],
  });
  const updateRole = useOrganizationMutation(
    (input: { memberId: string; role: InviteRole }) =>
      authClient.organization.updateMemberRole(input),
    'Could not change the role'
  );
  const removeMember = useOrganizationMutation(
    (memberId: string) =>
      authClient.organization.removeMember({ memberIdOrEmail: memberId }),
    'Could not remove the member'
  );
  return (
    <div className="flex flex-col gap-6">
      {canInvite ? <InviteCard /> : null}
      {canInvite ? <PendingInvitations canCancel={canCancel} /> : null}
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-3">
            {members.data.members.map((member) => {
              const name = member.user.name || member.user.email;
              const editable = canEditMembers && member.userId !== user?.id;
              return (
                <li key={member.id} className="flex items-center gap-3">
                  <Avatar>
                    <AvatarImage src={member.user.image || undefined} alt="" />
                    <AvatarFallback style={avatarStyle(name)}>
                      {getInitials(name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate">{name}</span>
                    <span className="truncate text-sm text-muted-foreground">
                      {member.user.email}
                      {editable ? null : <span> · {member.role}</span>}
                    </span>
                  </div>
                  {editable ? (
                    <>
                      <RoleSelect
                        aria-label={`Role for ${name}`}
                        value={member.role}
                        disabled={updateRole.isPending}
                        onChange={(role) =>
                          updateRole.mutate({ memberId: member.id, role })
                        }
                      />
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            disabled={removeMember.isPending}
                          >
                            Remove
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
                            <AlertDialogDescription>
                              They lose access to this organization's sequences
                              and library at once. You can invite them again
                              later.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => removeMember.mutate(member.id)}
                            >
                              Remove
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function PendingInvitations({ canCancel }: { canCancel: boolean }) {
  const invitations = useSuspenseQuery({
    queryKey: ['organization', 'invitations'],
    queryFn: () => authData(authClient.organization.listInvitations()),
  });
  const cancelInvitation = useOrganizationMutation(
    (invitationId: string) =>
      authClient.organization.cancelInvitation({ invitationId }),
    'Could not cancel the invitation'
  );
  const pending = invitations.data.filter(
    (invitation) => invitation.status === 'pending'
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending invitations</CardTitle>
        <CardDescription>
          {pending.length === 0
            ? 'No pending invitations.'
            : 'Sent, not yet accepted.'}
        </CardDescription>
      </CardHeader>
      {pending.length === 0 ? null : (
        <CardContent>
          <ul className="flex flex-col gap-3">
            {pending.map((invitation) => (
              <li key={invitation.id} className="flex items-center gap-3">
                <Avatar>
                  <AvatarFallback style={avatarStyle(invitation.email)}>
                    {getInitials(invitation.email)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate">{invitation.email}</span>
                  <span className="text-sm text-muted-foreground">
                    {invitation.role}
                  </span>
                </div>
                {canCancel ? (
                  <Button
                    variant="ghost"
                    disabled={cancelInvitation.isPending}
                    onClick={() => cancelInvitation.mutate(invitation.id)}
                  >
                    {cancelInvitation.isPending &&
                    cancelInvitation.variables === invitation.id
                      ? 'Cancelling…'
                      : 'Cancel'}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}

function InviteCard() {
  const [role, setRole] = useState<InviteRole>('member');
  const invite = useOrganizationMutation(
    (input: z.infer<typeof inviteSchema>) =>
      authClient.organization.inviteMember(input),
    'Could not send the invitation'
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite</CardTitle>
        <CardDescription>
          Admins manage members, keys and billing. Members create and edit.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const parsed = inviteSchema.safeParse({
              email: new FormData(form).get('email'),
              role,
            });
            if (!parsed.success) {
              toast.error(
                parsed.error.issues[0]?.message ?? 'Check the invitation'
              );
              return;
            }
            void invite.mutateAsync(parsed.data).then(
              () => form.reset(),
              () => undefined
            );
          }}
        >
          <Input
            aria-label="Email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="off"
            placeholder="name@example.com"
            required
            className="flex-1"
          />
          <RoleSelect aria-label="Role" value={role} onChange={setRole} />
          <Button type="submit" disabled={invite.isPending}>
            {invite.isPending ? 'Sending…' : 'Send invitation'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
