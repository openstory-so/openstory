import type * as React from "react";
import { cn } from "@/lib/utils";

export interface FeatureGridProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export const FeatureGrid: React.FC<FeatureGridProps> = ({
  className,
  children,
  ...props
}) => {
  return (
    <div
      className={cn("grid md:grid-cols-3 gap-8 mt-16", className)}
      {...props}
    >
      {children}
    </div>
  );
};
