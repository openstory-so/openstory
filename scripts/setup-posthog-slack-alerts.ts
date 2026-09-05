/**
 * #1088 — Wire PostHog → Slack destinations/alerts.
 *
 * Creates (idempotent by name) the product-activity Slack destinations and the
 * error-tracking spike alert described in issue #1088, plus the per-exception
 * alert with a replay link from #1513.
 *
 * Idempotency is by destination NAME: editing a spec below does not update the
 * destination that already exists — delete it in PostHog first, or edit it
 * there.
 *
 * Prerequisites:
 * 1. Slack is connected in PostHog → Settings → Integrations
 * 2. The PostHog Slack app is invited to `#product-alerts` and `#ops-alerts`
 * 3. A personal API key with `hog_function:write` (+ integrations read):
 *    https://us.posthog.com/settings/user-api-keys
 *
 * Usage:
 *   POSTHOG_PERSONAL_API_KEY=phx_… \
 *   POSTHOG_PROJECT_ID=… \
 *   bun scripts/setup-posthog-slack-alerts.ts
 *
 * Optional overrides:
 *   POSTHOG_HOST=https://us.posthog.com
 *   PRODUCT_CHANNEL=#product-alerts
 *   OPS_CHANNEL=#ops-alerts
 *   DRY_RUN=1   # print planned creates only
 */

import { z } from 'zod';

const HOST = (process.env.POSTHOG_HOST ?? 'https://us.posthog.com').replace(
  /\/$/,
  ''
);
const API_KEY = process.env.POSTHOG_PERSONAL_API_KEY;
const PROJECT_ID = process.env.POSTHOG_PROJECT_ID;
const PRODUCT_CHANNEL = process.env.PRODUCT_CHANNEL ?? '#product-alerts';
const OPS_CHANNEL = process.env.OPS_CHANNEL ?? '#ops-alerts';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

if (!API_KEY || !PROJECT_ID) {
  console.error(
    'Required: POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID\n' +
      '  Create a personal API key at https://us.posthog.com/settings/user-api-keys\n' +
      '  Project ID is in Project settings (numeric).'
  );
  process.exit(1);
}

const hogFunctionSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  type: z.string(),
  enabled: z.boolean().optional(),
  deleted: z.boolean().optional(),
});

const hogFunctionListSchema = z.object({
  results: z.array(hogFunctionSchema).default([]),
  next: z.string().nullable().optional(),
});

const integrationSchema = z.object({
  id: z.number(),
  kind: z.string(),
});

const integrationListSchema = z.object({
  results: z.array(integrationSchema).default([]),
});

const createdHogFunctionSchema = z.object({
  id: z.string(),
});

type HogFunctionSummary = z.infer<typeof hogFunctionSchema>;

async function phFetch(
  path: string,
  options?: { method?: string; body?: string }
): Promise<unknown> {
  const headers = new Headers({
    Authorization: `Bearer ${API_KEY}`,
    Accept: 'application/json',
  });
  if (options?.body) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${HOST}${path}`, {
    method: options?.method,
    body: options?.body,
    headers,
  });
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    throw new Error(
      `${options?.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 800)}`
    );
  }
  return data;
}

async function listHogFunctions(): Promise<HogFunctionSummary[]> {
  const out: HogFunctionSummary[] = [];
  let offset = 0;
  const limit = 100;
  for (;;) {
    const page = hogFunctionListSchema.parse(
      await phFetch(
        `/api/projects/${PROJECT_ID}/hog_functions/?limit=${limit}&offset=${offset}`
      )
    );
    out.push(...page.results.filter((r) => !r.deleted));
    if (!page.next || page.results.length < limit) break;
    offset += limit;
  }
  return out;
}

async function listSlackIntegrations(): Promise<
  Array<{ id: number; kind: string }>
> {
  const data = integrationListSchema.parse(
    await phFetch(`/api/projects/${PROJECT_ID}/integrations/`)
  );
  return data.results.filter((i) => i.kind === 'slack');
}

type PropertyFilter = {
  key: string;
  value: string | string[];
  operator: string;
  type: 'event';
};

function eventFilter(eventName: string, properties: PropertyFilter[] = []) {
  return {
    source: 'events',
    events: [
      {
        id: eventName,
        name: eventName,
        type: 'events',
        order: 0,
        properties,
      },
    ],
    filter_test_accounts: true,
  };
}

function productBlocks(title: string, detail: string) {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: title },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: detail },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Person: {person.properties.email ?? event.distinct_id}',
        },
        { type: 'mrkdwn', text: 'Project: <{project.url}|{project.name}>' },
      ],
    },
  ];
}

function spikeBlocks() {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📈 Issue spiking' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '```{event.properties.name}: {substring(event.properties.description, 1, 1000)}```',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'plain_text',
          text: "Exceptions in last 5 minutes: {event.properties.current_bucket_value} ({event.properties.computed_baseline > 0 ? concat(round(event.properties.current_bucket_value / event.properties.computed_baseline), 'x over baseline') : 'no baseline yet'})",
        },
        { type: 'mrkdwn', text: 'Project: <{project.url}|{project.name}>' },
        { type: 'mrkdwn', text: 'Alert: <{source.url}|{source.name}>' },
      ],
    },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Issue' },
          url: '{project.url}/error_tracking/fingerprint/{encodeURLComponent(event.properties.fingerprint)}?timestamp={event.properties.exception_timestamp}&utm_source=alert&utm_campaign=error_tracking_alert&utm_medium=slack',
        },
      ],
    },
  ];
}

/**
 * One message per exception, with the replay cued to the moment it threw
 * (#1513). The spike alert only fires on a *rate* change, so a two-user
 * regression right after a deploy reached nobody.
 *
 * `replay_url` is stamped client-side in `src/components/providers.tsx`; the
 * fallback keeps the button a valid URL when there is no recording (Slack
 * rejects the whole message over one empty button href).
 */
function exceptionBlocks() {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: '💥 Exception' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '```{event.properties.$exception_types}: {substring(event.properties.$exception_values, 1, 1000)}```',
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: 'URL: {event.properties.$current_url}' },
        {
          type: 'mrkdwn',
          text: 'Person: {person.properties.email ?? event.distinct_id}',
        },
        { type: 'mrkdwn', text: 'Project: <{project.url}|{project.name}>' },
      ],
    },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Watch replay' },
          url: "{empty(event.properties.replay_url) ? concat(project.url, '/replay/', event.properties.$session_id) : event.properties.replay_url}",
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View issue' },
          url: '{project.url}/error_tracking/fingerprint/{encodeURLComponent(event.properties.$exception_fingerprint)}?timestamp={event.timestamp}&utm_source=alert&utm_campaign=exception_alert&utm_medium=slack',
        },
      ],
    },
  ];
}

type DestinationSpec = {
  name: string;
  type: 'destination' | 'internal_destination';
  event: string;
  channel: string;
  text: string;
  blocks: unknown[];
  properties?: PropertyFilter[];
};

function specs(): DestinationSpec[] {
  return [
    {
      name: `Product · user_signed_up · ${PRODUCT_CHANNEL} (#1088)`,
      type: 'destination',
      event: 'user_signed_up',
      channel: PRODUCT_CHANNEL,
      // Prefer person email (set via identify/$set on signup, #1110); fall
      // back to event property email, then distinct_id.
      text: 'New signup: {person.properties.email ?? event.properties.email ?? event.distinct_id}',
      blocks: productBlocks(
        '🎉 New signup',
        '*{person.properties.email ?? event.properties.email ?? event.distinct_id}* just created an account'
      ),
    },
    {
      name: `Product · user_signed_in · ${PRODUCT_CHANNEL} (#1088)`,
      type: 'destination',
      event: 'user_signed_in',
      channel: PRODUCT_CHANNEL,
      text: 'Sign-in: {person.properties.email ?? event.properties.email ?? event.distinct_id}',
      blocks: productBlocks(
        '👋 User signed in',
        '*{person.properties.email ?? event.properties.email ?? event.distinct_id}* signed in ({event.properties.path ?? "session"})'
      ),
    },
    {
      name: `Product · sequence_generated · ${PRODUCT_CHANNEL} (#1088)`,
      type: 'destination',
      event: 'sequence_generated',
      channel: PRODUCT_CHANNEL,
      text: 'Film started: {person.properties.email ?? event.properties.email ?? event.distinct_id}',
      blocks: productBlocks(
        '🎬 Film / sequence created',
        '*{person.properties.email ?? event.properties.email ?? event.distinct_id}* created a sequence ({event.properties.source ?? "create"}, {event.properties.sequence_count ?? 1} seq, style `{event.properties.style_id}`)'
      ),
    },
    {
      name: `Issue spiking · ${OPS_CHANNEL} (#1088)`,
      type: 'internal_destination',
      event: '$error_tracking_issue_spiking',
      channel: OPS_CHANNEL,
      text: 'Issue spiking: {event.properties.name}',
      blocks: spikeBlocks(),
    },
    {
      name: `Exception · ${OPS_CHANNEL} (#1513)`,
      type: 'destination',
      event: '$exception',
      channel: OPS_CHANNEL,
      text: 'Exception: {event.properties.$exception_types} {event.properties.$exception_values}',
      blocks: exceptionBlocks(),
      properties: [
        // Cancelled fetches, not failures — every navigation away produces one.
        {
          key: '$exception_types',
          value: 'AbortError',
          operator: 'not_icontains',
          type: 'event',
        },
        // Chrome translate rewrites the DOM out from under React; the crashes
        // that follow are the translator's, not ours (see react-errors.ts).
        {
          key: 'page_translated',
          value: 'true',
          operator: 'is_not',
          type: 'event',
        },
      ],
    },
  ];
}

async function ensureDestination(
  existing: HogFunctionSummary[],
  slackWorkspaceId: number,
  spec: DestinationSpec
): Promise<'created' | 'exists' | 'dry-run'> {
  const match = existing.find((f) => f.name === spec.name);
  if (match) {
    console.log(`  ✓ exists: ${spec.name} (${match.id})`);
    return 'exists';
  }

  const payload = {
    type: spec.type,
    template_id: 'template-slack',
    name: spec.name,
    description: 'Created by scripts/setup-posthog-slack-alerts.ts for #1088',
    enabled: true,
    filters: eventFilter(spec.event, spec.properties),
    inputs: {
      slack_workspace: { value: slackWorkspaceId },
      channel: { value: spec.channel },
      text: { value: spec.text },
      blocks: { value: spec.blocks },
    },
  };

  if (DRY_RUN) {
    console.log(`  · dry-run create: ${spec.name}`);
    console.log(JSON.stringify(payload, null, 2));
    return 'dry-run';
  }

  const created = createdHogFunctionSchema.parse(
    await phFetch(`/api/projects/${PROJECT_ID}/hog_functions/`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  );
  console.log(`  + created: ${spec.name} (${created.id})`);
  return 'created';
}

async function main() {
  console.log(`PostHog project ${PROJECT_ID} @ ${HOST}`);
  if (DRY_RUN) console.log('DRY_RUN=1 — no writes');

  const slack = await listSlackIntegrations();
  const primarySlack = slack[0];
  if (!primarySlack) {
    console.error(
      'No Slack integration found. Connect Slack in PostHog → Settings → Integrations first,\n' +
        'then invite the PostHog app to #product-alerts and #ops-alerts.'
    );
    process.exit(1);
  }
  const slackWorkspaceId = primarySlack.id;
  console.log(`Using Slack integration id=${slackWorkspaceId}`);

  const existing = await listHogFunctions();
  console.log(`Found ${existing.length} existing hog functions`);

  let created = 0;
  let skipped = 0;
  for (const spec of specs()) {
    const result = await ensureDestination(existing, slackWorkspaceId, spec);
    if (result === 'created') created += 1;
    if (result === 'exists') skipped += 1;
  }

  console.log('\nDone.');
  console.log(`  created=${created} already_existed=${skipped}`);
  console.log(`
Manual follow-ups (not automated — needs baseline tuning):
  1. Invite the PostHog Slack app to ${PRODUCT_CHANNEL} and ${OPS_CHANNEL}
     (channel details → Integrations → Add apps → PostHog)
  2. Logs ERROR alert → PostHog Logs → Alerts:
     severity error/fatal → destination Slack ${OPS_CHANNEL}
     Simulate against -7d history before enabling (see authoring-log-alerts skill).
  3. Confirm error-tracking spike detection is enabled for the project.
  4. Fire a test: sign up / create a sequence in prod (or capture with posthog-node).
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
