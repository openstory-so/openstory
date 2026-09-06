/**
 * Passkey Settings Component
 * Displays list of passkeys with add/delete functionality
 */

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { authClient } from '@/components/auth/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Fingerprint, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

type PasskeySettingsProps = {
  isSetupFlow?: boolean;
};

export function PasskeySettings({ isSetupFlow }: PasskeySettingsProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const {
    data: passkeys,
    isLoading,
    error: fetchError,
  } = useQuery({
    queryKey: ['passkeys'],
    queryFn: async () => {
      const result = await authClient.passkey.listUserPasskeys();
      if (result.error) {
        throw new Error(result.error.message || 'Failed to load passkeys');
      }
      return result.data;
    },
    staleTime: 5 * 60 * 1000,
  });

  const addPasskeyMutation = useMutation({
    mutationFn: async () => {
      const result = await authClient.passkey.addPasskey();
      if (result.error) {
        throw new Error(
          typeof result.error === 'object' &&
            'message' in result.error &&
            typeof result.error.message === 'string'
            ? result.error.message
            : 'Failed to add passkey'
        );
      }
      return result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['passkeys'] });
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to add passkey');
    },
  });

  const deletePasskeyMutation = useMutation({
    mutationFn: async (id: string) => {
      const result = await authClient.passkey.deletePasskey({ id });
      if (result.error) {
        throw new Error(result.error.message || 'Failed to delete passkey');
      }
      return result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['passkeys'] });
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to delete passkey');
    },
  });

  const handleContinue = () => {
    void navigate({ to: '/sequences' });
  };

  const handleSkip = () => {
    localStorage.setItem('openstory-passkey-skip', 'true');
    void navigate({ to: '/sequences' });
  };

  const content = (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
              <Fingerprint className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle>
                {isSetupFlow ? 'Set up a passkey' : 'Passkeys'}
              </CardTitle>
              <CardDescription>
                {isSetupFlow
                  ? 'Sign in instantly with Face ID, Touch ID, or your device PIN'
                  : 'Manage your passkeys for passwordless sign-in'}
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {(error || fetchError) && (
            <Alert variant="destructive">
              <AlertDescription>
                {error ||
                  (fetchError instanceof Error
                    ? fetchError.message
                    : 'Failed to load passkeys')}
              </AlertDescription>
            </Alert>
          )}

          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : passkeys && passkeys.length > 0 ? (
            <div className="space-y-3">
              {passkeys.map((passkey) => (
                <div
                  key={passkey.id}
                  className="flex items-center justify-between rounded-lg border p-4"
                >
                  <div className="flex items-center gap-3">
                    <Fingerprint className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="font-medium">{passkey.name || 'Passkey'}</p>
                      <p className="text-sm text-muted-foreground">
                        Added {new Date(passkey.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => deletePasskeyMutation.mutate(passkey.id)}
                    disabled={deletePasskeyMutation.isPending}
                    aria-label="Delete passkey"
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-center text-muted-foreground py-4">
              No passkeys registered yet
            </p>
          )}

          <Button
            onClick={() => addPasskeyMutation.mutate()}
            disabled={addPasskeyMutation.isPending}
            className="w-full"
          >
            <Plus className="mr-2 h-4 w-4" />
            {addPasskeyMutation.isPending ? 'Adding…' : 'Add passkey'}
          </Button>

          {isSetupFlow && (
            <div className="flex gap-2 pt-2">
              <Button variant="outline" className="flex-1" onClick={handleSkip}>
                Skip for now
              </Button>
              {passkeys && passkeys.length > 0 && (
                <Button className="flex-1" onClick={handleContinue}>
                  Continue
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );

  // Only wrap with container when in setup flow (standalone page)
  if (isSetupFlow) {
    return <div className="mx-auto max-w-2xl p-6">{content}</div>;
  }

  return content;
}
