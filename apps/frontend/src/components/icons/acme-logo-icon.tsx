import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const acmeLogoIconVariants = cva("text-current", {
  variants: {
    size: {
      xs: "w-4 h-4",
      sm: "w-6 h-6",
      md: "w-8 h-8",
      lg: "w-12 h-12",
      xl: "w-16 h-16",
    },
  },
  defaultVariants: {
    size: "md",
  },
});

export interface AcmeLogoIconProps
  extends React.SVGProps<SVGSVGElement>,
    VariantProps<typeof acmeLogoIconVariants> {}

export const AcmeLogoIcon: React.FC<AcmeLogoIconProps> = ({
  className,
  size,
  ...props
}) => {
  return (
    <svg
      className={cn(acmeLogoIconVariants({ size }), className)}
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      role="img"
      {...props}
    >
      <g fill="none" fillRule="evenodd">
        <path
          d="M10 0h12a10 10 0 0110 10v12a10 10 0 01-10 10H10A10 10 0 010 22V10A10 10 0 0110 0z"
          fill="#FFF"
        />
        <path
          d="M5.3 10.6l10.4 6v11.1l-10.4-6v-11zm11.4-6.2l9.7 5.5-9.7 5.6V4.4z"
          fill="#555AB9"
        />
        <path
          d="M27.2 10.6v11.2l-10.5 6V16.5l10.5-6zM15.7 4.4v11L6 10l9.7-5.5z"
          fill="#91BAF8"
        />
      </g>
    </svg>
  );
};
