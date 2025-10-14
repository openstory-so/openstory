/**
 * Invite Member Form Component
 * Form to invite new team members (admin/owner only)
 */

"use client";

import type React from "react";
import { useState } from "react";
import { inviteTeamMember } from "@/app/actions/team";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useTeamRole } from "@/hooks/use-team-role";

interface InviteMemberFormProps {
  onSuccess?: () => void;
  onCancel?: () => void;
}

/**
 * Form component for inviting new team members
 *
 * @example
 * ```tsx
 * <InviteMemberForm
 *   onSuccess={() => console.log('Invited!')}
 *   onCancel={() => setShowForm(false)}
 * />
 * ```
 */
export function InviteMemberForm({
  onSuccess,
  onCancel,
}: InviteMemberFormProps) {
  const { teamId, canInviteMembers } = useTeamRole();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin" | "viewer">("member");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const roleOptions = [
    { value: "member", label: "Member" },
    { value: "admin", label: "Admin" },
    { value: "viewer", label: "Viewer" },
  ];

  if (!canInviteMembers) {
    return (
      <Alert>
        <AlertDescription>
          You don't have permission to invite members.
        </AlertDescription>
      </Alert>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setIsLoading(true);

    if (!teamId) {
      setError("No team selected");
      setIsLoading(false);
      return;
    }

    try {
      const result = await inviteTeamMember({
        teamId,
        email,
        role,
      });

      if (!result.success) {
        setError(result.error || "Failed to send invitation");
        setIsLoading(false);
        return;
      }

      setSuccess(true);
      setEmail("");
      setRole("member");

      // Call success callback after a short delay
      setTimeout(() => {
        onSuccess?.();
      }, 1500);
    } catch (err) {
      console.error("[InviteMemberForm] Error:", err);
      setError(
        err instanceof Error ? err.message : "Failed to send invitation",
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email Address</Label>
        <Input
          id="email"
          type="email"
          placeholder="colleague@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={isLoading}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="role">Role</Label>
        <Select
          options={roleOptions}
          value={role}
          onChange={(value) => setRole(value as "member" | "admin" | "viewer")}
          disabled={isLoading}
          placeholder="Select a role"
        />
        <p className="text-sm text-muted-foreground">
          {role === "admin" && "Can manage team members and resources"}
          {role === "member" && "Can create and edit own resources"}
          {role === "viewer" && "Read-only access to team resources"}
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert>
          <AlertDescription>
            Invitation sent successfully! The user will receive an email with
            instructions.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex gap-2 justify-end">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isLoading}
          >
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={isLoading || !email}>
          {isLoading ? "Sending..." : "Send Invitation"}
        </Button>
      </div>
    </form>
  );
}
