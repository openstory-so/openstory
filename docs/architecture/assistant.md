# In-app assistant (#2155)

A chat panel inside the app that can do everything the MCP server lets an
outside agent do, under the signed-in user's team, with the page the user is
on as context.

## One tool set, two callers

Every `openstory.*` tool is one `toolDefinition().server()` in
`src/platform/server/mcp/tools/**`. `MCP_TOOLS` (`mcp/server.ts`) is the list
the MCP server serves and the list the assistant runs through `chat()`. A
tool reads its caller on `ctx.context` (`OpenStoryMcpContext`): the MCP
handler builds one from a Bearer token, the assistant from the session. The
only assistant-side work per tool happens in
`src/assistant/server/assistant-tools.ts`:

- The MCP envelope is unwrapped: `structuredContent` goes to the model and
  the card; an error envelope becomes a thrown error, which TanStack AI
  reports as the tool's error result and the run goes on.
- A write that spends credits or deletes something is `needsApproval`: the
  run pauses on a card with Allow / Deny. Spending is read off the catalog's
  own mark (`openWorldHint: true` on a write, the `paid` annotations) plus
  `SPEND_TOOLS` for the few that spend without it (`create_sequence`,
  `rebuild_shot_prompts`); deleting is `destructiveHint`. A read never asks.
  `assistant-tools.test.ts` pins both against the catalog.
- Tools outside `EAGER_TOOLS` are `lazy`: the model sees the name and the
  first sentence, and discovers a schema when it needs one.
- The model calls a tool by `chatToolName`: `openstory_get_shot`, the MCP
  name with its dot as an underscore. OpenAI rejects a dot in a tool name
  and OpenRouter reports only "Provider returned error" for it; the
  provider's own message is logged by the `assistant-model-error`
  middleware (`onModelError`, `rawEvent`). `EAGER_TOOLS`, `SPEND_TOOLS` and
  the approval rule keep the MCP names.

Scope checks, the likeness gate and billing are the tool's own and are the
same on both paths. Do not add an assistant-only tool; add an MCP tool.

## The turn

`POST /api/assistant/chat` (`src/assistant/server/assistant-chat.ts`):

1. `chatParamsFromRequest` reads the AG-UI body. `threadId` must be a ULID
   the client minted; the thread row is created on first use and belongs to
   the user in the team (`scopedDb.assistant.ensureThread`).
2. `forwardedProps.pageContext` (validated by `pageContextSchema`) becomes
   one system line naming what the user is looking at, ids included.
3. The model is `DEFAULT_ANALYSIS_MODEL` on the team's `resolveLlmKey`.
   `requireCredits` runs first; a platform key bills the run once at the end
   with `llmCostFromUsage(usage, model, llmKey.via)`, idempotent on the run
   id. A team key bills nothing.
4. `withPersistence` writes the transcript, the run and any interrupt to
   `assistant_messages` / `assistant_runs` / `assistant_interrupts` through
   the stores in `src/assistant/server/db/assistant.ts`. Each store is built
   for one thread the user owns, so it cannot read across threads.

`GET /api/assistant/chat?threadId=` hydrates: the transcript and a paused
approval, through `reconstructChat`. The client uses `persistence: true`, so
a reload or a second tab paints the same thread. A thread id the browser
kept from another sign-in answers 404 (`THREAD_NOT_FOUND`), and the client
starts a new thread on it; an id nothing was sent to yet hydrates empty.

Stream resume (reconnect to a run still going) needs a delivery-durability
adapter on the Worker; it is not wired yet. Until it is, `findActiveRun`
answers null (a reported run would make the client join a stream nothing
serves) and a run still marked running when the next turn starts is closed
as aborted (`closeOpenRuns`).

The charge key is minted per request on the server. The client's run id is
only the AG-UI correlation id; keying billing on it would let a repeated id
run free.

## Page context

`usePageContext` (`src/assistant/ui/use-page-context.ts`) reads the router:
route params name the sequence, character or location; search params name
the selected scene or shot. Labels come from the query cache the page has
already filled. No page registers anything, so none can forget to. The
items are chips in the composer; a removed chip stays removed for the
thread (`dismissedContext` in the store). A page can hand over extra
context and a prompt with `openAssistant({ context, prompt })`.

Context the URL does not name (the Studio viewer's open asset) is held in
component state, so the page says so by rendering `AssistantContextItem`
while it is open; the store's `extraContext` joins the chips and leaves
on unmount. Entry points: "Ask the assistant" in a shot's menu, on the
character and location pages, and in the Studio viewer
(`AskAssistantButton`). The empty thread's starters follow the context
kinds (`suggestionsFor` in `app-layout.tsx`).

## Shell

`AssistantPanel` is mounted once in `AppLayout`, right of the page on
desktop (resizable, width in localStorage) and a drawer on a phone, toggled
by the header button or Cmd/Ctrl+J. Open state and the thread id live in
`assistant-store.ts` (a module store with `useSyncExternalStore`), so any
button can open it and it survives navigation and reloads.

## Uploads

A file dropped, pasted or attached uploads at once through the Studio
upload path (`useUploadStudioMedia`, then `ensureUploadRights` for an
image, the same likeness gate as the editor). The message tells the model
the stored `upload` value for each file, which `set_*_from_upload` and the
Studio tools take, and carries a downscaled JPEG preview of each image as a
vision part so the model can see it. Text files are inlined.

## Stories

`assistant-panel.stories.tsx` runs the real `chat()` engine in the browser
over `fakeText` (`scripted-connection.ts`), so every state (streaming, tool
running, tool error, confirm-before-spend, upload, long thread) streams the
same events the server sends.
