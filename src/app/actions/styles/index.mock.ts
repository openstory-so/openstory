"use client";

// Mock implementation for Storybook
import {
  generateMockStyle,
  generateMockStyles,
} from "@/lib/mocks/data-generators";
import type { Json, Style } from "@/types/database";

// Type definitions matching the real implementation
export type CreateStyleInput = {
  name: string;
  description?: string;
  config?: unknown;
  category?: string;
  tags?: string[];
  is_public?: boolean;
  preview_url?: string | null;
};

export type UpdateStyleInput = Partial<CreateStyleInput>;

// Mock data store
let mockStyles: Style[] = generateMockStyles(15);

// Simulate network delay
const simulateDelay = (ms: number = 1000) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function createStyle(input: CreateStyleInput): Promise<{
  success: boolean;
  style?: Style;
  error?: string;
}> {
  await simulateDelay(800);

  const newStyle = generateMockStyle({
    name: input.name,
    config: (input.config || {}) as Json,
    is_public: input.is_public || false,
  });

  mockStyles.push(newStyle);
  return { success: true, style: newStyle };
}

export async function updateStyle(
  id: string,
  input: UpdateStyleInput,
): Promise<{
  success: boolean;
  style?: Style;
  error?: string;
}> {
  await simulateDelay(600);

  const style = mockStyles.find((s) => s.id === id);
  if (!style) {
    return { success: false, error: "Style not found" };
  }

  const updated = {
    ...style,
    ...input,
    config: input.config !== undefined ? input.config : style.config,
    updated_at: new Date().toISOString(),
  } as Style;

  const index = mockStyles.findIndex((s) => s.id === id);
  mockStyles[index] = updated;

  return { success: true, style: updated };
}

export async function deleteStyle(id: string): Promise<{
  success: boolean;
  error?: string;
}> {
  await simulateDelay(400);

  const index = mockStyles.findIndex((s) => s.id === id);
  if (index === -1) {
    return { success: false, error: "Style not found" };
  }

  mockStyles.splice(index, 1);
  return { success: true };
}

export async function getStyle(id: string): Promise<{
  success: boolean;
  style?: Style;
  error?: string;
}> {
  await simulateDelay(300);

  const style = mockStyles.find((s) => s.id === id);
  if (!style) {
    return { success: false, error: "Style not found" };
  }

  return { success: true, style };
}

export async function listStyles(): Promise<{
  success: boolean;
  styles?: Style[];
  error?: string;
}> {
  await simulateDelay(500);

  return { success: true, styles: [...mockStyles] };
}

export async function getTemplateStyles(): Promise<{
  success: boolean;
  styles?: Style[];
  error?: string;
}> {
  await simulateDelay(500);

  const templateStyles = mockStyles.filter((s) => s.is_template === true);
  return { success: true, styles: templateStyles };
}

// Helper functions
export function getMockStyles() {
  return mockStyles;
}

export function resetMockStyles() {
  mockStyles = generateMockStyles(15);
}
