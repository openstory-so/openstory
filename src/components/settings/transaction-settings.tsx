/**
 * Transaction Settings Component
 * Full transaction history with infinite scroll
 */

import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { getTransactionsFn } from '@/functions/billing';
import { BILLING_TRANSACTIONS_KEY } from '@/hooks/use-billing-balance-realtime';
import { useInfiniteQuery } from '@tanstack/react-query';
import { CreditCard, ExternalLink } from 'lucide-react';
import React from 'react';

type TransactionData = {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  description: string | null;
  metadata?: { receiptUrl?: string } | null;
  createdAt: string | Date;
};

const PAGE_SIZE = 50;

function TransactionRow({ tx }: { tx: TransactionData }) {
  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">
          {tx.description ?? tx.type}
        </p>
        <p className="text-xs text-muted-foreground">
          {new Date(tx.createdAt).toLocaleString()}
        </p>
      </div>
      <div className="flex items-center gap-2 ml-4">
        <span
          className={`text-sm font-semibold tabular-nums ${
            tx.amount > 0
              ? 'text-green-600 dark:text-green-400'
              : 'text-red-600 dark:text-red-400'
          }`}
        >
          {`${tx.amount > 0 ? '+' : ''}${tx.amount.toFixed(2)}`}
        </span>
        <Badge variant="outline" className="text-xs">
          ${tx.balanceAfter.toFixed(2)}
        </Badge>
        {tx.metadata?.receiptUrl && (
          <a
            href={tx.metadata.receiptUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground"
            aria-label="View receipt"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        )}
      </div>
    </div>
  );
}

export function TransactionSettings() {
  const sentinelRef = React.useRef<HTMLDivElement>(null);

  const {
    status,
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: [...BILLING_TRANSACTIONS_KEY],
    queryFn: ({ pageParam }) =>
      getTransactionsFn({
        data: { limit: PAGE_SIZE, offset: pageParam },
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.flatMap((p) => p.transactions).length;
      return loaded < lastPage.total ? loaded : undefined;
    },
    staleTime: 5 * 60 * 1000,
  });

  const allTransactions = data?.pages.flatMap((p) => p.transactions) ?? [];

  React.useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p className="text-sm text-destructive">
          {error instanceof Error
            ? error.message
            : 'Failed to load transactions'}
        </p>
      )}

      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
          <CreditCard className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Transaction History</h2>
          <p className="text-sm text-muted-foreground">All credit activity</p>
        </div>
      </div>

      {status === 'pending' ? (
        <div className="space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : allTransactions.length === 0 ? (
        <p className="text-center text-muted-foreground py-4">
          No transactions yet
        </p>
      ) : (
        <div className="space-y-2">
          {allTransactions.map((tx) => (
            <TransactionRow key={tx.id} tx={tx} />
          ))}
          <div ref={sentinelRef}>
            {isFetchingNextPage && (
              <p className="text-center text-sm text-muted-foreground py-2">
                Loading more…
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
