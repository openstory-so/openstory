/**
 * Skills & MCP (#2138): connect an agent to OpenStory's MCP server and
 * install the agent skills. One tab per chat app, and a CLI tab with one
 * tab per coding agent; both are in the URL.
 * Anonymous-browsable: the client signs in when it first calls the server.
 */

import {
  ClaudeLogo,
  CursorLogo,
  GeminiLogo,
  GrokLogo,
  OpenAILogo,
} from '@/ui/icons/agent-logos';
import { copyTextToClipboard } from '@/ui/clipboard';
import { SITE_CONFIG } from '@/ui/marketing/constants';
import { Button } from '@/ui/shadcn/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/shadcn/tabs';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Check, Copy, SquareTerminal } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

const MCP_URL = `${SITE_CONFIG.url}/mcp`;
const SKILLS_REPO = 'openstory-so/skills';

const CLAUDE_CONNECT = `https://claude.ai/customize/connectors?${new URLSearchParams(
  {
    modal: 'add-custom-connector',
    connectorName: SITE_CONFIG.name,
    connectorUrl: MCP_URL,
  }
).toString()}`;
const CURSOR_CONNECT = `cursor://anysphere.cursor-deeplink/mcp/install?${new URLSearchParams(
  { name: 'openstory', config: btoa(JSON.stringify({ url: MCP_URL })) }
).toString()}`;

type Logo = (props: { className?: string }) => ReactNode;

const appValues = ['claude', 'chatgpt', 'grok', 'gemini', 'cli'] as const;
const apps: readonly {
  value: (typeof appValues)[number];
  label: string;
  logo: Logo;
}[] = [
  { value: 'claude', label: 'Claude', logo: ClaudeLogo },
  { value: 'chatgpt', label: 'ChatGPT', logo: OpenAILogo },
  { value: 'grok', label: 'Grok', logo: GrokLogo },
  { value: 'gemini', label: 'Gemini', logo: GeminiLogo },
  { value: 'cli', label: 'CLI', logo: SquareTerminal },
];

const agentValues = [
  'claude-code',
  'codex',
  'grok-build',
  'gemini-cli',
  'cursor',
  'other',
] as const;
const agents: readonly {
  value: (typeof agentValues)[number];
  label: string;
  logo: Logo;
}[] = [
  { value: 'claude-code', label: 'Claude Code', logo: ClaudeLogo },
  { value: 'codex', label: 'Codex', logo: OpenAILogo },
  { value: 'grok-build', label: 'Grok Build', logo: GrokLogo },
  { value: 'gemini-cli', label: 'Gemini CLI', logo: GeminiLogo },
  { value: 'cursor', label: 'Cursor', logo: CursorLogo },
  { value: 'other', label: 'Other', logo: SquareTerminal },
];

/** Each maps to tools the MCP server has: studio images and videos, sequences, music and export. */
const examplePrompts = [
  'Make three portraits of my lead character in different outfits.',
  'Turn this photo into a short video.',
  'Turn this script into a sequence with consistent characters.',
  'Score my sequence and export it as an MP4.',
] as const;

const searchSchema = z.object({
  tab: z.enum(appValues).optional().default('claude'),
  agent: z.enum(agentValues).optional(),
});

const title = `Skills & MCP — ${SITE_CONFIG.name}`;
const description =
  'Use OpenStory from Claude, ChatGPT, Grok, Gemini or your coding agent: install the plugin or connect the MCP server.';

export const Route = createFileRoute('/_app/connect')({
  validateSearch: searchSchema,
  component: ConnectPage,
  staticData: { breadcrumb: 'Skills & MCP' },
  head: () => ({
    meta: [
      { title },
      { name: 'description', content: description },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:url', content: `${SITE_CONFIG.url}/connect` },
    ],
  }),
});

function ConnectPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const select = (next: Partial<z.output<typeof searchSchema>>) =>
    void navigate({
      to: '/connect',
      search: { ...search, ...next },
      replace: true,
    });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          OpenStory in your agent
        </h1>
        <p className="text-muted-foreground">
          Make images, videos and whole sequences from the chat you already use.
        </p>
      </div>

      <Tabs
        value={search.tab}
        onValueChange={(value) => {
          const parsed = z.enum(appValues).safeParse(value);
          if (parsed.success) select({ tab: parsed.data });
        }}
      >
        <TabLogos label="App" items={apps} />

        <TabsContent value="claude" className="flex flex-col gap-4 pt-4">
          <Steps>
            <li>Connect in Claude. The name and URL are filled in.</li>
            <li>Sign in to OpenStory when Claude asks.</li>
          </Steps>
          <div>
            <Button asChild>
              <a href={CLAUDE_CONNECT} target="_blank" rel="noreferrer">
                Connect in Claude
              </a>
            </Button>
          </div>
          <McpUrl />
        </TabsContent>

        <TabsContent value="chatgpt" className="flex flex-col gap-4 pt-4">
          <Steps>
            <li>Add the OpenStory marketplace with the command below.</li>
            <li>
              Restart the ChatGPT desktop app, then install OpenStory from
              Plugins → Personal.
            </li>
            <li>Sign in to OpenStory when ChatGPT asks.</li>
          </Steps>
          <Terminal
            label="OpenStory plugin"
            comment="Run this in your terminal (needs the Codex CLI)."
            lines={[`codex plugin marketplace add ${SKILLS_REPO}`]}
          />
          <PluginNote />
          <Note>
            The plugin runs in the desktop app. On chatgpt.com, open Plugins,
            select +, then Add custom MCP server, and paste the URL below.
          </Note>
          <McpUrl />
        </TabsContent>

        <TabsContent value="grok" className="flex flex-col gap-4 pt-4">
          <Steps>
            <li>
              Open grok.com/connectors, select New Connector, then Custom.
            </li>
            <li>Paste the URL below and sign in to OpenStory.</li>
          </Steps>
          <McpUrl />
        </TabsContent>

        <TabsContent value="gemini" className="flex flex-col gap-4 pt-4">
          <Steps>
            <li>
              Open gemini.google.com, then Settings, Connected Apps, Add a
              custom app.
            </li>
            <li>Paste the URL below, select Next and sign in to OpenStory.</li>
          </Steps>
          <McpUrl />
          <Note>
            Custom apps need a personal Google account in the US, for now.
          </Note>
        </TabsContent>

        <TabsContent value="cli" className="flex flex-col gap-4 pt-4">
          <Tabs
            value={search.agent ?? 'claude-code'}
            onValueChange={(value) => {
              const parsed = z.enum(agentValues).safeParse(value);
              if (parsed.success) select({ agent: parsed.data });
            }}
          >
            <TabLogos label="Coding agent" items={agents} />

            <TabsContent
              value="claude-code"
              className="flex flex-col gap-4 pt-4"
            >
              <Terminal
                label="Claude Code"
                comment="Paste these into Claude Code."
                lines={[
                  `/plugin marketplace add ${SKILLS_REPO}`,
                  '/plugin install openstory@openstory',
                ]}
              />
              <PluginNote />
              <Terminal
                label="MCP server only"
                comment="Run this, then /mcp in Claude Code to sign in."
                lines={[`claude mcp add --transport http openstory ${MCP_URL}`]}
              />
            </TabsContent>

            <TabsContent value="codex" className="flex flex-col gap-4 pt-4">
              <Terminal
                label="Codex"
                comment="Run these in your terminal."
                lines={[
                  `codex plugin marketplace add ${SKILLS_REPO}`,
                  'codex plugin add openstory@openstory',
                ]}
              />
              <PluginNote />
              <Terminal
                label="MCP server only"
                comment="Run these in your terminal."
                lines={[
                  `codex mcp add openstory --url ${MCP_URL}`,
                  'codex mcp login openstory',
                ]}
              />
            </TabsContent>

            <TabsContent
              value="grok-build"
              className="flex flex-col gap-4 pt-4"
            >
              <Terminal
                label="Grok Build"
                comment="Run this in your terminal."
                lines={[`grok plugin install ${SKILLS_REPO} --trust`]}
              />
              <PluginNote />
              <Terminal
                label="MCP server only"
                comment="Run this in your terminal."
                lines={[`grok mcp add openstory ${MCP_URL}`]}
              />
            </TabsContent>

            <TabsContent
              value="gemini-cli"
              className="flex flex-col gap-4 pt-4"
            >
              <Terminal
                label="Gemini CLI"
                comment="Run these, then /mcp auth openstory in Gemini CLI to sign in."
                lines={[
                  `gemini mcp add --transport http openstory ${MCP_URL}`,
                  `npx skills add ${SKILLS_REPO} -a gemini-cli`,
                ]}
              />
            </TabsContent>

            <TabsContent value="cursor" className="flex flex-col gap-4 pt-4">
              <Steps>
                <li>Add to Cursor, and confirm in Cursor.</li>
                <li>Sign in to OpenStory when Cursor asks.</li>
              </Steps>
              <div>
                <Button asChild>
                  <a href={CURSOR_CONNECT}>Add to Cursor</a>
                </Button>
              </div>
              <Terminal
                label="Skills"
                comment="Run this in your project."
                lines={[`npx skills add ${SKILLS_REPO} -a cursor`]}
              />
            </TabsContent>

            <TabsContent value="other" className="flex flex-col gap-4 pt-4">
              <Terminal
                label="Any agent"
                comment="Installs the skills into the agents it finds."
                lines={[`npx skills add ${SKILLS_REPO}`]}
              />
              <Note>
                create-style, create-sequence and stitch. With no MCP server,
                the skills call the HTTP API and sign in with a device code.
              </Note>
              <McpUrl />
            </TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>

      <section className="flex flex-col gap-3" aria-labelledby="ask-heading">
        <h2 id="ask-heading" className="text-lg font-semibold">
          What you can ask
        </h2>
        <ul className="flex flex-col gap-2 text-sm">
          {examplePrompts.map((prompt) => (
            <li key={prompt} className="rounded-lg border px-3 py-2">
              {prompt}
            </li>
          ))}
        </ul>
      </section>

      <a
        href={`https://github.com/${SKILLS_REPO}`}
        target="_blank"
        rel="noreferrer"
        className="text-sm text-muted-foreground underline underline-offset-4"
      >
        {SKILLS_REPO} on GitHub
      </a>
    </div>
  );
}

function TabLogos({
  label,
  items,
}: {
  label: string;
  items: readonly { value: string; label: string; logo: Logo }[];
}) {
  return (
    <TabsList
      variant="line"
      className="w-full justify-start overflow-x-auto"
      aria-label={label}
    >
      {items.map(({ value, label: itemLabel, logo: ItemLogo }) => (
        <TabsTrigger key={value} value={value} className="flex-none">
          <ItemLogo className="size-4" />
          {itemLabel}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="flex list-inside list-decimal flex-col gap-1 text-sm">
      {children}
    </ol>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function PluginNote() {
  return (
    <Note>
      Installs create-style, create-sequence and stitch, and connects the MCP
      server. Sign in when asked.
    </Note>
  );
}

function McpUrl() {
  return <Terminal label="MCP server URL" lines={[MCP_URL]} prompt={false} />;
}

/** A terminal-style block with one copy button for all its lines. */
function Terminal({
  label,
  comment,
  lines,
  prompt = true,
}: {
  label: string;
  comment?: string;
  lines: readonly string[];
  prompt?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!(await copyTextToClipboard(lines.join('\n')))) {
      toast.error('Could not copy', { description: 'Select it and copy.' });
      return;
    }
    setCopied(true);
    toast.success('Copied');
  };

  return (
    <div className="flex flex-col rounded-lg border bg-muted/50">
      <div className="flex items-center gap-3 border-b px-3 py-1">
        <div className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-muted-foreground/30" />
          <span className="size-2.5 rounded-full bg-muted-foreground/30" />
          <span className="size-2.5 rounded-full bg-muted-foreground/30" />
        </div>
        <span className="flex-1 font-mono text-xs tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Copy ${label}`}
          onClick={() => void copy()}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-sm">
        {comment && (
          <span className="text-muted-foreground">{`# ${comment}\n`}</span>
        )}
        {lines.map((line, i) => (
          <span key={line}>
            {prompt && <span className="text-muted-foreground">❯ </span>}
            {i < lines.length - 1 ? `${line}\n` : line}
          </span>
        ))}
      </pre>
    </div>
  );
}
