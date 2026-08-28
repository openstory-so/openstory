/**
 * Prompt Management
 *
 * Prompts are served from the local registry in workflow-prompts.ts
 * (version-controlled, single source of truth).
 */

import {
  WORKFLOW_CHAT_PROMPTS,
  WORKFLOW_TEXT_PROMPTS,
} from './workflow-prompts';

/**
 * Simple {{var}} substitution for local prompt templates.
 */
function compileTemplate(
  template: string,
  variables: Record<string, string>
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => variables[key] ?? ''
  );
}

/**
 * Multimodal content part — used for vision-capable chat messages.
 * Mirrors @tanstack/ai's ContentPart shape so messages type-check against
 * the adapter without intermediate conversion.
 * Kept optional so existing string-only prompts stay backwards-compatible.
 */
type ChatMessageTextPart = { type: 'text'; content: string };
export type ChatMessageImagePart = {
  type: 'image';
  source:
    | { type: 'url'; value: string; mimeType?: string }
    | { type: 'data'; value: string; mimeType: string };
};
export type ChatMessageContentPart = ChatMessageTextPart | ChatMessageImagePart;

/**
 * Chat prompt message. `content` is either a plain string (the default for
 * all existing prompts) or an array of content parts for multimodal calls.
 */
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatMessageContentPart[];
};

/**
 * Fetch a text prompt from the local registry.
 *
 * @param name - Prompt name (e.g., 'phase/scene-splitting-boundaries-chat')
 * @param variables - Optional variables to compile into the prompt
 * @returns The compiled prompt text
 */
export async function getPrompt(
  name: string,
  variables?: Record<string, string>
): Promise<{ compiled: string }> {
  const localPrompt = WORKFLOW_TEXT_PROMPTS[name];
  if (!localPrompt) {
    throw new Error(`Text prompt "${name}" not found in local prompts.`);
  }

  const compiled = variables
    ? compileTemplate(localPrompt, variables)
    : localPrompt;
  return { compiled };
}

/**
 * Fetch a chat prompt from the local registry.
 *
 * @param name - Prompt name (e.g., 'phase/scene-splitting-boundaries-chat')
 * @param variables - Variables to compile into the prompt messages
 * @returns The compiled messages
 */
export async function getChatPrompt(
  name: string,
  variables?: Record<string, string>
): Promise<{ messages: ChatMessage[] }> {
  const localMessages = WORKFLOW_CHAT_PROMPTS[name];
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- Record<string, T> lookup returns undefined for missing keys
  if (!localMessages) {
    throw new Error(`Chat prompt "${name}" not found in local prompts.`);
  }

  const messages: ChatMessage[] = variables
    ? localMessages.map((msg) => ({
        ...msg,
        content:
          typeof msg.content === 'string'
            ? compileTemplate(msg.content, variables)
            : msg.content,
      }))
    : [...localMessages];

  return { messages };
}
