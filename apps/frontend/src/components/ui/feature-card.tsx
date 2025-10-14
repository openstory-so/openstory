import type * as React from "react";
import { cn } from "@/lib/utils";

export interface FeatureCardProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  description: string;
}

export const FeatureCard: React.FC<FeatureCardProps> = ({
  className,
  title,
  description,
  ...props
}) => {
  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="text-muted-foreground">{description}</p>
    </div>
  );
};
