/** Settings → Usage: gateway spend by model and by day, from the charge lines. */

import { getGatewayUsageFn } from '@/billing/billing.fn';
import {
  GATEWAY_USAGE_DAYS,
  type GatewayUsageDays,
} from '@/billing/gateway-usage';
import { Button } from '@/ui/shadcn/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/ui/shadcn/card';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Suspense } from 'react';

export function GatewayUsage({ days }: { days: GatewayUsageDays }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Model spend</CardTitle>
        <CardDescription>
          What models cost this organization, from each charge.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <nav aria-label="Range" className="flex gap-2">
          {GATEWAY_USAGE_DAYS.map((d) => (
            <Button
              key={d}
              asChild
              size="sm"
              variant={d === days ? 'secondary' : 'ghost'}
            >
              <Link
                to="/settings/usage"
                search={{ days: d }}
                aria-current={d === days ? 'page' : undefined}
              >
                {d} days
              </Link>
            </Button>
          ))}
        </nav>
        <Suspense
          fallback={
            <div className="flex flex-col gap-3">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          }
        >
          <UsageTables days={days} />
        </Suspense>
      </CardContent>
    </Card>
  );
}

type Line = { total: string; platformFee: string | null };

function Amount({ line }: { line: Line }) {
  return (
    <td className="py-1 text-right tabular-nums">
      {line.total}
      {line.platformFee ? (
        <span className="block text-xs text-muted-foreground">
          Platform fee {line.platformFee}
        </span>
      ) : null}
    </td>
  );
}

function UsageTables({ days }: { days: GatewayUsageDays }) {
  const { data } = useSuspenseQuery({
    queryKey: ['gateway-usage', days],
    queryFn: () => getGatewayUsageFn({ data: { days } }),
  });

  if (data.byModel.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No model spend in the last {days} days.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm">
        <span className="text-2xl font-semibold tabular-nums">
          {data.total}
        </span>{' '}
        <span className="text-muted-foreground">in {days} days</span>
        {data.platformFee ? (
          <span className="block text-xs text-muted-foreground tabular-nums">
            Includes platform fee {data.platformFee}
          </span>
        ) : null}
      </p>
      <table className="w-full text-sm">
        <caption className="text-left text-sm font-medium">By model</caption>
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 text-left font-normal">Model</th>
            <th className="py-1 text-right font-normal">Calls</th>
            <th className="py-1 text-right font-normal">Spend</th>
          </tr>
        </thead>
        <tbody>
          {data.byModel.map((row) => (
            <tr key={row.model} className="border-t align-top">
              <td className="break-all py-1">{row.model}</td>
              <td className="py-1 text-right tabular-nums">{row.calls}</td>
              <Amount line={row} />
            </tr>
          ))}
        </tbody>
      </table>
      <table className="w-full text-sm">
        <caption className="text-left text-sm font-medium">
          By day (UTC)
        </caption>
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 text-left font-normal">Day</th>
            <th className="py-1 text-right font-normal">Spend</th>
          </tr>
        </thead>
        <tbody>
          {data.byDay.map((row) => (
            <tr key={row.day} className="border-t align-top">
              <td className="py-1 tabular-nums">{row.day}</td>
              <Amount line={row} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
