/**
 * Credits Page
 * Balance, transactions, and gift codes in a single tabbed view
 */

import { RouteErrorFallback } from '@/ui/error/route-error-fallback';
import { BillingSettings } from '@/ui/settings/billing-settings';
import { GiftCodeSettings } from '@/ui/settings/gift-code-settings';
import { TransactionSettings } from '@/ui/settings/transaction-settings';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/shadcn/tabs';
import { requireSessionOrRedirect } from '@/platform/ui/auth/route-guards';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Gift, Receipt, Wallet } from 'lucide-react';
import { z } from 'zod';

const tabValues = ['balance', 'transactions', 'gift-codes'] as const;

const searchSchema = z.object({
  tab: z.enum(tabValues).optional().default('balance'),
  success: z.boolean().optional(),
  canceled: z.boolean().optional(),
  session_id: z.string().max(256).optional(),
  card_saved: z.boolean().optional(),
});

export const Route = createFileRoute('/_app/credits')({
  validateSearch: searchSchema,
  component: CreditsPage,
  beforeLoad: async ({ context: { queryClient }, location }) => {
    await requireSessionOrRedirect(queryClient, location.href);
  },
  staticData: { breadcrumb: 'Credits' },
  errorComponent: (props) => (
    <RouteErrorFallback {...props} heading="Credits error" />
  ),
});

const tabs = [
  {
    value: 'balance' as const,
    label: 'Balance',
    icon: <Wallet className="h-4 w-4" />,
  },
  {
    value: 'transactions' as const,
    label: 'Transactions',
    icon: <Receipt className="h-4 w-4" />,
  },
  {
    value: 'gift-codes' as const,
    label: 'Gift Codes',
    icon: <Gift className="h-4 w-4" />,
  },
];

function CreditsPage() {
  const {
    tab,
    success,
    canceled,
    session_id: sessionId,
    card_saved: cardSaved,
  } = Route.useSearch();
  const navigate = useNavigate();

  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const parsed = z.enum(tabValues).safeParse(value);
          if (parsed.success) {
            void navigate({ to: '/credits', search: { tab: parsed.data } });
          }
        }}
      >
        <TabsList className="mb-6 w-full justify-start">
          {tabs.map((t) => (
            <TabsTrigger
              key={t.value}
              value={t.value}
              className="flex items-center gap-2"
            >
              {t.icon}
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="balance">
          <BillingSettings
            success={success}
            canceled={canceled}
            sessionId={sessionId}
            cardSaved={cardSaved}
          />
        </TabsContent>
        <TabsContent value="transactions">
          <TransactionSettings />
        </TabsContent>
        <TabsContent value="gift-codes">
          <GiftCodeSettings />
        </TabsContent>
      </Tabs>
    </div>
  );
}
