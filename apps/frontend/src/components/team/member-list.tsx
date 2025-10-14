/**
 * Team Member List Component
 * Displays team members with role badges and management actions
 */

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  getTeamMembers,
  removeTeamMember,
  updateMemberRole,
} from "@/app/actions/team";
import { AdminOnly } from "@/components/auth/admin-only";
import { OwnerOnly } from "@/components/auth/owner-only";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { type TeamRole, useTeamRole } from "@/hooks/use-team-role";
import { useUser } from "@/hooks/use-user";
import { MemberRoleBadge } from "./member-role-badge";

interface MemberListProps {
  teamId: string;
}

/**
 * Component to display and manage team members
 *
 * @example
 * ```tsx
 * <MemberList teamId="team-uuid" />
 * ```
 */
export function MemberList({ teamId }: MemberListProps) {
  const queryClient = useQueryClient();
  const { data: userData } = useUser();
  const { canRemoveMembers, canChangeRoles } = useTeamRole();
  const [error, setError] = useState<string | null>(null);

  // Fetch team members
  const { data: membersResult, isLoading } = useQuery({
    queryKey: ["team-members", teamId],
    queryFn: async () => {
      const result = await getTeamMembers(teamId);
      if (!result.success) {
        throw new Error(result.error || "Failed to fetch members");
      }
      return result.data || [];
    },
  });

  // Remove member mutation
  const removeMutation = useMutation({
    mutationFn: async (userId: string) => {
      const result = await removeTeamMember({ teamId, userId });
      if (!result.success) {
        throw new Error(result.error || "Failed to remove member");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team-members", teamId] });
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to remove member");
    },
  });

  // Update role mutation
  const updateRoleMutation = useMutation({
    mutationFn: async ({
      userId,
      newRole,
    }: {
      userId: string;
      newRole: TeamRole;
    }) => {
      const result = await updateMemberRole({ teamId, userId, newRole });
      if (!result.success) {
        throw new Error(result.error || "Failed to update role");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team-members", teamId] });
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to update role");
    },
  });

  const roleOptions = [
    { value: "admin", label: "Admin" },
    { value: "member", label: "Member" },
    { value: "viewer", label: "Viewer" },
  ];

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Team Members</CardTitle>
          <CardDescription>Loading...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const members = membersResult || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Team Members</CardTitle>
        <CardDescription>
          {members.length} {members.length === 1 ? "member" : "members"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-4">
          {members.map((member) => {
            const isCurrentUser = member.userId === userData?.user?.id;
            const isOwner = member.role === "owner";

            return (
              <div
                key={member.userId}
                className="flex items-center justify-between p-4 border rounded-lg"
              >
                <div className="flex items-center gap-4">
                  <div className="flex flex-col">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">
                        {member.fullName || member.email}
                      </span>
                      {isCurrentUser && (
                        <span className="text-sm text-muted-foreground">
                          (You)
                        </span>
                      )}
                    </div>
                    {member.fullName && (
                      <span className="text-sm text-muted-foreground">
                        {member.email}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Role badge or selector */}
                  {canChangeRoles && !isOwner && !isCurrentUser ? (
                    <OwnerOnly
                      fallback={
                        <MemberRoleBadge role={member.role as TeamRole} />
                      }
                    >
                      <Select
                        options={roleOptions}
                        value={member.role}
                        onChange={(newRole) =>
                          updateRoleMutation.mutate({
                            userId: member.userId,
                            newRole: newRole as TeamRole,
                          })
                        }
                        disabled={updateRoleMutation.isPending}
                        size="sm"
                        className="w-32"
                      />
                    </OwnerOnly>
                  ) : (
                    <MemberRoleBadge role={member.role as TeamRole} />
                  )}

                  {/* Remove button */}
                  {canRemoveMembers && !isOwner && !isCurrentUser && (
                    <AdminOnly>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => removeMutation.mutate(member.userId)}
                        disabled={removeMutation.isPending}
                      >
                        {removeMutation.isPending ? "Removing..." : "Remove"}
                      </Button>
                    </AdminOnly>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
