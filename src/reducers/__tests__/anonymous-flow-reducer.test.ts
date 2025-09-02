import { beforeEach, describe, expect, it } from "vitest";
import type { Frame } from "@/types/database";
import {
  type AnonymousFlowState,
  type AnonymousUser,
  anonymousFlowReducer,
  canGenerateMotion,
  canGenerateStoryboard,
  canProceedToNextStep,
  initialAnonymousFlowState,
  type MockSequence,
  validateAnonymousFlow,
} from "../anonymous-flow-reducer";

describe("anonymousFlowReducer", () => {
  const mockUser: AnonymousUser = {
    id: "anon_123",
    sessionId: "session_123",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };

  const mockSequence: MockSequence = {
    id: "seq_123",
    name: "Test Sequence",
    script: "A test script for testing",
    styleId: "style_123",
    frames: [],
    status: "draft",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockFrame: Frame = {
    id: "frame_123",
    sequence_id: "seq_123",
    order_index: 1,
    description: "Test frame",
    thumbnail_url: "https://example.com/thumb.jpg",
    video_url: null,
    duration_ms: 5000,
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  describe("Step Navigation", () => {
    it("should set current step", () => {
      const state = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "SET_CURRENT_STEP",
        payload: 2,
      });
      expect(state.currentStep).toBe(2);
    });

    it("should mark step as completed", () => {
      const state = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "MARK_STEP_COMPLETED",
        payload: 1,
      });
      expect(state.completedSteps.has(1)).toBe(true);
    });

    it("should reset completed steps", () => {
      let state = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "MARK_STEP_COMPLETED",
        payload: 1,
      });
      state = anonymousFlowReducer(state, {
        type: "MARK_STEP_COMPLETED",
        payload: 2,
      });
      state = anonymousFlowReducer(state, {
        type: "RESET_COMPLETED_STEPS",
      });
      expect(state.completedSteps.size).toBe(0);
    });
  });

  describe("User Management", () => {
    it("should set user", () => {
      const state = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "SET_USER",
        payload: mockUser,
      });
      expect(state.user).toEqual(mockUser);
    });

    it("should clear user", () => {
      let state = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "SET_USER",
        payload: mockUser,
      });
      state = anonymousFlowReducer(state, {
        type: "CLEAR_USER",
      });
      expect(state.user).toBeNull();
    });
  });

  describe("Sequence Management", () => {
    it("should initialize sequence with defaults", () => {
      const state = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "INITIALIZE_SEQUENCE",
        payload: {},
      });
      expect(state.sequence).toBeDefined();
      expect(state.sequence?.name).toBe("Untitled Sequence");
      expect(state.sequence?.script).toBe("");
      expect(state.sequence?.styleId).toBeNull();
    });

    it("should initialize sequence with custom values", () => {
      const state = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "INITIALIZE_SEQUENCE",
        payload: { name: "My Story", script: "Once upon a time..." },
      });
      expect(state.sequence?.name).toBe("My Story");
      expect(state.sequence?.script).toBe("Once upon a time...");
    });

    it("should update sequence name", () => {
      let state = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "INITIALIZE_SEQUENCE",
        payload: {},
      });
      state = anonymousFlowReducer(state, {
        type: "UPDATE_SEQUENCE_NAME",
        payload: "New Name",
      });
      expect(state.sequence?.name).toBe("New Name");
      expect(state.ui.hasUnsavedChanges).toBe(true);
    });

    it("should update sequence script", () => {
      let state = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "INITIALIZE_SEQUENCE",
        payload: {},
      });
      state = anonymousFlowReducer(state, {
        type: "UPDATE_SEQUENCE_SCRIPT",
        payload: "Updated script content",
      });
      expect(state.sequence?.script).toBe("Updated script content");
      expect(state.ui.hasUnsavedChanges).toBe(true);
    });

    it("should set sequence style", () => {
      let state = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "INITIALIZE_SEQUENCE",
        payload: {},
      });
      state = anonymousFlowReducer(state, {
        type: "SET_SEQUENCE_STYLE",
        payload: "style_456",
      });
      expect(state.sequence?.styleId).toBe("style_456");
      expect(state.ui.hasUnsavedChanges).toBe(true);
    });

    it("should load existing sequence", () => {
      const state = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "LOAD_SEQUENCE",
        payload: mockSequence,
      });
      expect(state.sequence).toEqual(mockSequence);
      expect(state.ui.hasUnsavedChanges).toBe(false);
    });
  });

  describe("Frame Management", () => {
    let stateWithSequence: AnonymousFlowState;

    beforeEach(() => {
      stateWithSequence = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "LOAD_SEQUENCE",
        payload: mockSequence,
      });
    });

    it("should set frames", () => {
      const frames = [mockFrame];
      const state = anonymousFlowReducer(stateWithSequence, {
        type: "SET_FRAMES",
        payload: frames,
      });
      expect(state.sequence?.frames).toEqual(frames);
    });

    it("should add frame", () => {
      const state = anonymousFlowReducer(stateWithSequence, {
        type: "ADD_FRAME",
        payload: mockFrame,
      });
      expect(state.sequence?.frames).toContainEqual(mockFrame);
    });

    it("should update frame", () => {
      let state = anonymousFlowReducer(stateWithSequence, {
        type: "ADD_FRAME",
        payload: mockFrame,
      });
      state = anonymousFlowReducer(state, {
        type: "UPDATE_FRAME",
        payload: {
          id: mockFrame.id,
          updates: { description: "Updated description" },
        },
      });
      expect(state.sequence?.frames[0].description).toBe("Updated description");
    });

    it("should remove frame", () => {
      let state = anonymousFlowReducer(stateWithSequence, {
        type: "ADD_FRAME",
        payload: mockFrame,
      });
      state = anonymousFlowReducer(state, {
        type: "REMOVE_FRAME",
        payload: mockFrame.id,
      });
      expect(state.sequence?.frames).toHaveLength(0);
    });

    it("should reorder frames", () => {
      const frame1 = { ...mockFrame, id: "frame_1", order_index: 1 };
      const frame2 = { ...mockFrame, id: "frame_2", order_index: 2 };
      const frame3 = { ...mockFrame, id: "frame_3", order_index: 3 };

      let state = anonymousFlowReducer(stateWithSequence, {
        type: "SET_FRAMES",
        payload: [frame1, frame2, frame3],
      });

      state = anonymousFlowReducer(state, {
        type: "REORDER_FRAMES",
        payload: { fromIndex: 2, toIndex: 0 },
      });

      expect(state.sequence?.frames[0].id).toBe("frame_3");
      expect(state.sequence?.frames[0].order_index).toBe(1);
      expect(state.sequence?.frames[1].id).toBe("frame_1");
      expect(state.sequence?.frames[1].order_index).toBe(2);
      expect(state.sequence?.frames[2].id).toBe("frame_2");
      expect(state.sequence?.frames[2].order_index).toBe(3);
    });
  });

  describe("Generation Management", () => {
    let stateWithSequence: AnonymousFlowState;

    beforeEach(() => {
      stateWithSequence = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "LOAD_SEQUENCE",
        payload: mockSequence,
      });
    });

    it("should start storyboard generation", () => {
      const state = anonymousFlowReducer(stateWithSequence, {
        type: "START_STORYBOARD_GENERATION",
      });
      expect(state.generation.isGeneratingStoryboard).toBe(true);
      expect(state.generation.storyboardError).toBeNull();
      expect(state.generation.currentOperation).toBe(
        "Generating storyboard frames...",
      );
      expect(state.sequence?.status).toBe("generating");
    });

    it("should complete storyboard generation", () => {
      const frames = [mockFrame];
      const state = anonymousFlowReducer(stateWithSequence, {
        type: "COMPLETE_STORYBOARD_GENERATION",
        payload: frames,
      });
      expect(state.generation.isGeneratingStoryboard).toBe(false);
      expect(state.sequence?.frames).toEqual(frames);
      expect(state.sequence?.status).toBe("completed");
    });

    it("should handle storyboard generation failure", () => {
      const state = anonymousFlowReducer(stateWithSequence, {
        type: "FAIL_STORYBOARD_GENERATION",
        payload: "Generation failed",
      });
      expect(state.generation.isGeneratingStoryboard).toBe(false);
      expect(state.generation.storyboardError).toBe("Generation failed");
      expect(state.sequence?.status).toBe("draft");
    });

    it("should start motion generation", () => {
      const state = anonymousFlowReducer(stateWithSequence, {
        type: "START_MOTION_GENERATION",
        payload: "frame_123",
      });
      expect(state.generation.isGeneratingMotion).toBe(true);
      expect(state.generation.motionError).toBeNull();
    });

    it("should complete motion generation", () => {
      let state = anonymousFlowReducer(stateWithSequence, {
        type: "ADD_FRAME",
        payload: mockFrame,
      });
      state = anonymousFlowReducer(state, {
        type: "COMPLETE_MOTION_GENERATION",
        payload: {
          frameId: mockFrame.id,
          videoUrl: "https://example.com/video.mp4",
        },
      });
      expect(state.generation.isGeneratingMotion).toBe(false);
      expect(state.sequence?.frames[0].video_url).toBe(
        "https://example.com/video.mp4",
      );
    });
  });

  describe("UI Management", () => {
    it("should set validation errors", () => {
      const errors = { script: "Script too short", style: "Style required" };
      const state = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "SET_VALIDATION_ERRORS",
        payload: errors,
      });
      expect(state.ui.validationErrors).toEqual(errors);
    });

    it("should clear validation errors", () => {
      let state = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "SET_VALIDATION_ERRORS",
        payload: { script: "Error" },
      });
      state = anonymousFlowReducer(state, {
        type: "CLEAR_VALIDATION_ERRORS",
      });
      expect(state.ui.validationErrors).toEqual({});
    });

    it("should set upgrade prompt visibility", () => {
      const state = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "SET_SHOW_UPGRADE_PROMPT",
        payload: true,
      });
      expect(state.ui.showUpgradePrompt).toBe(true);
    });
  });

  describe("Bulk Operations", () => {
    it("should reset flow but preserve user", () => {
      let state = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "SET_USER",
        payload: mockUser,
      });
      state = anonymousFlowReducer(state, {
        type: "LOAD_SEQUENCE",
        payload: mockSequence,
      });
      state = anonymousFlowReducer(state, {
        type: "RESET_FLOW",
      });
      expect(state.user).toEqual(mockUser);
      expect(state.sequence).toBeNull();
      expect(state.currentStep).toBe(1);
    });

    it("should sync from localStorage", () => {
      const partialState = {
        currentStep: 2 as const,
        sequence: mockSequence,
      };
      const state = anonymousFlowReducer(initialAnonymousFlowState, {
        type: "SYNC_FROM_LOCALSTORAGE",
        payload: partialState,
      });
      expect(state.currentStep).toBe(2);
      expect(state.sequence).toEqual(mockSequence);
    });
  });
});

describe("Validation Helpers", () => {
  describe("validateAnonymousFlow", () => {
    it("should return no errors for valid state", () => {
      const state: AnonymousFlowState = {
        ...initialAnonymousFlowState,
        currentStep: 2,
        sequence: {
          id: "seq_123",
          name: "Test",
          script: "This is a valid script with enough content",
          styleId: "style_123",
          frames: [],
          status: "draft",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      const errors = validateAnonymousFlow(state);
      expect(errors).toEqual({});
    });

    it("should validate empty script", () => {
      const state: AnonymousFlowState = {
        ...initialAnonymousFlowState,
        sequence: {
          id: "seq_123",
          name: "Test",
          script: "",
          styleId: null,
          frames: [],
          status: "draft",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      const errors = validateAnonymousFlow(state);
      expect(errors.script).toBe("Script is required to generate storyboard");
    });

    it("should validate short script", () => {
      const state: AnonymousFlowState = {
        ...initialAnonymousFlowState,
        sequence: {
          id: "seq_123",
          name: "Test",
          script: "Too short",
          styleId: null,
          frames: [],
          status: "draft",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      const errors = validateAnonymousFlow(state);
      expect(errors.script).toBe("Script must be at least 10 characters");
    });

    it("should validate missing style on step 2", () => {
      const state: AnonymousFlowState = {
        ...initialAnonymousFlowState,
        currentStep: 2,
        sequence: {
          id: "seq_123",
          name: "Test",
          script: "This is a valid script",
          styleId: null,
          frames: [],
          status: "draft",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      const errors = validateAnonymousFlow(state);
      expect(errors.style).toBe("Please select a visual style");
    });
  });

  describe("canProceedToNextStep", () => {
    it("should allow proceeding from step 1 with valid script", () => {
      const state: AnonymousFlowState = {
        ...initialAnonymousFlowState,
        currentStep: 1,
        sequence: {
          id: "seq_123",
          name: "Test",
          script: "This is a valid script with enough content",
          styleId: null,
          frames: [],
          status: "draft",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      expect(canProceedToNextStep(state)).toBe(true);
    });

    it("should not allow proceeding from step 1 with invalid script", () => {
      const state: AnonymousFlowState = {
        ...initialAnonymousFlowState,
        currentStep: 1,
        sequence: {
          id: "seq_123",
          name: "Test",
          script: "Short",
          styleId: null,
          frames: [],
          status: "draft",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      expect(canProceedToNextStep(state)).toBe(false);
    });

    it("should allow proceeding from step 2 with frames", () => {
      const state: AnonymousFlowState = {
        ...initialAnonymousFlowState,
        currentStep: 2,
        sequence: {
          id: "seq_123",
          name: "Test",
          script: "Valid script",
          styleId: "style_123",
          frames: [
            {
              id: "frame_1",
              sequence_id: "seq_123",
              order_index: 1,
              description: "Frame",
              thumbnail_url: "https://example.com/thumb.jpg",
              video_url: null,
              duration_ms: 5000,
              metadata: {},
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          status: "draft",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      expect(canProceedToNextStep(state)).toBe(true);
    });
  });

  describe("canGenerateStoryboard", () => {
    it("should allow generation with valid script and style", () => {
      const state: AnonymousFlowState = {
        ...initialAnonymousFlowState,
        sequence: {
          id: "seq_123",
          name: "Test",
          script: "Valid script content here",
          styleId: "style_123",
          frames: [],
          status: "draft",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      expect(canGenerateStoryboard(state)).toBe(true);
    });

    it("should not allow generation without style", () => {
      const state: AnonymousFlowState = {
        ...initialAnonymousFlowState,
        sequence: {
          id: "seq_123",
          name: "Test",
          script: "Valid script content here",
          styleId: null,
          frames: [],
          status: "draft",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      expect(canGenerateStoryboard(state)).toBe(false);
    });

    it("should not allow generation while already generating", () => {
      const state: AnonymousFlowState = {
        ...initialAnonymousFlowState,
        sequence: {
          id: "seq_123",
          name: "Test",
          script: "Valid script content here",
          styleId: "style_123",
          frames: [],
          status: "draft",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        generation: {
          ...initialAnonymousFlowState.generation,
          isGeneratingStoryboard: true,
        },
      };
      expect(canGenerateStoryboard(state)).toBe(false);
    });
  });

  describe("canGenerateMotion", () => {
    const stateWithFrames: AnonymousFlowState = {
      ...initialAnonymousFlowState,
      sequence: {
        id: "seq_123",
        name: "Test",
        script: "Valid script",
        styleId: "style_123",
        frames: [
          {
            id: "frame_1",
            sequence_id: "seq_123",
            order_index: 1,
            description: "Frame",
            thumbnail_url: "https://example.com/thumb.jpg",
            video_url: null,
            duration_ms: 5000,
            metadata: {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        status: "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };

    it("should allow motion generation with frames", () => {
      expect(canGenerateMotion(stateWithFrames)).toBe(true);
    });

    it("should allow motion generation for specific frame", () => {
      expect(canGenerateMotion(stateWithFrames, "frame_1")).toBe(true);
    });

    it("should not allow motion generation for non-existent frame", () => {
      expect(canGenerateMotion(stateWithFrames, "frame_999")).toBe(false);
    });

    it("should not allow motion generation while already generating", () => {
      const state = {
        ...stateWithFrames,
        generation: {
          ...stateWithFrames.generation,
          isGeneratingMotion: true,
        },
      };
      expect(canGenerateMotion(state)).toBe(false);
    });
  });
});
