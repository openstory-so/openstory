"use client";

import * as React from "react";
import { MotionStep } from "@/components/anonymous-flow/motion-step";
import { ScriptStep } from "@/components/anonymous-flow/script-step";
import { StepNavigation } from "@/components/anonymous-flow/step-navigation";
import { StoryboardStep } from "@/components/anonymous-flow/storyboard-step";
import { PageContainer } from "@/components/layout";
import {
  PageDescription,
  PageHeader,
  PageHeading,
} from "@/components/typography";
import { useAnonymousSession } from "@/hooks/use-anonymous-session";
import { useAnonymousFlowReducer } from "@/reducers/anonymous-flow-reducer";

export const HomePage: React.FC = () => {
  const { anonymousUser, createSession, updateSession } = useAnonymousSession();

  const [state, dispatch] = useAnonymousFlowReducer({
    user: anonymousUser,
  });

  // Initialize anonymous session if needed
  React.useEffect(() => {
    if (!anonymousUser) {
      createSession();
    }
  }, [anonymousUser, createSession]);

  // Sync state to localStorage when it changes
  React.useEffect(() => {
    if (anonymousUser && state.sequence) {
      updateSession({
        sequence: state.sequence,
        currentStep: state.currentStep,
      });
    }
  }, [anonymousUser, state.sequence, state.currentStep, updateSession]);

  const handleStepChange = React.useCallback(
    (step: 1 | 2 | 3) => {
      dispatch({ type: "SET_CURRENT_STEP", payload: step });
    },
    [dispatch],
  );

  const handleNextStep = React.useCallback(() => {
    if (state.currentStep < 3) {
      dispatch({
        type: "SET_CURRENT_STEP",
        payload: (state.currentStep + 1) as 1 | 2 | 3,
      });
    }
  }, [state.currentStep, dispatch]);

  const handlePreviousStep = React.useCallback(() => {
    if (state.currentStep > 1) {
      dispatch({
        type: "SET_CURRENT_STEP",
        payload: (state.currentStep - 1) as 1 | 2 | 3,
      });
    }
  }, [state.currentStep, dispatch]);

  // Show loading state while initializing
  if (!anonymousUser) {
    return (
      <PageContainer maxWidth="narrow" data-testid="homepage-loading">
        <div className="flex items-center justify-center min-h-screen">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer maxWidth="narrow" data-testid="homepage">
      <PageHeader>
        <PageHeading>Create Video Sequence</PageHeading>
        <PageDescription>
          Transform your script into a professional video sequence. Start
          creating immediately - no signup required.
        </PageDescription>
      </PageHeader>

      <StepNavigation
        currentStep={state.currentStep}
        completedSteps={state.completedSteps}
        onStepClick={handleStepChange}
      />

      {state.currentStep === 1 && (
        <ScriptStep state={state} dispatch={dispatch} onNext={handleNextStep} />
      )}

      {state.currentStep === 2 && (
        <StoryboardStep
          state={state}
          dispatch={dispatch}
          onNext={handleNextStep}
          onPrevious={handlePreviousStep}
        />
      )}

      {state.currentStep === 3 && (
        <MotionStep
          state={state}
          dispatch={dispatch}
          onPrevious={handlePreviousStep}
        />
      )}
    </PageContainer>
  );
};

export default HomePage;
