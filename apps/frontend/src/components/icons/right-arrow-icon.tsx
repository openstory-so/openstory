import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const rightArrowIconVariants = cva("text-current", {
  variants: {
    size: {
      xs: "w-3 h-3",
      sm: "w-4 h-4",
      md: "w-6 h-6",
      lg: "w-8 h-8",
      xl: "w-12 h-12",
    },
  },
  defaultVariants: {
    size: "sm",
  },
});

export interface RightArrowIconProps
  extends React.SVGProps<SVGSVGElement>,
    VariantProps<typeof rightArrowIconVariants> {}

export const RightArrowIcon: React.FC<RightArrowIconProps> = ({
  className,
  size,
  ...props
}) => {
  return (
    <svg
      className={cn(rightArrowIconVariants({ size }), className)}
      fill="currentColor"
      viewBox="0 0 14 14"
      aria-hidden="true"
      role="img"
      {...props}
    >
      <path d="m11.1 7.35-5.5 5.5a.5.5 0 0 1-.7-.7L10.04 7 4.9 1.85a.5.5 0 1 1 .7-.7l5.5 5.5c.2.2.2.5 0 .7Z" />
    </svg>
  );
};
