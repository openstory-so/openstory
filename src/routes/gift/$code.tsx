import { OpenStoryLogo } from '@/components/icons/openstory-logo';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { redeemGiftTokenFn } from '@/functions/gift-tokens';
import { BILLING_BALANCE_KEY } from '@/hooks/use-billing-balance';
import { BILLING_GATE_KEY } from '@/hooks/use-billing-gate';
import { sessionQueryOptions } from '@/lib/auth/session-query';
import { usePostHog } from '@posthog/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from '@tanstack/react-router';
import { Gift, Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

const STORAGE_KEY = 'openstory:pending-gift-code';
const RETURN_KEY = 'openstory:billing-return';

function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

export const Route = createFileRoute('/gift/$code')({
  beforeLoad: async ({ context: { queryClient }, params }) => {
    const code = normalizeCode(params.code);
    if (code.length !== 6) {
      throw redirect({ to: '/' });
    }
    const session = await queryClient.ensureQueryData(sessionQueryOptions);
    return { session };
  },
  component: GiftCodePage,
});

function GiftCodePage() {
  const { code: rawCode } = Route.useParams();
  const code = normalizeCode(rawCode);
  const { data: session } = useQuery(sessionQueryOptions);

  if (session?.user) {
    return <AutoRedeemView code={code} />;
  }

  return <GiftLandingPage code={code} />;
}

// -- Shared layout components --

const CenteredLayout: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div className="flex min-h-screen items-center justify-center bg-background p-4">
    <div className="w-full max-w-sm space-y-8">
      <div className="flex flex-col items-center gap-4 text-center">
        <Link to="/">
          <OpenStoryLogo size="lg" />
        </Link>
        <p className="text-muted-foreground">
          AI video production, from script to screen.
        </p>
      </div>
      <Card className="text-center">{children}</Card>
    </div>
  </div>
);

const CodeDisplay: React.FC<{ code: string }> = ({ code }) => (
  <div className="rounded-lg border bg-muted/50 px-4 py-3">
    <p className="font-mono text-2xl font-bold tracking-widest">{code}</p>
  </div>
);

type IconBadgeProps = {
  variant: 'primary' | 'destructive';
  children: React.ReactNode;
};

const variantClasses = {
  primary: 'bg-primary/10',
  destructive: 'bg-destructive/10',
} as const;

const IconBadge: React.FC<IconBadgeProps> = ({ variant, children }) => (
  <div
    className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full ${variantClasses[variant]}`}
  >
    {children}
  </div>
);

// -- Views --

type GiftCodeViewProps = {
  code: string;
};

function AutoRedeemView({ code }: GiftCodeViewProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const posthog = usePostHog();
  const hasTriggered = useRef(false);

  const { mutate, isError, isPending, error } = useMutation({
    mutationFn: (input: { code: string }) => redeemGiftTokenFn({ data: input }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: [...BILLING_BALANCE_KEY],
      });
      void queryClient.invalidateQueries({
        queryKey: [...BILLING_GATE_KEY],
      });

      posthog.capture('gift_code_redeemed', {
        amount_usd: result.amountUsd,
        new_balance: result.newBalance,
      });

      toast.success(`$${result.amountUsd.toFixed(2)} added to your balance`, {
        description: `New balance: $${result.newBalance.toFixed(2)}`,
      });

      const returnTo = localStorage.getItem(RETURN_KEY);
      if (returnTo) {
        localStorage.removeItem(RETURN_KEY);
        void navigate({ to: returnTo });
      } else {
        void navigate({ to: '/sequences' });
      }
    },
  });

  // Fire once on mount with StrictMode double-mount protection via useRef.
  useEffect(() => {
    if (hasTriggered.current) return;
    hasTriggered.current = true;
    mutate({ code });
  }, [code, mutate]);

  if (isError) {
    const errorMessage =
      error instanceof Error ? error.message : 'Failed to redeem code';

    return (
      <CenteredLayout>
        <CardHeader>
          <IconBadge variant="destructive">
            <Gift className="h-7 w-7 text-destructive" />
          </IconBadge>
          <CardTitle className="text-2xl">Redemption failed</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert variant="destructive">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
          <div className="flex flex-col gap-2">
            <Button
              onClick={() => {
                hasTriggered.current = false;
                mutate({ code });
              }}
              disabled={isPending}
            >
              Try again
            </Button>
            <Button variant="ghost" asChild>
              <Link to="/credits" search={{ tab: 'gift-codes' }}>
                Enter code manually
              </Link>
            </Button>
          </div>
        </CardContent>
      </CenteredLayout>
    );
  }

  return (
    <CenteredLayout>
      <CardHeader>
        <IconBadge variant="primary">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
        </IconBadge>
        <CardTitle className="text-2xl">Redeeming your gift…</CardTitle>
        <CardDescription>Adding credits to your account</CardDescription>
      </CardHeader>
      <CardContent>
        <CodeDisplay code={code} />
      </CardContent>
    </CenteredLayout>
  );
}

function GiftLandingPage({ code }: GiftCodeViewProps) {
  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, code);
  }, [code]);

  return (
    <CenteredLayout>
      <CardHeader>
        <IconBadge variant="primary">
          <Gift className="h-7 w-7 text-primary" />
        </IconBadge>
        <CardTitle className="text-2xl">Credits incoming!</CardTitle>
        <CardDescription>
          Sign in to redeem your gift and start creating.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <CodeDisplay code={code} />
        <Button asChild size="lg">
          <Link to="/login" search={{ redirectTo: `/gift/${code}` }}>
            Sign in to redeem
          </Link>
        </Button>
      </CardContent>
    </CenteredLayout>
  );
}
