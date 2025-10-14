import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const pageHeadingVariants = cva("font-bold tracking-tight", {
  variants: {
    size: {
      small: "text-2xl",
      medium: "text-3xl",
      large: "text-4xl",
      hero: "text-4xl sm:text-6xl",
    },
  },
  defaultVariants: {
    size: "medium",
  },
});

export interface PageHeadingProps
  extends React.HTMLAttributes<HTMLHeadingElement>,
    VariantProps<typeof pageHeadingVariants> {
  as?: "h1" | "h2" | "h3";
}

export const PageHeading: React.FC<PageHeadingProps> = ({
  className,
  size,
  as: Component = "h1",
  children,
  ...props
}) => {
  return (
    <Component
      className={cn(pageHeadingVariants({ size }), className)}
      {...props}
    >
      {children}
    </Component>
  );
};
