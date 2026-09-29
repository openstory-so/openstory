/**
 * The Sign in control from the sequences empty state.
 *
 * Opens the login dialog (`explicit`, not an action gate) and renders nothing
 * once a session is present, so list pages can mount it under the subtitle
 * without a signed-in branch. Hidden while the session query is still
 * unresolved so a signed-in visit does not flash the button.
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
