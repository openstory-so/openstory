import type * as React from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  actions?: React.ReactNode;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  className,
  children,
  actions,
  ...props
}) => {
  return (
    <div
      className={cn("flex items-center justify-between", className)}
      {...props}
    >
      <div className="space-y-2">{children}</div>
      {actions && <div>{actions}</div>}
    </div>
  );
};
