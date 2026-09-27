---
name: slack-alerts
description: >
  Add, change or remove a PostHog → Slack alert (product activity, generated
  content, errors). Use when asked to "post X to Slack", "alert on X", "add a
  Slack notification", or to check whether Slack alerts in PostHog match the
  code. The alerts live in one script; never create or edit them in PostHog.
---

# Slack alerts

Every PostHog → Slack alert is a spec in `specs()` in
`scripts/setup-posthog-slack-alerts.ts`. That file is the source of truth: a
run creates missing alerts and updates drifted ones to match, so an alert made
or edited by hand in PostHog is overwritten or reported.

1. Confirm the event is captured: find the `captureProductEvent` /
   `posthog.capture` call and check the event reaches production PostHog
   (project 379820) before alerting on it.
2. Add or edit the spec next to its neighbours. Reuse `productBlocks` /
   `contentBlocks`; name it `<Area> · <event> · ${CHANNEL} (#<issue>)`.
   Alerts on PostHog's own events (`$error_tracking_issue_spiking`) are
   `internal_destination`.
3. Plan, read the output, then apply:

   ```bash
   DRY_RUN=1 bun scripts/setup-posthog-slack-alerts.ts
   bun scripts/setup-posthog-slack-alerts.ts
   ```

   The dry run lists what it would create or update (with the fields that
   differ) and Slack alerts in PostHog the file doesn't define. Anything
   unexpected in "would update" is someone's edit in PostHog: bring it into
   the spec or let the run overwrite it, deliberately.

4. Needs `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` in `.env.local`.
   If they're missing, stop and ask for them; don't recreate the alert by
   hand in PostHog.
