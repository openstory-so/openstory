---
name: slack-alerts
description: >
  Add, change or check the PostHog → Slack alerts (product activity, generated
  content, errors) through the PostHog MCP. Use when asked to "post X to
  Slack", "alert on X", "add a Slack notification", "sync the Slack alerts",
  or whether the alerts in PostHog match the repo. The alerts are defined in
  alerts.json next to this file; that file is the source of truth.
---

# Slack alerts

`alerts.json` (next to this file) lists every PostHog → Slack alert. Each
entry is exactly what the PostHog function gets: `name`, `type`
(`destination`, or `internal_destination` for PostHog's own events),
`channel` (a `#name`), `filters`, `text`, `blocks`, optional `masking`
(de-duplication), and a `why` for anything non-obvious. Change alerts by
editing this file, then syncing. Never create or edit an alert only in
PostHog: the next sync reports it or overwrites it.

All calls go through the PostHog MCP (`mcp__posthog__exec`). Run `info <tool>`
once before the first `call` of each tool.

## Adding an alert

1. Confirm the event is captured and reaches production: find the
   `captureProductEvent` / `posthog.capture` call, then
   `call execute-sql` for a recent count of the event.
2. Add an entry to `alerts.json`, copying a neighbour's shape. Name it
   `<Area> · <event> · #<channel> (#<issue>)`. Product alerts use
   `filters.source: "events"` with `filter_test_accounts: true`; PostHog's
   own events (`$error_tracking_issue_spiking`) use `internal-events` and no
   test-account filter, or they never fire.
3. Sync (below). Commit `alerts.json` in the same PR as the code that emits
   the event.

## Syncing

1. `call project-get {}` and check the id is **379820** (Production). The MCP
   can default to Staging; if it does, switch it to Production
   (`search switch`), or stop and say so. Never sync against another project.
2. Look up the Slack connection and channels: `call integrations-list` (kind
   `slack`), then `call integrations-channels-retrieve {"id": <id>}`. PostHog
   stores channels as ids (`C0…`); map each `#name` in the file to its id
   before comparing.
3. `call --json cdp-functions-list {"type":["destination","internal_destination"],"limit":1000}`
   (`--json`, or the filters are hidden) and match each file entry to a live
   function by `name`. For a match, `call --json cdp-functions-retrieve {"id": …}`
   and compare only these:
   - `type`: PostHog can't change it in place, so a mismatch means deleting
     the function (with a yes) and creating it again;
   - the channel, as an id;
   - `text` and `blocks`;
   - `filters`: `source`, each event's `id` and `properties`, and
     `filter_test_accounts`;
   - `masking`: `ttl` and `hash`.

   Ignore key order. PostHog adds fields (`bytecode`, `bytecode_contract`)
   and drops empty ones: a missing `properties` equals `[]`, a missing
   `filter_test_accounts` equals `false`, and an event's `name` and `order`
   aren't compared at all. Don't compare `hog`, `description`, `enabled`,
   `icon_emoji` or `username`; a sync never changes them.

4. Show the plan before writing anything:
   - **Create**: in the file, not in PostHog.
   - **Update**: in both, but different. Name each difference as block type
     plus field (`header text`, `image alt_text`, `section text`) and show
     both versions. Work out which side moved: compare the function's
     `updated_at` with the last change to `alerts.json`
     (`git log -1 --format=%cI -- alerts.json`). If PostHog is newer, it's
     someone's edit there: ask whether to keep it (copy it into the file) or
     overwrite it. When several functions differ the same way, ask once for
     the group.
   - **Not in the file**: live functions using `template-slack` whose name
     isn't in the file. Skip functions whose `filters.properties` has an
     `alert_id` entry; PostHog made those for its own logs and insight
     alerts. Ask whether to add each one to the file or delete it; never
     delete without a yes.
   - **Disabled**: report it; don't switch it back on.
5. Apply what the person agreed to:
   - Create with `call cdp-functions-create`, `template_id: "template-slack"`,
     `enabled: false`, and inputs `slack_workspace` (the integration id),
     `channel`, `text`, `blocks`, plus `filters` and `masking`. Test it with
     `call cdp-functions-invocations-create` (`mock_async_functions: true`, a
     sample event in `globals`) and check the rendered message in the logs.
     Then `call cdp-functions-partial-update {"id": …, "enabled": true}`.
   - Update with `call cdp-functions-partial-update`, sending the whole
     `inputs` object (`slack_workspace`, `channel`, `text`, `blocks`) and
     `filters`, plus the file's whole `masking` object when it has one. Don't send `hog`: some
     older functions run an earlier version of the Slack template's code, and
     they keep it.
6. Give the person a link to each created or changed function
   (`call generate-app-url {"url": "/functions/{id}", "params": {"id": …}}`).
