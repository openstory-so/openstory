import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const ArrowIconVariants = cva("text-current", {
  variants: {
    size: {
      xs: "w-3 h-3",
      sm: "w-4 h-4",
      md: "w-6 h-6",
      lg: "w-8 h-8",
      xl: "w-12 h-12",
    },
    direction: {
      right: "rotate-0",
      left: "rotate-180",
      up: "-rotate-90",
      down: "rotate-90",
    },
  },
  defaultVariants: {
    size: "sm",
  },
});

export interface ArrowIconProps
  extends Omit<React.SVGProps<SVGSVGElement>, "direction">,
    VariantProps<typeof ArrowIconVariants> {}

export const ArrowIcon: React.FC<ArrowIconProps> = ({
  className,
  direction,
  size,
  ...props
}) => {
  return (
    <svg
      width="12"
      height="13"
      viewBox="0 0 12 13"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn(ArrowIconVariants({ direction, size, className }))}
      role="img"
      aria-label="Arrow icon"
      {...props}
    >
      <path
        d="M11.8061 5.92744C11.9303 6.07458 12 6.27334 12 6.48048C12 6.68762 11.9303 6.88638 11.8061 7.03352L7.36103 12.2509C7.29999 12.3278 7.22638 12.3895 7.14459 12.4323C7.0628 12.475 6.97451 12.498 6.88498 12.4999C6.79546 12.5017 6.70653 12.4824 6.62351 12.443C6.54048 12.4037 6.46507 12.3451 6.40175 12.2708C6.33844 12.1965 6.28852 12.1079 6.25499 12.0105C6.22146 11.913 6.20499 11.8087 6.20657 11.7036C6.20815 11.5985 6.22774 11.4949 6.26418 11.3989C6.30063 11.3029 6.35317 11.2165 6.41868 11.1448L9.72581 7.26309L0.66676 7.26309C0.489924 7.26309 0.320331 7.18063 0.19529 7.03387C0.0702477 6.8871 0 6.68804 0 6.48048C0 6.27292 0.0702477 6.07386 0.19529 5.92709C0.320331 5.78032 0.489924 5.69787 0.66676 5.69787L9.72581 5.69787L6.41868 1.81613C6.3009 1.66777 6.23678 1.47155 6.23983 1.2688C6.24288 1.06605 6.31285 0.872608 6.43502 0.729221C6.55718 0.585833 6.72199 0.503699 6.89472 0.500122C7.06746 0.496545 7.23464 0.571803 7.36103 0.710043L11.8061 5.92744Z"
        fill="black"
      />
    </svg>
  );
};
