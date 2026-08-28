import {
  FAQ_ITEMS,
  OPEN_FAIR_BENEFITS,
  PROCESS_STEPS,
  SITE_CONFIG,
  TOP_TIER_FEATURES,
} from '@/lib/marketing/constants';

/**
 * Markdown overview of OpenStory for LLM/agent consumption. Served verbatim
 * at /llms.txt and as the markdown rendition of the homepage when an agent
 * sends `Accept: text/markdown` (#819).
 */
export function buildLlmsTxt(): string {
  const lines: string[] = [];

  lines.push(`# ${SITE_CONFIG.name}`);
  lines.push('');
  lines.push(`> ${SITE_CONFIG.description}`);
  lines.push('');
  lines.push(
    `${SITE_CONFIG.name} is an open source AI video production platform. Paste a script or a one-liner and it builds a multi-scene film with consistent characters and look — then you iterate until you nail it. Fully exportable, and free to self-host.`
  );

  lines.push('');
  lines.push('## How It Works');
  lines.push('');
  for (const step of PROCESS_STEPS) {
    lines.push(`${step.number}. **${step.title}**: ${step.description}`);
  }

  lines.push('');
  lines.push('## Features');
  lines.push('');
  for (const feature of TOP_TIER_FEATURES) {
    lines.push(`- **${feature.title}**: ${feature.description}`);
  }

  lines.push('');
  lines.push('## Open & Fair');
  lines.push('');
  for (const benefit of OPEN_FAIR_BENEFITS) {
    lines.push(`- **${benefit.title}**: ${benefit.description}`);
  }

  lines.push('');
  lines.push('## FAQ');
  lines.push('');
  for (const item of FAQ_ITEMS) {
    lines.push(`### ${item.question}`);
    lines.push('');
    lines.push(item.answer);
    lines.push('');
  }

  lines.push('## API');
  lines.push('');
  lines.push(
    `${SITE_CONFIG.name} has a public HTTP API for agents and scripts: create an AI video sequence from a script in one call then poll its status, or enhance a script on its own (streamed back). The endpoints below are self-describing and need no separate docs.`
  );
  lines.push('');
  lines.push(
    `- API root (instructions, request schema, and HAL links): ${SITE_CONFIG.url}/api/v1`
  );
  lines.push(
    `- OpenAPI 3.1 spec (JSON): ${SITE_CONFIG.url}/api/v1/openapi.json`
  );
  lines.push('');
  lines.push(
    'Authenticate with an API key (create one under Settings → Developer) sent as "Authorization: Bearer <key>" or "x-api-key". POST /api/v1/sequences to create; GET the returned status URL (append ?wait=60s to long-poll) to watch progress. POST /api/v1/scripts/enhance to enhance a script without creating a sequence — the enhanced script streams back as Server-Sent Events.'
  );
  lines.push('');

  lines.push('## Documentation');
  lines.push('');
  lines.push(`- Docs: ${SITE_CONFIG.url}/docs`);
  lines.push(`- Full docs (markdown): ${SITE_CONFIG.url}/docs/llms.md`);
  lines.push('');

  lines.push('## Links');
  lines.push('');
  lines.push(`- Website: ${SITE_CONFIG.url}`);
  lines.push(`- App: ${SITE_CONFIG.url}/`);
  lines.push(`- GitHub: ${SITE_CONFIG.githubHref}`);
  lines.push(`- License: ${SITE_CONFIG.githubHref}/blob/main/LICENSE`);
  lines.push('');

  return lines.join('\n');
}

/** Markdown rendition of the FAQ, built from the same FAQ_ITEMS as llms.txt. */
export function buildFaqMarkdown(): string {
  const lines: string[] = ['# Frequently Asked Questions', ''];
  for (const item of FAQ_ITEMS) {
    lines.push(`## ${item.question}`);
    lines.push('');
    lines.push(item.answer);
    lines.push('');
  }
  return lines.join('\n');
}
