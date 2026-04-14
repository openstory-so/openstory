/**
 * Prompt management — serves prompts from local templates.
 */

import {
  WORKFLOW_CHAT_PROMPTS,
  WORKFLOW_TEXT_PROMPTS,
} from './workflow-prompts';

/**
 * Simple {{var}} substitution for prompt templates.
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
 * Message format for chat prompts.
 */
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

/**
 * Fetch a text prompt from local templates.
 *
 * @param name - Prompt name (e.g., 'script/enhance')
 * @param variables - Optional variables to compile into the prompt
 * @returns The prompt name (for trace linking) and compiled text
 */
export async function getPrompt(
  name: string,
  variables?: Record<string, string>
): Promise<{ prompt: { name: string }; compiled: string }> {
  const localPrompt = WORKFLOW_TEXT_PROMPTS[name];
  if (!localPrompt) {
    throw new Error(`Text prompt "${name}" not found in local prompts.`);
  }

  const compiled = variables
    ? compileTemplate(localPrompt, variables)
    : localPrompt;
  return { prompt: { name }, compiled };
}

/**
 * Fetch a chat prompt from local templates.
 *
 * @param name - Prompt name (e.g., 'phase/scene-splitting')
 * @param variables - Variables to compile into the prompt messages
 * @returns The prompt name (for trace linking) and compiled messages
 */
export async function getChatPrompt(
  name: string,
  variables?: Record<string, string>
): Promise<{
  prompt: { name: string };
  messages: ChatMessage[];
}> {
  const localMessages = WORKFLOW_CHAT_PROMPTS[name];
  if (!localMessages) {
    throw new Error(`Chat prompt "${name}" not found in local prompts.`);
  }

  const messages: ChatMessage[] = variables
    ? localMessages.map((msg) => ({
        ...msg,
        content: compileTemplate(msg.content, variables),
      }))
    : [...localMessages];

  return { prompt: { name }, messages };
}
