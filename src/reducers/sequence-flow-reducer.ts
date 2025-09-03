import { useReducer } from "react";
import type { Frame, Style } from "@/types/database";

// Anonymous user type
export interface AnonymousUser {
  id: string;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
}

// Mock sequence type for anonymous flow
export interface MockSequence {
  id: string;
  name: string;
  script: string;
  styleId: string | null;
  frames: Frame[];
  status: "draft" | "generating" | "completed";
  createdAt: string;
  updatedAt: string;
}

// Generation state for tracking async operations
export interface GenerationState {
  isGeneratingStoryboard: boolean;
  isGeneratingMotion: boolean;
  storyboardError: string | null;
  motionError: string | null;
  currentOperation: string | null;
}

// UI state for managing interface
export interface UIState {
  validationErrors: {
    script?: string;
    style?: string;
  };
  showUpgradePrompt: boolean;
  hasUnsavedChanges: boolean;
}

// Main state shape for sequence flow
export interface SequenceFlowState {
  currentStep: 1 | 2 | 3;
  completedSteps: Set<number>;
  user: AnonymousUser | null;
  sequence: MockSequence | null;
  availableStyles: Style[];
  generation: GenerationState;
  ui: UIState;
}

// Action types for the reducer
export type SequenceFlowAction =
  // Step navigation
  | { type: "SET_CURRENT_STEP"; payload: 1 | 2 | 3 }
  | { type: "MARK_STEP_COMPLETED"; payload: number }
  | { type: "RESET_COMPLETED_STEPS" }

  // User management
  | { type: "SET_USER"; payload: AnonymousUser }
  | { type: "CLEAR_USER" }

  // Sequence management
  | { type: "INITIALIZE_SEQUENCE"; payload: { name?: string; script?: string } }
  | { type: "UPDATE_SEQUENCE_NAME"; payload: string }
  | { type: "UPDATE_SEQUENCE_SCRIPT"; payload: string }
  | { type: "SET_SEQUENCE_STYLE"; payload: string | null }
  | { type: "SET_SEQUENCE_STATUS"; payload: MockSequence["status"] }
  | { type: "LOAD_SEQUENCE"; payload: MockSequence }

  // Frame management
  | { type: "SET_FRAMES"; payload: Frame[] }
  | { type: "ADD_FRAME"; payload: Frame }
  | { type: "UPDATE_FRAME"; payload: { id: string; updates: Partial<Frame> } }
  | { type: "REMOVE_FRAME"; payload: string }
  | { type: "REORDER_FRAMES"; payload: { fromIndex: number; toIndex: number } }

  // Style management
  | { type: "SET_AVAILABLE_STYLES"; payload: Style[] }

  // Generation management
  | { type: "START_STORYBOARD_GENERATION" }
  | { type: "COMPLETE_STORYBOARD_GENERATION"; payload: Frame[] }
  | { type: "FAIL_STORYBOARD_GENERATION"; payload: string }
  | { type: "START_MOTION_GENERATION"; payload: string } // frame id
  | {
      type: "COMPLETE_MOTION_GENERATION";
      payload: { frameId: string; videoUrl: string };
    }
  | { type: "FAIL_MOTION_GENERATION"; payload: string }
  | { type: "SET_CURRENT_OPERATION"; payload: string | null }

  // UI management
  | { type: "SET_VALIDATION_ERRORS"; payload: UIState["validationErrors"] }
  | { type: "CLEAR_VALIDATION_ERRORS" }
  | { type: "SET_SHOW_UPGRADE_PROMPT"; payload: boolean }
  | { type: "SET_UNSAVED_CHANGES"; payload: boolean }

  // Bulk operations
  | { type: "RESET_FLOW" }
  | { type: "SYNC_FROM_LOCALSTORAGE"; payload: Partial<SequenceFlowState> };

// Initial state
export const initialSequenceFlowState: SequenceFlowState = {
  currentStep: 1,
  completedSteps: new Set(),
  user: null,
  sequence: null,
  availableStyles: [],
  generation: {
    isGeneratingStoryboard: false,
    isGeneratingMotion: false,
    storyboardError: null,
    motionError: null,
    currentOperation: null,
  },
  ui: {
    validationErrors: {},
    showUpgradePrompt: false,
    hasUnsavedChanges: false,
  },
};

// Helper to create a new mock sequence
function createMockSequence(name?: string, script?: string): MockSequence {
  const now = new Date().toISOString();
  return {
    id: `anon_seq_${Date.now()}`,
    name: name || "Untitled Sequence",
    script: script || "",
    styleId: null,
    frames: [],
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

// Main reducer function
export function sequenceFlowReducer(
  state: SequenceFlowState,
  action: SequenceFlowAction,
): SequenceFlowState {
  switch (action.type) {
    // Step navigation
    case "SET_CURRENT_STEP":
      return {
        ...state,
        currentStep: action.payload,
      };

    case "MARK_STEP_COMPLETED":
      return {
        ...state,
        completedSteps: new Set([...state.completedSteps, action.payload]),
      };

    case "RESET_COMPLETED_STEPS":
      return {
        ...state,
        completedSteps: new Set(),
      };

    // User management
    case "SET_USER":
      return {
        ...state,
        user: action.payload,
      };

    case "CLEAR_USER":
      return {
        ...state,
        user: null,
      };

    // Sequence management
    case "INITIALIZE_SEQUENCE":
      return {
        ...state,
        sequence: createMockSequence(
          action.payload.name,
          action.payload.script,
        ),
        ui: {
          ...state.ui,
          hasUnsavedChanges: false,
        },
      };

    case "UPDATE_SEQUENCE_NAME":
      if (!state.sequence) return state;
      return {
        ...state,
        sequence: {
          ...state.sequence,
          name: action.payload,
          updatedAt: new Date().toISOString(),
        },
        ui: {
          ...state.ui,
          hasUnsavedChanges: true,
          validationErrors: {
            ...state.ui.validationErrors,
            script: undefined, // Clear script error when name changes
          },
        },
      };

    case "UPDATE_SEQUENCE_SCRIPT":
      if (!state.sequence) return state;
      return {
        ...state,
        sequence: {
          ...state.sequence,
          script: action.payload,
          updatedAt: new Date().toISOString(),
        },
        ui: {
          ...state.ui,
          hasUnsavedChanges: true,
          validationErrors: {
            ...state.ui.validationErrors,
            script: undefined, // Clear script error when user types
          },
        },
      };

    case "SET_SEQUENCE_STYLE":
      if (!state.sequence) return state;
      return {
        ...state,
        sequence: {
          ...state.sequence,
          styleId: action.payload,
          updatedAt: new Date().toISOString(),
        },
        ui: {
          ...state.ui,
          hasUnsavedChanges: true,
          validationErrors: {
            ...state.ui.validationErrors,
            style: undefined, // Clear style error when selected
          },
        },
      };

    case "SET_SEQUENCE_STATUS":
      if (!state.sequence) return state;
      return {
        ...state,
        sequence: {
          ...state.sequence,
          status: action.payload,
          updatedAt: new Date().toISOString(),
        },
      };

    case "LOAD_SEQUENCE":
      return {
        ...state,
        sequence: action.payload,
        ui: {
          ...state.ui,
          hasUnsavedChanges: false,
        },
      };

    // Frame management
    case "SET_FRAMES":
      if (!state.sequence) return state;
      return {
        ...state,
        sequence: {
          ...state.sequence,
          frames: action.payload,
          updatedAt: new Date().toISOString(),
        },
      };

    case "ADD_FRAME":
      if (!state.sequence) return state;
      return {
        ...state,
        sequence: {
          ...state.sequence,
          frames: [...state.sequence.frames, action.payload],
          updatedAt: new Date().toISOString(),
        },
      };

    case "UPDATE_FRAME":
      if (!state.sequence) return state;
      return {
        ...state,
        sequence: {
          ...state.sequence,
          frames: state.sequence.frames.map((frame) =>
            frame.id === action.payload.id
              ? { ...frame, ...action.payload.updates }
              : frame,
          ),
          updatedAt: new Date().toISOString(),
        },
      };

    case "REMOVE_FRAME":
      if (!state.sequence) return state;
      return {
        ...state,
        sequence: {
          ...state.sequence,
          frames: state.sequence.frames.filter(
            (frame) => frame.id !== action.payload,
          ),
          updatedAt: new Date().toISOString(),
        },
      };

    case "REORDER_FRAMES": {
      if (!state.sequence) return state;
      const frames = [...state.sequence.frames];
      const [movedFrame] = frames.splice(action.payload.fromIndex, 1);
      frames.splice(action.payload.toIndex, 0, movedFrame);

      // Update order_index for all frames
      const reorderedFrames = frames.map((frame, index) => ({
        ...frame,
        order_index: index + 1,
      }));

      return {
        ...state,
        sequence: {
          ...state.sequence,
          frames: reorderedFrames,
          updatedAt: new Date().toISOString(),
        },
      };
    }

    // Style management
    case "SET_AVAILABLE_STYLES":
      return {
        ...state,
        availableStyles: action.payload,
      };

    // Generation management
    case "START_STORYBOARD_GENERATION":
      return {
        ...state,
        generation: {
          ...state.generation,
          isGeneratingStoryboard: true,
          storyboardError: null,
          currentOperation: "Generating storyboard frames...",
        },
        sequence: state.sequence
          ? {
              ...state.sequence,
              status: "generating",
            }
          : state.sequence,
      };

    case "COMPLETE_STORYBOARD_GENERATION":
      return {
        ...state,
        generation: {
          ...state.generation,
          isGeneratingStoryboard: false,
          storyboardError: null,
          currentOperation: null,
        },
        sequence: state.sequence
          ? {
              ...state.sequence,
              frames: action.payload,
              status: "completed",
              updatedAt: new Date().toISOString(),
            }
          : state.sequence,
      };

    case "FAIL_STORYBOARD_GENERATION":
      return {
        ...state,
        generation: {
          ...state.generation,
          isGeneratingStoryboard: false,
          storyboardError: action.payload,
          currentOperation: null,
        },
        sequence: state.sequence
          ? {
              ...state.sequence,
              status: "draft",
            }
          : state.sequence,
      };

    case "START_MOTION_GENERATION":
      return {
        ...state,
        generation: {
          ...state.generation,
          isGeneratingMotion: true,
          motionError: null,
          currentOperation: "Generating motion video...",
        },
      };

    case "COMPLETE_MOTION_GENERATION":
      if (!state.sequence) return state;
      return {
        ...state,
        generation: {
          ...state.generation,
          isGeneratingMotion: false,
          motionError: null,
          currentOperation: null,
        },
        sequence: {
          ...state.sequence,
          frames: state.sequence.frames.map((frame) =>
            frame.id === action.payload.frameId
              ? { ...frame, video_url: action.payload.videoUrl }
              : frame,
          ),
          updatedAt: new Date().toISOString(),
        },
      };

    case "FAIL_MOTION_GENERATION":
      return {
        ...state,
        generation: {
          ...state.generation,
          isGeneratingMotion: false,
          motionError: action.payload,
          currentOperation: null,
        },
      };

    case "SET_CURRENT_OPERATION":
      return {
        ...state,
        generation: {
          ...state.generation,
          currentOperation: action.payload,
        },
      };

    // UI management
    case "SET_VALIDATION_ERRORS":
      return {
        ...state,
        ui: {
          ...state.ui,
          validationErrors: action.payload,
        },
      };

    case "CLEAR_VALIDATION_ERRORS":
      return {
        ...state,
        ui: {
          ...state.ui,
          validationErrors: {},
        },
      };

    case "SET_SHOW_UPGRADE_PROMPT":
      return {
        ...state,
        ui: {
          ...state.ui,
          showUpgradePrompt: action.payload,
        },
      };

    case "SET_UNSAVED_CHANGES":
      return {
        ...state,
        ui: {
          ...state.ui,
          hasUnsavedChanges: action.payload,
        },
      };

    // Bulk operations
    case "RESET_FLOW":
      return {
        ...initialSequenceFlowState,
        user: state.user, // Preserve user
      };

    case "SYNC_FROM_LOCALSTORAGE":
      return {
        ...state,
        ...action.payload,
      };

    default:
      return state;
  }
}

// Custom hook for using the sequence flow reducer
export function useSequenceFlowReducer(
  initialOverrides?: Partial<SequenceFlowState>,
) {
  const initialState = {
    ...initialSequenceFlowState,
    ...initialOverrides,
  };

  return useReducer(sequenceFlowReducer, initialState);
}

// Validation helpers
export function validateSequenceFlow(
  state: SequenceFlowState,
): UIState["validationErrors"] {
  const errors: UIState["validationErrors"] = {};

  if (!state.sequence) {
    return errors;
  }

  // Script validation
  if (!state.sequence.script.trim()) {
    errors.script = "Script is required to generate storyboard";
  } else if (state.sequence.script.length < 10) {
    errors.script = "Script must be at least 10 characters";
  } else if (state.sequence.script.length > 10000) {
    errors.script = "Script must be 10,000 characters or less";
  }

  // Style validation for storyboard generation
  if (state.currentStep >= 2 && !state.sequence.styleId) {
    errors.style = "Please select a visual style";
  }

  return errors;
}

// Helper to check if current step is valid
export function canProceedToNextStep(state: SequenceFlowState): boolean {
  if (!state.sequence) return false;

  switch (state.currentStep) {
    case 1:
      // Can proceed if script is valid
      return state.sequence.script.trim().length >= 10;
    case 2:
      // Can proceed if storyboard is generated
      return state.sequence.frames.length > 0;
    case 3:
      // Already at final step
      return true;
    default:
      return false;
  }
}

// Helper to check if storyboard can be generated
export function canGenerateStoryboard(state: SequenceFlowState): boolean {
  if (!state.sequence) return false;

  return (
    state.sequence.script.trim().length >= 10 &&
    state.sequence.styleId !== null &&
    !state.generation.isGeneratingStoryboard
  );
}

// Helper to check if motion can be generated for a frame
export function canGenerateMotion(
  state: SequenceFlowState,
  frameId?: string,
): boolean {
  if (!state.sequence || state.generation.isGeneratingMotion) return false;

  if (frameId) {
    const frame = state.sequence.frames.find((f) => f.id === frameId);
    return frame !== undefined && frame.thumbnail_url !== null;
  }

  return state.sequence.frames.length > 0;
}
