import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const viewportIconVariants = cva("text-current", {
  variants: {
    size: {
      xs: "w-2 h-2",
      sm: "w-4 h-4",
      md: "w-5 h-5",
      lg: "w-6 h-6",
      xl: "w-8 h-8",
    },
  },
  defaultVariants: {
    size: "sm",
  },
});

export interface ViewportIconProps
  extends React.SVGProps<SVGSVGElement>,
    VariantProps<typeof viewportIconVariants> {}

export const ViewportIcon: React.FC<ViewportIconProps> = ({
  className,
  size,
  ...props
}) => {
  return (
    <svg
      className={cn(viewportIconVariants({ size }), className)}
      viewBox="0 0 12 12"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      role="img"
      {...props}
    >
      <g fill="none" fillRule="evenodd">
        <path
          d="M1.5 5.2h4.8c.3 0 .5.2.5.4v5.1c-.1.2-.3.3-.4.3H1.4a.5.5 0 01-.5-.4V5.7c0-.3.2-.5.5-.5zm0-2.1h6.9c.3 0 .5.2.5.4v7a.5.5 0 01-1 0V4H1.5a.5.5 0 010-1zm0-2.1h9c.3 0 .5.2.5.4v9.1a.5.5 0 01-1 0V2H1.5a.5.5 0 010-1zm4.3 5.2H2V10h3.8V6.2z"
          id="a"
          fill="currentColor"
        />
      </g>
    </svg>
  );
};
