import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const sectionHeadingVariants = cva("font-semibold", {
  variants: {
    size: {
      small: "text-lg",
      medium: "text-xl",
      large: "text-2xl",
    },
  },
  defaultVariants: {
    size: "large",
  },
});

export interface SectionHeadingProps
  extends React.HTMLAttributes<HTMLHeadingElement>,
    VariantProps<typeof sectionHeadingVariants> {
  as?: "h2" | "h3" | "h4";
}

export const SectionHeading: React.FC<SectionHeadingProps> = ({
  className,
  size,
  as: Component = "h2",
  children,
  ...props
}) => {
  return (
    <Component
      className={cn(sectionHeadingVariants({ size }), className)}
      {...props}
    >
      {children}
    </Component>
  );
};
