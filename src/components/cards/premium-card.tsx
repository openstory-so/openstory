import type * as React from 'react';

import { cn } from '@/lib/utils';

function PremiumCard({
  className,
  children,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      data-variant="premium"
      className={cn(
        // Define --card-spacing so shadcn CardHeader/Content/Footer
        // (px-(--card-spacing)) still pad when used outside ui/Card.
        'relative flex flex-col gap-6 overflow-hidden rounded-xl border border-border/50 py-0 text-card-foreground shadow-2xl [--card-spacing:--spacing(4)]',
        'bg-gradient-to-br from-card-gradient-from via-card-gradient-via to-card-gradient-to',
        className
      )}
      {...props}
    >
      <div className="absolute top-0 inset-x-0 h-px bg-linear-to-r from-transparent via-card-accent to-transparent" />
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1/2 h-px bg-linear-to-r from-transparent via-primary/20 to-transparent" />
      {children}
    </div>
  );
}

export { PremiumCard };
