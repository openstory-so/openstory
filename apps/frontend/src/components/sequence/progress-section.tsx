import type * as React from "react";
import { Progress } from "@/components/ui/progress";

interface ProgressData {
  completed: number;
  total: number;
  percentage: number;
}

interface ProgressSectionProps {
  progress: ProgressData;
}

export const ProgressSection: React.FC<ProgressSectionProps> = ({
  progress,
}) => {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Setup Progress</span>
        <span className="font-medium">
          {progress.completed} of {progress.total} steps
        </span>
      </div>
      <Progress value={progress.percentage} data-testid="progress-bar" />
    </div>
  );
};
