/**
 * Check local prompts against Langfuse
 *
 * Compares prompts in workflow-prompts.ts (git source of truth)
 * against Langfuse production prompts and reports differences.
 *
 * Usage:
 *   bun scripts/check-prompts.ts          # Human-readable table
 *   bun scripts/check-prompts.ts --json   # Machine-readable JSON
 *
 * Exit codes:
 *   0 — all prompts in sync
 *   1 — differences found
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

type PromptEntry = { name: string; type: 'text' | 'chat' };
type CheckResult = {
  unchanged: PromptEntry[];
  modified: PromptEntry[];
  new: PromptEntry[];
  removed: PromptEntry[];
  errors: Array<{ name: string; error: string }>;
  inSync: boolean;
};

function normalizeText(s: string): string {
  return s.trim();
}

type RemoteChatPrompt = ChatPromptClient['prompt'];

/** Filter out placeholder messages, keeping only role+content chat messages */
function toChatMessages(
  messages: RemoteChatPrompt
): Array<{ role: string; content: string }> {
  return messages
    .filter((m): m is ChatMessage => 'role' in m && 'content' in m)
    .map((m) => ({ role: m.role, content: normalizeText(m.content) }));
}

function chatMessagesEqual(
  local: ChatMessage[],
  remote: RemoteChatPrompt
): boolean {
  const normalizedLocal = local.map((m) => ({
    role: m.role,
    content: normalizeText(m.content),
  }));
  const normalizedRemote = toChatMessages(remote);
  return JSON.stringify(normalizedLocal) === JSON.stringify(normalizedRemote);
}

async function main() {
  const jsonMode = process.argv.includes('--json');
  const langfuse = new LangfuseClient();

  // Fetch all prompt metadata from Langfuse
  const promptsList = await langfuse.api.prompts.list({ limit: 100 });

  // Build a map of Langfuse prompt names → type
  const langfusePrompts = new Map<string, 'text' | 'chat'>();
  for (const meta of promptsList.data) {
    if (meta.type === 'text' || meta.type === 'chat') {
      langfusePrompts.set(meta.name, meta.type);
    }
  }

  // Build local prompt name sets
  const localTextNames = new Set(Object.keys(WORKFLOW_TEXT_PROMPTS));
  const localChatNames = new Set(Object.keys(WORKFLOW_CHAT_PROMPTS));
  const allLocalNames = new Set([...localTextNames, ...localChatNames]);
  const allLangfuseNames = new Set(langfusePrompts.keys());

  const result: CheckResult = {
    unchanged: [],
    modified: [],
    new: [],
    removed: [],
    errors: [],
    inSync: true,
  };

  // Find new prompts (local only)
  for (const name of allLocalNames) {
    if (!allLangfuseNames.has(name)) {
      const type = localTextNames.has(name) ? 'text' : 'chat';
      result.new.push({ name, type });
    }
  }

  // Find removed prompts (Langfuse only)
  for (const name of allLangfuseNames) {
    if (!allLocalNames.has(name)) {
      const type = langfusePrompts.get(name) ?? 'text';
      result.removed.push({ name, type });
    }
  }

  // Compare shared prompts
  const sharedNames = [...allLocalNames].filter((n) => allLangfuseNames.has(n));

  for (const name of sharedNames) {
    try {
      if (localTextNames.has(name)) {
        const remote = await langfuse.prompt.get(name, {
          type: 'text',
          cacheTtlSeconds: 0,
        });
        const localContent = normalizeText(WORKFLOW_TEXT_PROMPTS[name]);
        const remoteContent = normalizeText(remote.prompt);

        if (localContent === remoteContent) {
          result.unchanged.push({ name, type: 'text' });
        } else {
          result.modified.push({ name, type: 'text' });
        }
      } else {
        const remote = await langfuse.prompt.get(name, {
          type: 'chat',
          cacheTtlSeconds: 0,
        });
        const localMessages = WORKFLOW_CHAT_PROMPTS[name];

        if (chatMessagesEqual(localMessages, remote.prompt)) {
          result.unchanged.push({ name, type: 'chat' });
        } else {
          result.modified.push({ name, type: 'chat' });
        }
      }
    } catch (error) {
      result.errors.push({
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  result.inSync =
    result.modified.length === 0 &&
    result.new.length === 0 &&
    result.errors.length === 0;

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTable(result);
  }

  process.exit(result.inSync ? 0 : 1);
}

function printTable(result: CheckResult) {
  console.log('\nPrompt Sync Status\n');

  const rows: Array<{ status: string; type: string; name: string }> = [];

  for (const p of result.unchanged) {
    rows.push({ status: 'sync', type: p.type, name: p.name });
  }
  for (const p of result.modified) {
    rows.push({ status: 'diff', type: p.type, name: p.name });
  }
  for (const p of result.new) {
    rows.push({ status: 'new', type: p.type, name: p.name });
  }
  for (const p of result.removed) {
    rows.push({ status: 'gone', type: p.type, name: p.name });
  }
  for (const e of result.errors) {
    rows.push({ status: 'error', type: '?', name: `${e.name}: ${e.error}` });
  }

  // Sort: diffs first, then new, gone, errors, unchanged last
  const statusOrder: Record<string, number> = {
    diff: 0,
    new: 1,
    gone: 2,
    error: 3,
    sync: 4,
  };
  rows.sort(
    (a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9)
  );

  console.log('  Status   Type   Name');
  console.log('  ──────   ────   ────');

  for (const row of rows) {
    const status = row.status.padEnd(7);
    const type = row.type.padEnd(5);
    console.log(`  ${status}  ${type}  ${row.name}`);
  }

  const parts: string[] = [];
  if (result.unchanged.length > 0)
    parts.push(`${result.unchanged.length} in sync`);
  if (result.modified.length > 0)
    parts.push(`${result.modified.length} modified`);
  if (result.new.length > 0)
    parts.push(`${result.new.length} new (local only)`);
  if (result.removed.length > 0)
    parts.push(`${result.removed.length} removed (Langfuse only)`);
  if (result.errors.length > 0) parts.push(`${result.errors.length} errors`);

  console.log(`\nSummary: ${parts.join(', ')}`);
}

main().catch((error) => {
  console.error(
    'Failed to check prompts:',
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
