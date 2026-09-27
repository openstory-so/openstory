/**
 * #1088 — Wire PostHog → Slack destinations/alerts (credit purchases: #1856).
 *
 * The Slack alerts PostHog sends, as code: the product-activity destinations
 * and error-tracking spike alert from #1088, the per-exception alert with a
 * replay link from #1513, and the rest listed in `specs()`.
 *
 * This file is the source of truth (#1859). Each run matches alerts by NAME:
 * a missing alert is created, and an existing one whose channel, message,
 * blocks or event filter differs from its spec is updated to match. Edits made
 * in PostHog are overwritten, so make them here. Alerts in PostHog that no
 * spec names are listed and left alone; a disabled alert stays disabled.
 *
 * Prerequisites:
 * 1. Slack is connected in PostHog → Settings → Integrations
 * 2. The PostHog Slack app is invited to `#product-alerts`, `#ops-alerts`,
 *    and `#generated-content`
 * 3. A personal API key with `hog_function:write` (+ integrations read):
 *    https://us.posthog.com/settings/user-api-keys — put it and the project
 *    id in `.env.local` (Bun loads it) as POSTHOG_PERSONAL_API_KEY and
 *    POSTHOG_PROJECT_ID.
 *
 * Usage:
 *   DRY_RUN=1 bun scripts/setup-posthog-slack-alerts.ts   # plan + drift, no writes
 *   bun scripts/setup-posthog-slack-alerts.ts             # apply
 *
 * Optional overrides:
 *   POSTHOG_HOST=https://us.posthog.com
 *   PRODUCT_CHANNEL=#product-alerts
 *   OPS_CHANNEL=#ops-alerts
 *   CONTENT_CHANNEL=#generated-content
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
const CONTENT_CHANNEL = process.env.CONTENT_CHANNEL ?? '#generated-content';
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
  template: z.object({ id: z.string() }).nullable().optional(),
  filters: z
    .object({
      properties: z.array(z.object({ key: z.string() })).optional(),
    })
    .nullable()
    .optional(),
});

/**
 * A destination PostHog made for one of its own alerts (a logs or insight
 * alert) is filtered on that alert's id and managed there, not here.
 */
const ownedByPostHogAlert = (f: HogFunctionSummary): boolean =>
  (f.filters?.properties ?? []).some((p) => p.key === 'alert_id');

/** The parts of a live alert the file owns; everything else is PostHog's. */
const hogFunctionDetailSchema = z.object({
  id: z.string(),
  type: z.string(),
  enabled: z.boolean(),
  filters: z
    .object({
      events: z
        .array(
          z.object({
            id: z.string(),
            properties: z.array(z.unknown()).optional(),
          })
        )
        .default([]),
      source: z.string().optional(),
      filter_test_accounts: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  inputs: z
    .record(z.string(), z.object({ value: z.unknown() }).nullable())
    .nullable()
    .optional(),
});

const slackChannelListSchema = z.object({
  channels: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
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

/**
 * An internal destination listens to PostHog's own events (an issue spiking),
 * which arrive on the internal-events source and carry no person, so the
 * test-account filter doesn't apply. On the events source it never fires.
 */
function eventFilter(spec: DestinationSpec) {
  const internal = spec.type === 'internal_destination';
  return {
    source: internal ? 'internal-events' : 'events',
    events: [
      {
        id: spec.event,
        name: spec.event,
        type: 'events',
        order: 0,
        properties: spec.properties ?? [],
      },
    ],
    filter_test_accounts: !internal,
  };
}

function contentBlocks(opts: {
  header: string;
  detail: string;
  imageUrl?: string;
  buttonLabel: string;
  buttonUrl: string;
}) {
  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: opts.header },
    },
  ];
  if (opts.imageUrl) {
    blocks.push({
      type: 'image',
      image_url: opts.imageUrl,
      alt_text: opts.header,
    });
  }
  blocks.push(
    {
      type: 'section',
      text: { type: 'mrkdwn', text: opts.detail },
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
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: opts.buttonLabel },
          url: opts.buttonUrl,
        },
      ],
    }
  );
  return blocks;
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
 * `replay_url` is stamped client-side in `src/ui/providers.tsx`; the
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
      name: `Product · welcome_card_setup_opened · ${PRODUCT_CHANNEL} (#1667)`,
      type: 'destination',
      event: 'welcome_card_setup_opened',
      channel: PRODUCT_CHANNEL,
      text: 'Adding a card: {person.properties.email ?? event.distinct_id}',
      blocks: productBlocks(
        '💳 Adding a card',
        '*{person.properties.email ?? event.distinct_id}* opened Stripe to save a payment method'
      ),
    },
    {
      name: `Product · welcome_credits_granted · ${PRODUCT_CHANNEL} (#1667)`,
      type: 'destination',
      event: 'welcome_credits_granted',
      channel: PRODUCT_CHANNEL,
      text: 'Welcome credits: {person.properties.email ?? event.distinct_id}',
      blocks: productBlocks(
        '🎁 Welcome credits',
        '*{person.properties.email ?? event.distinct_id}* saved a card and received {event.properties.amount_usd} USD ({event.properties.source})'
      ),
    },
    {
      name: `Product · checkout_completed · ${PRODUCT_CHANNEL} (#1856)`,
      type: 'destination',
      event: 'checkout_completed',
      channel: PRODUCT_CHANNEL,
      text: 'Credits bought: {person.properties.email ?? event.distinct_id} · {event.properties.amount_usd} USD',
      blocks: productBlocks(
        '💳 Credits bought',
        "*{person.properties.email ?? event.distinct_id}* bought {event.properties.amount_usd} USD of credits ({event.properties.method == 'saved_card' ? 'saved card' : 'Stripe checkout'})"
      ),
    },
    {
      name: `Content · studio_generation_completed image · ${CONTENT_CHANNEL} (#1667)`,
      type: 'destination',
      event: 'studio_generation_completed',
      channel: CONTENT_CHANNEL,
      text: 'Studio still: {person.properties.email ?? event.distinct_id}',
      properties: [
        { key: 'activity', value: 'image', operator: 'exact', type: 'event' },
      ],
      blocks: contentBlocks({
        header: '🖼 Studio still',
        detail:
          '*{person.properties.email ?? event.distinct_id}* generated a still (`{event.properties.model}`)\n>{substring(event.properties.prompt, 1, 280)}',
        imageUrl: '{event.properties.preview_url}',
        buttonLabel: 'Open in Images',
        buttonUrl: '{event.properties.watch_url}',
      }),
    },
    {
      name: `Content · studio_generation_completed video · ${CONTENT_CHANNEL} (#1667)`,
      type: 'destination',
      event: 'studio_generation_completed',
      channel: CONTENT_CHANNEL,
      text: 'Studio clip: {person.properties.email ?? event.distinct_id}',
      properties: [
        { key: 'activity', value: 'video', operator: 'exact', type: 'event' },
      ],
      blocks: contentBlocks({
        header: '🎬 Studio clip',
        detail:
          '*{person.properties.email ?? event.distinct_id}* generated a clip (`{event.properties.model}`, {event.properties.duration ?? "?"}s)\n<{event.properties.media_url}|Play>\n>{substring(event.properties.prompt, 1, 280)}',
        buttonLabel: 'Open in Videos',
        buttonUrl: '{event.properties.watch_url}',
      }),
    },
    {
      name: `Content · sequence_content_ready · ${CONTENT_CHANNEL} (#1667)`,
      type: 'destination',
      event: 'sequence_content_ready',
      channel: CONTENT_CHANNEL,
      text: 'Sequence ready: {event.properties.title}',
      blocks: contentBlocks({
        header: '🎞 Sequence ready',
        detail:
          '*{person.properties.email ?? event.distinct_id}* finished *{event.properties.title}*',
        imageUrl: '{event.properties.preview_url}',
        buttonLabel: 'Watch',
        buttonUrl: '{event.properties.watch_url}',
      }),
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

/**
 * Slack channel name → id. PostHog stores whichever it was given, and the UI
 * stores ids, so both sides are compared as ids. A channel the app can't list
 * (private, not invited) compares by its raw string.
 */
async function slackChannelIds(
  integrationId: number
): Promise<Map<string, string>> {
  try {
    const data = slackChannelListSchema.parse(
      await phFetch(
        `/api/projects/${PROJECT_ID}/integrations/${integrationId}/channels/`
      )
    );
    return new Map(data.channels.map((c) => [`#${c.name}`, c.id]));
  } catch (err) {
    console.warn(`  ! could not list Slack channels: ${String(err)}`);
    return new Map();
  }
}

/** Stable JSON: object keys sorted, so key order never reads as drift. */
function canon(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, sort(x)])
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

type Detail = z.infer<typeof hogFunctionDetailSchema>;

/** What the file says an alert's filter is, reduced to what it controls. */
function filterKey(events: Array<{ id: string; properties?: unknown[] }>) {
  return canon({
    events: events.map((e) => ({ id: e.id, properties: e.properties ?? [] })),
  });
}

/** Fields that differ between the live alert and its spec, by name. */
function drift(
  live: Detail,
  spec: DestinationSpec,
  channelIds: Map<string, string>
): string[] {
  const input = (key: string) => live.inputs?.[key]?.value;
  const asId = (c: unknown) =>
    typeof c === 'string' ? (channelIds.get(c) ?? c) : c;
  const out: string[] = [];
  if (live.type !== spec.type) out.push('type');
  if (asId(input('channel')) !== asId(spec.channel)) out.push('channel');
  if (input('text') !== spec.text) out.push('text');
  if (canon(input('blocks')) !== canon(spec.blocks)) out.push('blocks');
  const wanted = eventFilter(spec);
  if (
    filterKey(live.filters?.events ?? []) !== filterKey(wanted.events) ||
    (live.filters?.source ?? 'events') !== wanted.source ||
    (live.filters?.filter_test_accounts ?? false) !==
      wanted.filter_test_accounts
  ) {
    out.push('filter');
  }
  return out;
}

type Outcome = 'created' | 'updated' | 'unchanged' | 'planned';

async function syncDestination(
  existing: HogFunctionSummary[],
  slackWorkspaceId: number,
  channelIds: Map<string, string>,
  spec: DestinationSpec
): Promise<Outcome> {
  const body = {
    filters: eventFilter(spec),
    inputs: {
      slack_workspace: { value: slackWorkspaceId },
      channel: { value: spec.channel },
      text: { value: spec.text },
      blocks: { value: spec.blocks },
    },
  };
  const match = existing.find((f) => f.name === spec.name);

  if (!match) {
    if (DRY_RUN) {
      console.log(`  + would create: ${spec.name}`);
      return 'planned';
    }
    const created = createdHogFunctionSchema.parse(
      await phFetch(`/api/projects/${PROJECT_ID}/hog_functions/`, {
        method: 'POST',
        body: JSON.stringify({
          ...body,
          type: spec.type,
          template_id: 'template-slack',
          name: spec.name,
          description:
            'Created by scripts/setup-posthog-slack-alerts.ts (#1088, #1667)',
          enabled: true,
        }),
      })
    );
    console.log(`  + created: ${spec.name} (${created.id})`);
    return 'created';
  }

  const live = hogFunctionDetailSchema.parse(
    await phFetch(`/api/projects/${PROJECT_ID}/hog_functions/${match.id}/`)
  );
  const off = live.enabled ? '' : ' [disabled in PostHog, left disabled]';
  const fields = drift(live, spec, channelIds);
  if (!fields.length) {
    console.log(`  ✓ matches: ${spec.name}${off}`);
    return 'unchanged';
  }
  if (fields.includes('type')) {
    // PostHog won't change a function's type in place.
    console.log(
      `  ! ${spec.name}: type is ${live.type}, file says ${spec.type}. Delete it in PostHog and re-run.`
    );
    return 'unchanged';
  }
  if (DRY_RUN) {
    console.log(`  ~ would update: ${spec.name} (${fields.join(', ')})${off}`);
    for (const f of fields.filter((x) => x === 'text' || x === 'blocks')) {
      const was = canon(live.inputs?.[f]?.value).slice(0, 300);
      const now = canon(f === 'text' ? spec.text : spec.blocks).slice(0, 300);
      console.log(
        `      ${f} in PostHog: ${was}\n      ${f} in file:    ${now}`
      );
    }
    return 'planned';
  }
  await phFetch(`/api/projects/${PROJECT_ID}/hog_functions/${match.id}/`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  console.log(`  ~ updated: ${spec.name} (${fields.join(', ')})${off}`);
  return 'updated';
}

async function main() {
  console.log(`PostHog project ${PROJECT_ID} @ ${HOST}`);
  if (DRY_RUN) console.log('DRY_RUN=1 — no writes');

  const slack = await listSlackIntegrations();
  const primarySlack = slack[0];
  if (!primarySlack) {
    console.error(
      'No Slack integration found. Connect Slack in PostHog → Settings → Integrations first,\n' +
        'then invite the PostHog app to #product-alerts, #ops-alerts, and #generated-content.'
    );
    process.exit(1);
  }
  const slackWorkspaceId = primarySlack.id;
  console.log(`Using Slack integration id=${slackWorkspaceId}`);

  const existing = await listHogFunctions();
  console.log(`Found ${existing.length} existing hog functions`);
  const channelIds = await slackChannelIds(slackWorkspaceId);

  const all = specs();
  const counts: Record<Outcome, number> = {
    created: 0,
    updated: 0,
    unchanged: 0,
    planned: 0,
  };
  for (const spec of all) {
    counts[
      await syncDestination(existing, slackWorkspaceId, channelIds, spec)
    ] += 1;
  }

  // Slack alerts made in PostHog that no spec names: reported, never touched.
  const named = new Set(all.map((s) => s.name));
  const unmanaged = existing.filter(
    (f) =>
      f.template?.id === 'template-slack' &&
      !ownedByPostHogAlert(f) &&
      !named.has(f.name ?? '')
  );
  if (unmanaged.length) {
    console.log('\nSlack alerts in PostHog that this file does not define:');
    for (const f of unmanaged) {
      console.log(
        `  ? ${f.name ?? '(unnamed)'} (${f.id})${f.enabled === false ? ' [disabled]' : ''}`
      );
    }
    console.log('  Add a spec for each one you want kept, or delete it.');
  }

  console.log(`\n${DRY_RUN ? 'Planned (no writes).' : 'Done.'}`);
  console.log(
    `  created=${counts.created} updated=${counts.updated} unchanged=${counts.unchanged} planned=${counts.planned}`
  );
  console.log(`
Manual follow-ups (not automated — needs baseline tuning):
  1. Invite the PostHog Slack app to ${PRODUCT_CHANNEL}, ${OPS_CHANNEL}, and ${CONTENT_CHANNEL}
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
