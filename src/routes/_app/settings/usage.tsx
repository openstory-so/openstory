/** Settings → Usage: this organization's gateway spend by model and by day. */

import { gatewayUsageDaysSchema } from '@/billing/gateway-usage';
import { GatewayUsage } from '@/billing/ui/gateway-usage';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const searchSchema = z.object({
  days: gatewayUsageDaysSchema.catch(30).default(30),
});

export const Route = createFileRoute('/_app/settings/usage')({
  validateSearch: searchSchema,
  component: UsagePage,
  staticData: { breadcrumb: 'Usage' },
});

function UsagePage() {
  const { days } = Route.useSearch();
  return <GatewayUsage days={days} />;
}
