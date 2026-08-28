import { cn } from '@/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

const pageContainerVariants = cva('container mx-auto px-4', {
  variants: {
    padding: {
      compact: 'py-4',
      default: 'py-8',
      spacious: 'py-6 sm:py-12',
      none: '',
    },
    maxWidth: {
      default: 'max-w-6xl mx-auto space-y-8',
      narrow: 'max-w-4xl mx-auto space-y-8',
      wide: 'max-w-7xl mx-auto space-y-8',
      full: '',
    },
    fullHeight: {
      true: 'flex flex-col h-full overflow-hidden',
      false: '',
    },
  },
  defaultVariants: {
    padding: 'default',
    maxWidth: 'default',
    fullHeight: false,
  },
});

interface PageContainerProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof pageContainerVariants> {}

export const PageContainer: React.FC<PageContainerProps> = ({
  className,
  padding,
  maxWidth,
  fullHeight,
  children,
  ...props
}) => {
  return (
    <div
      className={cn(
        pageContainerVariants({ padding, maxWidth, fullHeight }),
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};
