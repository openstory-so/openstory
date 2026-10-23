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
- A delete (`destructiveHint`) is `needsApproval`: the run pauses on a card
  with Allow / Deny. A spend does not ask: the user is inside the app, the
  page shows the generation as it starts, and it can be cancelled there.
  A read never asks. `assistant-tools.test.ts` pins this against the catalog.
- Tools outside `EAGER_TOOLS` are `lazy`: the model sees the name and the
  first sentence, and discovers a schema when it needs one.
- The model calls a tool by `chatToolName`: `openstory_get_shot`, the MCP
  name with its dot as an underscore. OpenAI rejects a dot in a tool name
  and OpenRouter reports only "Provider returned error" for it; the
  provider's own message is logged by the `assistant-model-error`
  middleware (`onModelError`, `rawEvent`). `EAGER_TOOLS` and the approval rule
  keep the MCP names.

Scope checks, the likeness gate and billing are the tool's own and are the
same on both paths. Do not add an assistant-only tool; add an MCP tool.

## The turn

`POST /api/assistant/chat` (`src/assistant/server/assistant-chat.ts`):

1. `chatParamsFromRequest` reads the AG-UI body. `threadId` must be a ULID
   the client minted; the thread row is created on first use and belongs to
   the user in the team (`scopedDb.assistant.ensureThread`).
2. `forwardedProps.pageContext` (validated by `pageContextSchema`) becomes
   one system line naming what the user is looking at, ids included.
3. The model is the composer's pick (`forwardedProps.model`, kept in the
   assistant store across threads), through `chatModelFor`: a selectable
   analysis model or `DEFAULT_ANALYSIS_MODEL`, swapped for the request's
   country the way a sequence's is. It runs on the team's `resolveLlmKey`.
   `requireCredits` runs first; a platform key bills each model iteration
   as its usage is reported, with `llmCostFromUsage(usage, model,
llmKey.via)`, under a server-minted key per iteration. A team key bills
   nothing.
4. `withPersistence` writes the transcript, the run and any interrupt to
   `assistant_messages` / `assistant_runs` / `assistant_interrupts` through
   the stores in `src/assistant/server/db/assistant.ts`. Each store is built
   for one thread the user owns, so it cannot read across threads.

`GET /api/assistant/chat?threadId=` hydrates: the transcript and a paused
approval, through `reconstructChat`. The client uses `persistence: true`, so
a reload or a second tab paints the same thread. A thread id the browser
kept from another sign-in answers 404 (`THREAD_NOT_FOUND`), and the client
starts a new thread on it; an id nothing was sent to yet hydrates empty.

## Resume

Every chunk of a turn is appended to a stream log before the browser sees
it (`src/assistant/server/durability.ts`): `@tanstack/ai-durable-stream`
over `@durable-streams/server-cloudflare`, a Durable Object per run behind
the `STREAMS` binding (`StreamObject`, tag v4 in every env block, class
re-exported from `src/server.ts`). The streams server is called in-process;
no route speaks its protocol to the outside, and a stream is keyed under
`assistant/<team>/<user>/<runId>`, so another user's run id names a stream
that does not exist.

- A drop mid-reply: the client re-sends the POST with `Last-Event-ID`.
  That is a read of the log, answered before any gate or thread write;
  the model never runs twice.
- A reload or a second tab: hydrate reports the run `findActiveRun` finds
  (running, started within `ACTIVE_RUN_MAX_AGE_MS`), the client joins it
  with `GET ?runId=&offset=-1`, and the log is tailed to the run's end.
- The run outlives the response: `heldStreamLog` holds the request with
  `waitUntil` until the log closes, so billing and persistence still run
  after the tab is gone. Each model iteration is charged as its usage is
  reported (idempotency key per iteration), so a run the host drops has
  already paid for every iteration that finished; only the one in flight
  is lost. `waitUntil` is bounded, so a turn that goes on much longer than
  that after a disconnect is cut off with its log open. The next turn closes
  such runs as aborted (`closeOpenRuns`) and seals their logs
  (`sealStreamLog`) so nothing tails them forever. That seal is by status,
  not age: a turn sent from a second tab while the first still streams
  cuts the first off, which that tab shows as a failure.
- A log is keyed by the body's run id (the one the run row and hydrate
  carry), expires three days after its last read (`Stream-TTL`, sent on
  every create; the server refuses a create whose TTL differs from the
  stored one), and is deleted with its thread (`deleteStreamLogs`).

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

A file dropped or pasted uploads at once through the Studio upload path
(`useUploadStudioMedia`, then `ensureUploadRights` for an image, the same
likeness gate as the editor). The composer's `+` opens the Studio reference
picker (`StudioReferencePicker`, the one upload surface in the app): a
generation, past upload, shot, character or location picked there is
already stored and already past the gate, so it attaches with no upload;
its Upload button takes a new file down the same path as a drop. The
message tells the model the stored `upload` value for each file, which
`set_*_from_upload` and the Studio tools take, and carries a downscaled
JPEG preview of each image as a vision part so the model can see it. Text
files are inlined.

A PDF is read in the browser (`unpdf`, a lazy chunk) and inlined as text
like any script file; nothing of it is stored.

Consecutive tool calls in one reply fold into a single `<details>`
(`groupToolCalls` in `assistant-message.tsx`), open while any call runs or
waits on the user and shut once all are done.

## The web

`web_search` (Brave Search, `BRAVE_SEARCH_API_KEY`, platform key only) and
`fetch_url` (`src/platform/server/mcp/tools/web.ts`) are ordinary MCP
tools, so an outside agent gets them too. Both are reads with
`openWorldHint`; without the key `web_search` answers a clear tool error.
`fetch_url` goes through `openSafeUrl` (the public API's SSRF-hardened
opener: host checks on every redirect hop, bounded hops, a connect budget)
and refuses the app's own origin, then reads a bounded prefix of a text
page and hands back at most 30,000 characters. In chat `fetch_url` is the
one read that asks: the model composes the URL, and a page it read could
tell it to put the user's script in one, so the URL sits on an Allow / Deny
card first (`URL_TOOLS` in `assistant-tools.ts`). A search query is shown
on its card but does not ask. The system prompt tells the model a page's
text is material, never instructions.

## MCP Apps views in the app

A tool with a `ui://` view (`TOOL_VIEWS` in `src/platform/mcp-views.ts`,
client-safe) shows that view under its finished card: `McpAppFrame`
(`src/assistant/ui/mcp-app-frame.tsx`) is the host side of the MCP Apps
protocol in a sandboxed iframe with no same-origin. The page comes from
`getMcpViewFn` (the same HTML the MCP server serves as a resource), the
tool result is re-wrapped in its MCP envelope, `tools/call` runs through
`callMcpReadToolFn` (only `VIEW_CALLABLE_TOOLS`, the reads the pages make,
under the session), `open-link`
opens a tab, and `ui/message` goes into the thread as the user. Nothing is
registered per view: a new view is one entry in `TOOL_VIEWS` and its HTML
in `getMcpViewFn`.

## Unsaved work as context

A `PageContextItem` may carry `text` (up to 50,000 characters) for a thing
no tool can read. The new-sequence page renders an `AssistantContextItem`
of kind `draft_script` with the script being typed, so "tighten this" works
before anything is saved; the system line quotes the text in a fence and
says it is the user's work, not instructions.

## The Studio viewer

With the panel open the viewer is not modal and takes only the room left
of the panel (`--assistant-w`, from the store's `width`), so the user can
look at the image and talk about it at once. A click in the panel is not
"outside" the viewer.

## Stories

`assistant-panel.stories.tsx` runs the real `chat()` engine in the browser
over `fakeText` (`scripted-connection.ts`), so every state (streaming, tool
running, tool error, confirm-before-spend, upload, long thread) streams the
same events the server sends.
