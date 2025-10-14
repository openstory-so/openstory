import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const emptyFolderIconVariants = cva("text-current", {
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
    size: "md",
  },
});

export interface EmptyFolderIconProps
  extends React.SVGProps<SVGSVGElement>,
    VariantProps<typeof emptyFolderIconVariants> {}

export const EmptyFolderIcon: React.FC<EmptyFolderIconProps> = ({
  className,
  size,
  ...props
}) => {
  return (
    <svg
      className={cn(emptyFolderIconVariants({ size }), className)}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden="true"
      role="img"
      {...props}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
      />
    </svg>
  );
};
