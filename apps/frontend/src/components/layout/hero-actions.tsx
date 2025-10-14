import type * as React from "react";
import { cn } from "@/lib/utils";

export interface HeroActionsProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export const HeroActions: React.FC<HeroActionsProps> = ({
  className,
  children,
  ...props
}) => {
  return (
    <div
      className={cn(
        "flex flex-col sm:flex-row gap-4 justify-center",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
};
