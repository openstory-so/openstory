import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const emptyStateVariants = cva(
  "flex flex-col items-center justify-center text-center",
  {
    variants: {
      spacing: {
        compact: "py-8 space-y-3",
        default: "py-16 space-y-4",
        spacious: "py-24 space-y-6",
      },
    },
    defaultVariants: {
      spacing: "default",
    },
  },
);

const iconContainerVariants = cva(
  "rounded-full bg-muted flex items-center justify-center",
  {
    variants: {
      size: {
        small: "p-4",
        medium: "p-6",
        large: "p-8",
      },
    },
    defaultVariants: {
      size: "medium",
    },
  },
);

export interface EmptyStateProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof emptyStateVariants> {
  icon: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  iconSize?: VariantProps<typeof iconContainerVariants>["size"];
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  className,
  spacing,
  icon,
  title,
  description,
  action,
  iconSize = "medium",
  ...props
}) => {
  return (
    <div className={cn(emptyStateVariants({ spacing }), className)} {...props}>
      <div className={cn(iconContainerVariants({ size: iconSize }))}>
        <div className="text-muted-foreground">{icon}</div>
      </div>
      <h2 className="text-2xl font-semibold">{title}</h2>
      {description && (
        <p className="text-muted-foreground max-w-md">{description}</p>
      )}
      {action && action}
    </div>
  );
};
