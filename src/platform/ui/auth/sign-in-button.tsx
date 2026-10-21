/**
 * The Sign in control from the sequences empty state.
 *
 * Opens the login dialog (`explicit`, not an action gate) and renders nothing
 * once a session is present. Library pages put it in the empty-state action,
 * under the copy. The front page uses the composer generate button instead.
 * Hidden while the session query is still unresolved so a signed-in visit
 * does not flash it.
 */

import { useAuthGate } from './auth-gate-provider';
import { useUser } from '@/platform/ui/use-user';
import { Button } from '@/ui/shadcn/button';

export function SignInButton() {
  const { data: user, isLoading } = useUser();
  const { openLogin } = useAuthGate();
  if (isLoading || user) return null;

  return (
    <Button type="button" className="w-fit" onClick={openLogin}>
      Sign in
    </Button>
  );
}
