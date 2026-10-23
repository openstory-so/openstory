/**
 * One assistant turn (#2155): the signed-in user's message, the page they
 * are on, the MCP tool set under their team, streamed back as SSE and
 * persisted per thread. The LLM is the team's configured one
 * (`resolveLlmKey`); a platform key bills the turn to the team at
 * `llmCostFromUsage`.
 */

import {
  chat,
  chatParamsFromRequest,
  maxIterations,
  toServerSentEventsResponse,
  type ChatMiddleware,
  type TokenUsage,
} from '@tanstack/ai';
import { reconstructChat, withPersistence } from '@tanstack/ai-persistence';
import { z } from 'zod';
import { estimateLLMCost } from '@/billing/cost-estimation';
import { requireCredits } from '@/billing/server/preflight';
import { requireGenerationAllowed } from '@/platform/server/compliance/generation-gate';
import { reportMissingBillingCost } from '@/billing/billing-observability';
import { DEFAULT_ANALYSIS_MODEL } from '@/models/models.config';
import { createAdapter } from '@/models/server/create-adapter';
import { llmCostFromUsage } from '@/models/server/llm-client';
import { generateId } from '@/platform/id';
import { getLogger, toErrorPayload } from '@/platform/logger';
import { aiObservabilityMiddleware } from '@/platform/server/observability/ai-otel';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { User } from '@/platform/server/auth/config';
import type { OpenStoryMcpContext } from '@/platform/server/mcp/tool-context';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { ValidationError } from '@/platform/errors';
import {
  describePageContext,
  pageContextSchema,
  type PageContextItem,
} from '../page-context';
import { assistantTools } from './assistant-tools';
import { threadTitleFrom } from './db/assistant';

const logger = getLogger(['openstory', 'assistant']);

/** Model turns per user message; tool calls are not counted. */
const MAX_TURNS = 24;

export type AssistantCaller = {
  scopedDb: ScopedDb;
  user: User;
  teamId: string;
  teamName: string;
  origin: string;
  request: Request;
};

const SYSTEM_PROMPT = `You are the OpenStory assistant, inside the OpenStory app. You help the user make AI video: sequences, scenes, shots, characters, locations, styles, music and the Studio. Every openstory_* tool acts on the user's team, with their permissions and their credits.

How to work:
- Read before you write. Use get_* and list_* to find ids; never guess an id.
- Paid work needs a plan first: plan_generation, show the estimate in one line, then execute_generation with its planToken. The user confirms any spend or delete on a card; do not ask them again in text.
- Prefer the smallest tool: one shot's prompt, not the storyboard; one still, not every still.
- When a tool starts a generation, say what started and stop; the page shows progress. Do not poll.
- Say what you did in one or two short sentences. No headings, no lists unless listing things. Plain words.
- If a tool fails, say what failed and what the user can do. Never pretend it worked.
- Attachments arrive as uploads: the message says the upload value to pass to set_*_from_upload or the Studio tools.`;

function systemPrompts(
  caller: AssistantCaller,
  pageContext: PageContextItem[]
): string[] {
  const prompts = [
    SYSTEM_PROMPT,
    `The user is ${caller.user.name} in team "${caller.teamName}". Today is ${new Date().toISOString().slice(0, 10)}.`,
  ];
  const page = describePageContext(pageContext);
  if (page) prompts.push(page);
  return prompts;
}

/** The tool context: a session caller has every scope. */
function toolContext(caller: AssistantCaller): OpenStoryMcpContext {
  const readContext = {
    scopedDb: caller.scopedDb,
    origin: caller.origin,
    userId: caller.user.id,
    request: {
      ipAddress: caller.request.headers.get('cf-connecting-ip'),
      userAgent: caller.request.headers.get('user-agent'),
    },
  };
  return {
    caller: {
      user: caller.user,
      teamId: caller.teamId,
      teamName: caller.teamName,
    },
    origin: caller.origin,
    scoped: () => readContext,
  };
}

/** The first text of the last user message, for a new thread's title. */
function lastUserText(
  messages: ReadonlyArray<{ role: string; content?: unknown; parts?: unknown }>
): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  // A UI message carries parts; a model message carries content.
  if (last && Array.isArray(last.parts)) {
    return lastUserText([{ role: 'user', content: last.parts }]);
  }
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    const text = last.content.find(
      (part: unknown): part is { type: 'text'; content: string } =>
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === 'text' &&
        'content' in part &&
        typeof part.content === 'string'
    );
    return text?.content ?? '';
  }
  return '';
}

/**
 * Bill the turn to the team unless its own key paid for it. One charge per
 * request, after the last model call, from the usage the provider reported.
 * The idempotency key is minted here, never taken from the client: a
 * repeated client run id would otherwise be billed once and run free.
 * TanStack swallows what a terminal hook throws, so a failed charge is
 * logged here or it is lost.
 */
function billingMiddleware(
  caller: AssistantCaller,
  model: string,
  via: 'openrouter' | 'fal' | 'xai' | 'google' | 'llmtr',
  usedOwnKey: boolean,
  runId: string
): ChatMiddleware[] {
  const chargeKey = `assistant:${caller.teamId}:${generateId()}`;
  let total: TokenUsage | undefined;
  const charge = async (info?: { usage?: TokenUsage }) => {
    if (usedOwnKey) return;
    const usage = total ?? info?.usage;
    // Nothing reported means nothing was used (the model never answered).
    if (!usage || usage.totalTokens === 0) return;
    const cost = llmCostFromUsage(usage, model, via);
    if (cost <= 0) {
      reportMissingBillingCost({
        source: 'assistant-chat',
        modelId: model,
        teamId: caller.teamId,
        metadata: { usage, via, runId },
      });
      return;
    }
    try {
      await caller.scopedDb.billing.deductCredits(cost, {
        description: `Assistant (${model})`,
        metadata: { model, runId },
        idempotencyKey: chargeKey,
      });
    } catch (error) {
      logger.error('assistant charge failed', {
        teamId: caller.teamId,
        runId,
        cost,
        err: toErrorPayload(error),
      });
      throw error;
    }
  };
  return [
    {
      name: 'assistant-billing',
      onUsage: (_ctx, usage) => {
        // Every model iteration reports; sum tokens, keep the latest cost sum.
        total = total
          ? {
              promptTokens: total.promptTokens + usage.promptTokens,
              completionTokens: total.completionTokens + usage.completionTokens,
              totalTokens: total.totalTokens + usage.totalTokens,
              ...(usage.cost !== undefined || total.cost !== undefined
                ? { cost: (total.cost ?? 0) + (usage.cost ?? 0) }
                : {}),
            }
          : usage;
      },
      onFinish: (_ctx, info) => charge(info),
      onAbort: () => charge(),
      onError: () => charge(),
    },
  ];
}

/** POST: one turn. */
export async function handleAssistantChat(
  caller: AssistantCaller
): Promise<Response> {
  const params = await chatParamsFromRequest(caller.request);
  const threadId = ulidSchema.safeParse(params.threadId);
  if (!threadId.success) {
    throw new ValidationError('threadId must be a ULID the client minted.');
  }
  const pageContext = pageContextSchema.safeParse(
    params.forwardedProps.pageContext ?? []
  );
  if (!pageContext.success) {
    throw new ValidationError(z.prettifyError(pageContext.error));
  }

  const { scopedDb } = caller;
  const model = DEFAULT_ANALYSIS_MODEL;
  const llmKey = await scopedDb.apiKeys.resolveLlmKey(model);
  const usedOwnKey = llmKey.source === 'team';
  // A restricted account may read but not spend (#1180); the request
  // middleware checked access, this checks generation before any credit.
  await requireGenerationAllowed({
    userId: caller.user.id,
    teamId: caller.teamId,
  });
  await requireCredits(scopedDb, estimateLLMCost(2), {
    providers: ['openrouter'],
    llmModel: model,
    errorMessage: 'Add credits to chat with the assistant.',
  });

  const thread = await scopedDb.assistant.ensureThread(
    threadId.data,
    threadTitleFrom(lastUserText(params.messages))
  );
  // A run this thread still records as running was cut off before its
  // terminal hook (a closed tab, a killed isolate): a new turn supersedes it.
  await scopedDb.assistant.closeOpenRuns(thread.id);
  const abortController = new AbortController();
  const middleware: Array<ChatMiddleware<OpenStoryMcpContext>> = [
    {
      name: 'assistant-model-error',
      // OpenRouter answers "Provider returned error"; the provider's own
      // message is in `rawEvent`, and only the log sees it.
      onModelError: (_ctx, error) =>
        logger.error('assistant model error', {
          threadId: thread.id,
          runId: params.runId,
          model,
          via: llmKey.via,
          error: error.message,
          rawEvent: error.rawEvent,
        }),
    },
    ...aiObservabilityMiddleware({
      observationName: 'assistant-chat',
      tags: ['assistant'],
      userId: caller.user.id,
      sessionId: thread.id,
    }),
    ...billingMiddleware(caller, model, llmKey.via, usedOwnKey, params.runId),
    withPersistence(scopedDb.assistant.persistence(thread.id)),
  ];
  const stream = chat({
    adapter: createAdapter(model, llmKey),
    messages: params.messages,
    systemPrompts: systemPrompts(caller, pageContext.data),
    tools: assistantTools(),
    lazyToolsConfig: { includeDescription: 'first-sentence' },
    context: toolContext(caller),
    threadId: thread.id,
    runId: params.runId,
    ...(params.parentRunId ? { parentRunId: params.parentRunId } : {}),
    ...(params.resume ? { resume: params.resume } : {}),
    agentLoopStrategy: maxIterations(MAX_TURNS),
    abortController,
    middleware,
  });
  return toServerSentEventsResponse(stream, { abortController });
}

/** GET `?threadId=`: the stored transcript and any paused approval. */
export async function handleAssistantHydrate(
  caller: AssistantCaller
): Promise<Response> {
  const url = new URL(caller.request.url);
  const threadId = ulidSchema.safeParse(url.searchParams.get('threadId'));
  if (!threadId.success) {
    return Response.json({ error: 'threadId required' }, { status: 400 });
  }
  const status = await caller.scopedDb.assistant.threadStatus(threadId.data);
  // A thread that does not exist yet (the client minted the id, nothing
  // was sent) hydrates empty. One that exists but is not this user's in
  // this team (a thread id left in the browser by another sign-in) is a
  // 404 the client answers by starting a new thread.
  if (status === 'none') {
    return Response.json(
      { messages: [], activeRun: null, interrupts: null },
      { headers: { 'cache-control': 'no-store' } }
    );
  }
  if (status === 'other') {
    return Response.json(
      {
        error: { code: 'THREAD_NOT_FOUND', message: 'This chat is not yours.' },
      },
      { status: 404, headers: { 'cache-control': 'no-store' } }
    );
  }
  try {
    return await reconstructChat(
      caller.scopedDb.assistant.persistence(threadId.data),
      caller.request
    );
  } catch (error) {
    logger.error('assistant hydrate failed', {
      threadId: threadId.data,
      err: toErrorPayload(error),
    });
    throw error;
  }
}
