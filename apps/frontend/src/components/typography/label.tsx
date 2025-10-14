import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const labelVariants = cva(
  "font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
  {
    variants: {
      size: {
        small: "text-xs",
        medium: "text-sm",
        large: "text-base",
      },
    },
    defaultVariants: {
      size: "medium",
    },
  },
);

export interface LabelProps
  extends React.LabelHTMLAttributes<HTMLLabelElement>,
    VariantProps<typeof labelVariants> {
  required?: boolean;
}

export const Label: React.FC<LabelProps> = ({
  className,
  size,
  children,
  htmlFor,
  required,
  ...props
}) => {
  return (
    <label
      className={cn(labelVariants({ size }), className)}
      htmlFor={htmlFor}
      {...props}
    >
      {children}
      {required && <span className="text-destructive ml-1">*</span>}
    </label>
  );
};
