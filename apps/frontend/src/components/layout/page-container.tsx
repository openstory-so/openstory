import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const pageContainerVariants = cva("container mx-auto px-4", {
  variants: {
    padding: {
      compact: "py-4",
      default: "py-8",
      spacious: "py-12",
    },
    maxWidth: {
      default: "max-w-6xl mx-auto",
      narrow: "max-w-4xl mx-auto",
      wide: "max-w-7xl mx-auto",
      full: "",
    },
  },
  defaultVariants: {
    padding: "default",
    maxWidth: "default",
  },
});

export interface PageContainerProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof pageContainerVariants> {}

export const PageContainer: React.FC<PageContainerProps> = ({
  className,
  padding,
  maxWidth,
  children,
  ...props
}) => {
  return (
    <div
      className={cn(pageContainerVariants({ padding, maxWidth }), className)}
      {...props}
    >
      <div className={maxWidth !== "full" ? "space-y-8" : ""}>{children}</div>
    </div>
  );
};
