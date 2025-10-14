import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const pageDescriptionVariants = cva("text-muted-foreground", {
  variants: {
    size: {
      default: "text-base",
      large: "text-xl",
    },
    align: {
      left: "text-left",
      center: "text-center",
      right: "text-right",
    },
    maxWidth: {
      none: "",
      narrow: "max-w-2xl mx-auto",
      wide: "max-w-4xl mx-auto",
    },
  },
  defaultVariants: {
    size: "default",
    align: "left",
    maxWidth: "none",
  },
});

export interface PageDescriptionProps
  extends React.HTMLAttributes<HTMLParagraphElement>,
    VariantProps<typeof pageDescriptionVariants> {}

export const PageDescription: React.FC<PageDescriptionProps> = ({
  className,
  size,
  align,
  maxWidth,
  children,
  ...props
}) => {
  return (
    <p
      className={cn(
        pageDescriptionVariants({ size, align, maxWidth }),
        className,
      )}
      {...props}
    >
      {children}
    </p>
  );
};
