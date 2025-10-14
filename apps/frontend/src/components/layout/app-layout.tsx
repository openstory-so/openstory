import type * as React from "react";
import { cn } from "@/lib/utils";
import { Header } from "./header";

export interface AppLayoutProps extends React.HTMLAttributes<HTMLElement> {}

export const AppLayout: React.FC<AppLayoutProps> = ({
  className,
  children,
  ...props
}) => {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className={cn("", className)} {...props}>
        {children}
      </main>
    </div>
  );
};
