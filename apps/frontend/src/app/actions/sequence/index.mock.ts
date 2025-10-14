"use client";

// Mock implementation for Storybook
import {
  generateMockJob,
  generateMockSequence,
} from "@/lib/mocks/data-generators";
import type { Job, Sequence } from "@/types/database";
import type { CreateSequenceInput, UpdateSequenceInput } from "./index";

// Mock data store (in-memory for Storybook)
let mockSequences: Sequence[] = [];
let mockJobs: Job[] = [];

// Initialize with some default data
if (mockSequences.length === 0) {
  mockSequences = Array.from({ length: 5 }, () => generateMockSequence());
}

// Simulate network delay
const simulateDelay = (ms: number = 1000) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function createSequence(
  input: CreateSequenceInput,
): Promise<Sequence> {
  await simulateDelay(800);

  const newSequence = generateMockSequence({
    title: input.name,
    script: input.script,
    status: "draft",
  });

  mockSequences.push(newSequence);
  return newSequence;
}

export async function updateSequence(
  input: UpdateSequenceInput,
): Promise<Sequence> {
  await simulateDelay(600);

  const sequence = mockSequences.find((s) => s.id === input.id);
  if (!sequence) {
    throw new Error("Sequence not found");
  }

  const updated = {
    ...sequence,
    ...input,
    updated_at: new Date().toISOString(),
  };

  const index = mockSequences.findIndex((s) => s.id === input.id);
  mockSequences[index] = updated;

  return updated;
}

export async function deleteSequence(
  id: string,
): Promise<{ success: boolean }> {
  await simulateDelay(400);

  const index = mockSequences.findIndex((s) => s.id === id);
  if (index === -1) {
    throw new Error("Sequence not found");
  }

  mockSequences.splice(index, 1);
  return { success: true };
}

export async function getSequence(id: string): Promise<Sequence> {
  await simulateDelay(300);

  const sequence = mockSequences.find((s) => s.id === id);
  if (!sequence) {
    throw new Error("Sequence not found");
  }

  return sequence;
}

export async function listSequences(_teamId?: string): Promise<Sequence[]> {
  await simulateDelay(500);

  // If teamId provided, filter by team (in real app)
  // For mock, return all sequences
  return [...mockSequences];
}

export async function validateScript(script: string): Promise<{
  isValid: boolean;
  errors: string[];
  estimatedFrames: number;
  enhancedScript?: string;
}> {
  await simulateDelay(800);

  const errors: string[] = [];

  if (!script.trim()) {
    errors.push("Script cannot be empty");
  }

  if (script.length < 10) {
    errors.push("Script must be at least 10 characters long");
  }

  if (script.length > 10000) {
    errors.push("Script must be 10,000 characters or less");
  }

  const isValid = errors.length === 0;
  const estimatedFrames = isValid
    ? Math.ceil(script.length / 200) + Math.floor(Math.random() * 5)
    : 0;

  return {
    isValid,
    errors,
    estimatedFrames,
    enhancedScript: isValid ? script : undefined,
  };
}

export async function generateStoryboard(sequenceId: string): Promise<Job> {
  await simulateDelay(1200);

  const sequence = mockSequences.find((s) => s.id === sequenceId);
  if (!sequence) {
    throw new Error("Sequence not found");
  }

  // Update sequence status to processing
  const index = mockSequences.findIndex((s) => s.id === sequenceId);
  mockSequences[index] = {
    ...sequence,
    status: "processing",
    updated_at: new Date().toISOString(),
  };

  // Create mock job
  const job = generateMockJob({
    type: "script_analysis",
    status: "running",
    payload: {
      sequence_id: sequenceId,
      estimated_frames: Math.floor(Math.random() * 20) + 5,
    },
    started_at: new Date().toISOString(),
  });

  mockJobs.push(job);
  return job;
}

// Helper function to get all mock data (useful for debugging)
export function getMockData() {
  return {
    sequences: mockSequences,
    jobs: mockJobs,
  };
}

// Helper function to reset mock data
export function resetMockData() {
  mockSequences = Array.from({ length: 5 }, () => generateMockSequence());
  mockJobs = [];
}
