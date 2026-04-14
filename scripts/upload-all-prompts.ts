/**
 * Upload ALL prompts to Langfuse
 *
 * Sources everything from workflow-prompts.ts (single source of truth).
 *
 * Usage: bun scripts/upload-all-prompts.ts
 *
 * Requires LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY (and optionally LANGFUSE_BASE_URL)
 * to be set in .env.local or environment.
 */

import { LangfuseClient, type ChatPromptClient } from '@langfuse/client';
import {
  WORKFLOW_CHAT_PROMPTS,
  WORKFLOW_TEXT_PROMPTS,
  type ChatMessage,
} from '../src/lib/prompts/workflow-prompts';

// ── Helpers ───────────────────────────────────────────────────────────

function normalizeText(s: string): string {
  return s.trim();
}

function chatMessagesEqual(
  local: ChatMessage[],
  remote: ChatPromptClient['prompt']
): boolean {
  const normalizedLocal = local.map((m) => ({
    role: m.role,
    content: normalizeText(m.content),
  }));
  const normalizedRemote = remote
    .filter((m): m is ChatMessage => 'role' in m && 'content' in m)
    .map((m) => ({ role: m.role, content: normalizeText(m.content) }));
  return JSON.stringify(normalizedLocal) === JSON.stringify(normalizedRemote);
}

// ── Upload logic ──────────────────────────────────────────────────────

async function main() {
  const langfuse = new LangfuseClient();

  const textNames = Object.keys(WORKFLOW_TEXT_PROMPTS);
  const chatNames = Object.keys(WORKFLOW_CHAT_PROMPTS);
  const total = textNames.length + chatNames.length;

  console.log(
    `Checking ${total} prompts (${textNames.length} text + ${chatNames.length} chat)\n`
  );

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  // Upload text prompts
  for (const name of textNames) {
    try {
      // Check if content has changed before uploading
      try {
        const remote = await langfuse.prompt.get(name, {
          type: 'text',
          cacheTtlSeconds: 0,
        });
        if (
          normalizeText(remote.prompt) ===
          normalizeText(WORKFLOW_TEXT_PROMPTS[name])
        ) {
          console.log(`  [skip] ${name} (unchanged)`);
          skipped++;
          continue;
        }
      } catch {
        // Prompt doesn't exist in Langfuse yet — upload it
      }

      await langfuse.prompt.create({
        name,
        type: 'text',
        prompt: WORKFLOW_TEXT_PROMPTS[name],
        labels: ['production'],
      });
      console.log(`  [text] ${name}`);
      uploaded++;
    } catch (error) {
      console.error(
        `  [FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`
      );
      failed++;
    }
  }

  // Upload chat prompts
  for (const name of chatNames) {
    try {
      // Check if content has changed before uploading
      try {
        const remote = await langfuse.prompt.get(name, {
          type: 'chat',
          cacheTtlSeconds: 0,
        });
        if (chatMessagesEqual(WORKFLOW_CHAT_PROMPTS[name], remote.prompt)) {
          console.log(`  [skip] ${name} (unchanged)`);
          skipped++;
          continue;
        }
      } catch {
        // Prompt doesn't exist in Langfuse yet — upload it
      }

      await langfuse.prompt.create({
        name,
        type: 'chat',
        prompt: WORKFLOW_CHAT_PROMPTS[name],
        labels: ['production'],
      });
      console.log(`  [chat] ${name}`);
      uploaded++;
    } catch (error) {
      console.error(
        `  [FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`
      );
      failed++;
    }
  }

  console.log(
    `\nDone: ${uploaded} uploaded, ${skipped} unchanged, ${failed} failed (${total} total)`
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(
    'Upload failed:',
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
