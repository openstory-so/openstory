/**
 * Admin view of the rate cards the pricing cron holds (#1605): per used
 * endpoint, whether a card exists, whether its worked examples reproduce,
 * its promo end and source hash, and each example's evaluator result.
 * Read-only; auth is inherited from `/admin/route.tsx`.
 */
import { Badge } from '@/ui/shadcn/badge';
import { Skeleton } from '@/ui/shadcn/skeleton';
import {
  listRateCardsFn,
  type RateCardAdminRow,
} from '@/billing/rate-cards.fn';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';

export const Route = createFileRoute('/_app/admin/rate-cards')({
  component: RateCardsPage,
  staticData: { breadcrumb: 'Rate cards' },
});

function RateCardsPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="sr-only">Rate cards</h1>
      <p className="text-muted-foreground">
        Advertised prices as evaluated cards, one per endpoint we use. Verified
        means every worked example on the provider&rsquo;s page reproduces
        within 1%. Pre-flight estimates only — billing uses billed units.
      </p>
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <RateCardsTable />
      </Suspense>
    </div>
  );
}

function RateCardsTable() {
  const { data: rows = [] } = useQuery({
    queryKey: ['admin-rate-cards'],
    queryFn: () => listRateCardsFn(),
  });

  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[48rem] text-left text-sm">
        <thead>
          <tr className="border-b bg-muted/40">
            <th className="px-4 py-3 font-medium">Endpoint</th>
            <th className="px-4 py-3 font-medium">Card</th>
            <th className="px-4 py-3 font-medium">Expires</th>
            <th className="px-4 py-3 font-medium">Source</th>
            <th className="px-4 py-3 font-medium text-right">Examples</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <RateCardRow key={row.endpointId} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RateCardRow({ row }: { row: RateCardAdminRow }) {
  const { card } = row;
  if (!card) {
    return (
      <tr className="border-b align-top last:border-b-0">
        <td className="px-4 py-3 font-mono text-xs">{row.endpointId}</td>
        <td className="px-4 py-3">
          <Badge variant="outline">none</Badge>
        </td>
        <td className="px-4 py-3 text-xs text-muted-foreground">—</td>
        <td className="px-4 py-3 text-xs text-muted-foreground">—</td>
        <td className="px-4 py-3 text-right text-xs text-muted-foreground">
          —
        </td>
      </tr>
    );
  }
  const passed = card.examples.filter((r) => r.ok).length;
  return (
    <tr className="border-b align-top last:border-b-0">
      <td className="px-4 py-3 font-mono text-xs">{row.endpointId}</td>
      <td className="px-4 py-3">
        <Badge variant={card.verified ? 'default' : 'secondary'}>
          {card.verified ? 'verified' : 'unverified'}
        </Badge>
      </td>
      <td className="px-4 py-3 text-xs tabular-nums text-muted-foreground">
        <span className={card.expired ? 'text-destructive' : ''}>
          {card.expiresAt
            ? `${card.expired ? 'expired ' : ''}${card.expiresAt.slice(0, 10)}`
            : '—'}
        </span>
      </td>
      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
        <a
          href={card.sourceUrl}
          target="_blank"
          rel="noreferrer"
          title={`${card.sourceHash} · extracted ${card.extractedAt}`}
          className="underline-offset-4 hover:underline"
        >
          {card.sourceHash.slice(0, 8)}
        </a>
      </td>
      <td className="px-4 py-3 text-right text-xs tabular-nums">
        <details>
          <summary className="cursor-pointer" aria-label="Worked examples">
            {`${passed}/${card.examples.length} pass`}
          </summary>
          <ul className="mt-2 flex flex-col gap-1 text-left font-mono">
            {card.examples.map((r, i) => (
              <li key={i} className={r.ok ? '' : 'text-destructive'}>
                <span>
                  {`${r.ok ? 'ok' : 'FAIL'} $${r.expectedUsd} ${r.params} — ${r.quote}${r.ok ? '' : ` (${r.error ?? ''})`}`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      </td>
    </tr>
  );
}
