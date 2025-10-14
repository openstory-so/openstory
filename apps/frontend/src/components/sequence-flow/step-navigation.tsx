import { useRouter } from "next/navigation";
import type * as React from "react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface StepNavigationProps {
  sequenceId: string;
  currentStep: 1 | 2;
  completedSteps: Set<number>;
  className?: string;
}

interface StepConfig {
  number: 1 | 2;
  title: string;
  description: string;
}

const STEPS: StepConfig[] = [
  {
    number: 1,
    title: "Script",
    description: "Write your story",
  },
  {
    number: 2,
    title: "Storyboard & Motion",
    description: "Generate frames and add motion",
  },
];

export const StepNavigation: React.FC<StepNavigationProps> = ({
  sequenceId,
  currentStep,
  completedSteps,
  className,
}) => {
  const router = useRouter();
  const getStepStatus = (
    stepNumber: number,
  ): "current" | "completed" | "upcoming" => {
    if (stepNumber === currentStep) return "current";
    if (completedSteps.has(stepNumber)) return "completed";
    return "upcoming";
  };

  const isStepClickable = (stepNumber: number): boolean => {
    // Allow clicking on current step or completed steps
    // Also allow clicking on the next step if previous ones are completed
    if (stepNumber === currentStep) return true;
    if (completedSteps.has(stepNumber)) return true;

    // Allow clicking on step 2 if step 1 is completed
    if (stepNumber === 2 && completedSteps.has(1)) return true;

    return false;
  };

  const handleStepClick = useCallback(
    (step: 1 | 2) => {
      if (step === currentStep) return;
      switch (step) {
        case 1:
          router.push(`/sequences/${sequenceId}/script`);
          break;
        case 2:
          if (completedSteps.has(1)) {
            router.push(`/sequences/${sequenceId}/storyboard`);
          }
          break;
      }
    },
    [sequenceId, router, completedSteps, currentStep],
  );

  return (
    <nav
      className={cn("w-full", className)}
      aria-label="Progress steps"
      data-testid="step-navigation"
    >
      <ol className="flex items-center justify-between w-full">
        {STEPS.map((step, index) => {
          const status = getStepStatus(step.number);
          const isClickable = isStepClickable(step.number);
          const isLast = index === STEPS.length - 1;

          return (
            <li key={step.number} className="flex items-center flex-1">
              <div className="flex items-center">
                <Button
                  variant="ghost"
                  onClick={() => isClickable && handleStepClick(step.number)}
                  disabled={!isClickable}
                  className={cn(
                    "flex flex-col items-center p-2 h-auto min-w-0 gap-1",
                    "text-center transition-all duration-200",
                    {
                      "text-primary": status === "current",
                      "text-muted-foreground hover:text-foreground":
                        status === "upcoming",
                      "text-muted-foreground": status === "completed",
                      "cursor-pointer": isClickable,
                      "cursor-default": !isClickable,
                    },
                  )}
                  data-testid={`step-${step.number}-button`}
                >
                  <div
                    className={cn(
                      "flex items-center justify-center w-8 h-8 rounded-full",
                      "border-2 text-sm font-medium transition-all duration-200",
                      {
                        "bg-primary border-primary text-primary-foreground":
                          status === "current",
                        "bg-muted border-muted-foreground text-muted-foreground":
                          status === "upcoming",
                        "bg-primary/10 border-primary text-primary":
                          status === "completed",
                      },
                    )}
                  >
                    {status === "completed" ? (
                      <svg
                        className="w-4 h-4"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                        aria-hidden="true"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    ) : (
                      step.number
                    )}
                  </div>

                  <div className="min-w-0 flex flex-col items-center">
                    <span className="text-sm font-medium truncate w-full">
                      {step.title}
                    </span>
                    <span className="text-xs text-muted-foreground truncate w-full">
                      {step.description}
                    </span>
                  </div>
                </Button>
              </div>

              {/* Connector line */}
              {!isLast && (
                <div
                  className={cn(
                    "flex-1 h-px mx-4 transition-colors duration-200",
                    {
                      "bg-primary": completedSteps.has(step.number),
                      "bg-muted": !completedSteps.has(step.number),
                    },
                  )}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};
