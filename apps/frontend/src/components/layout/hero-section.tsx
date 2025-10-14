import type * as React from "react";
import { cn } from "@/lib/utils";

export interface HeroSectionProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export const HeroSection: React.FC<HeroSectionProps> = ({
  className,
  children,
  ...props
}) => {
  return (
    <div
      className={cn("max-w-4xl mx-auto text-center space-y-8", className)}
      {...props}
    >
      <div className="space-y-4">{children}</div>
    </div>
  );
};
