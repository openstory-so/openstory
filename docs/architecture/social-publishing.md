# Publishing to social (#1267)

"Publish to social…" sends a finished render to a team's own TikTok,
Instagram, YouTube, LinkedIn, Facebook, X, Threads and Bluesky accounts
through [Upload-Post](https://www.upload-post.com).

## Opt-in per team

- The team adds an Upload-Post key in **Settings → API Keys → Publishing**
  (`team_api_keys`, provider `upload_post`). There is no platform key:
  `platformKeyFor('upload_post')` is `undefined`, so a team without its own
  key has no publishing at all.
- Without an active, valid key the Download menu has no "Publish to social…"
  item and the product looks exactly as before. `getSocialPublishingFn`
  answers that; saving or deleting the key refreshes it. A key that failed its
  last check also hides the item, and the server fns say so rather than
  asking for a key.
- Checking the key only calls it invalid on 401/403. An Upload-Post outage
  throws "unavailable", so a good key is never marked invalid by one.
- The item is disabled until the current cut has a ready render, like
  "Copy link".
- `upload_post` is never resolved inside a workflow: `WorkflowCredentials`
  excludes it at the type level.

## Flow

1. `listSocialProfilesFn` — the Upload-Post profiles and which platforms each
   has connected. Only connected platforms are offered. A reply without a
   profiles list is an error, not "no profiles".
2. The dialog collects profile, platforms, caption, description and the
   YouTube / TikTok visibility, then shows a **review** of exactly those
   values. Publishing sends the reviewed values; editing means reviewing
   again. The caption is held to the tightest limit of the selected
   platforms (`captionMax` on `SOCIAL_PLATFORMS`: YouTube 100, X 280,
   Bluesky 300, Threads 500, the rest 2200).
3. `publishSequenceExportFn` checks the caller is a member of the sequence's
   team (a system admin viewing another team's sequence may not post on that
   team's accounts), that the export belongs to the sequence and is `ready`,
   absolutizes its URL (`toShareableUrl`) and hands it to Upload-Post **by
   URL** with `async_upload=true`. Upload-Post fetches the MP4 itself and
   answers in seconds, so the Worker never streams the file (#1893) and never
   waits on the platforms. A render whose URL is not public https (localhost,
   a bare IP) cannot be fetched, so publishing is refused there.
4. `getSocialPublishStatusFn` — the dialog polls the per-platform outcome.
   Replies follow <https://docs.upload-post.com/api/upload-status/>; an
   unrecognised top-level status throws, and an unknown per-platform status is
   `pending`, never `failed`.

## Never twice

Publishing is a public side effect, so the rules are:

- The request id is **derived** from every reviewed value — team, export,
  profile, platforms, caption, description, and the visibility of the
  platforms that use one (`derivePublishRequestId`, client-safe so the dialog
  can compute it too). The same publish always has the same id; changing
  anything makes a new one.
- The id is sent as `request_id` **and** `Idempotency-Key`, and it is looked
  up before sending: if Upload-Post already has it, the call returns
  `resumed` and sends nothing. If the lookup itself fails, nothing is sent
  (`not_sent`) — past the provider's 24-hour idempotency window the lookup is
  the only guard.
- Every refusal before sending, and a 4xx that proves Upload-Post refused the
  request (400, 401, 402, 403, 404, 413, 422, 429), is `not_sent`: the user
  may go back, fix it and publish again. A 5xx, 408/409, a timeout or a
  dropped connection says nothing about whether the post exists, so it
  returns `unconfirmed`.
- A thrown error between the browser and our server is also treated as
  "may have gone out": the dialog tracks the id it derived itself instead of
  showing an editable error, because an edited resend would be a new id.
- Once a publish may have gone out, its tracking lives in page memory per
  export, outside the dialog: closing and re-opening shows the same request,
  never a fresh form. "New post" appears only once Upload-Post reports the
  request completed or failed. A reload drops the tracking; the lookup then
  still finds an identical repeat.
- Upload-Post briefly caches "not found", and an unconfirmed call may still be
  registering, so the dialog waits two minutes before saying the post could
  not be confirmed. Polling also stops on an error and after 15 minutes still
  running; both offer "Check again".
