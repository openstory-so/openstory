/**
 * Skills & MCP (#2138): connect an agent to OpenStory's MCP server and
 * install the agent skills. One tab per client; the tab is in the URL.
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

const tabValues = [
  'claude',
  'chatgpt',
  'claude-code',
  'codex',
  'grok',
  'gemini',
  'cursor',
  'cli',
] as const;
type Client = (typeof tabValues)[number];

const clients: readonly {
  value: Client;
  label: string;
  logo: (props: { className?: string }) => ReactNode;
}[] = [
  { value: 'claude', label: 'Claude', logo: ClaudeLogo },
  { value: 'chatgpt', label: 'ChatGPT', logo: OpenAILogo },
  { value: 'claude-code', label: 'Claude Code', logo: ClaudeLogo },
  { value: 'codex', label: 'Codex', logo: OpenAILogo },
  { value: 'grok', label: 'Grok', logo: GrokLogo },
  { value: 'gemini', label: 'Gemini', logo: GeminiLogo },
  { value: 'cursor', label: 'Cursor', logo: CursorLogo },
  { value: 'cli', label: 'CLI', logo: SquareTerminal },
];

const title = `Skills & MCP — ${SITE_CONFIG.name}`;
const description =
  'Use OpenStory from Claude, ChatGPT, Grok, Gemini, Codex or Cursor: connect the MCP server and install the agent skills.';

export const Route = createFileRoute('/_app/connect')({
  validateSearch: z.object({
    tab: z.enum(tabValues).optional().default('claude'),
  }),
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
  const { tab } = Route.useSearch();
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          OpenStory in your agent
        </h1>
        <p className="text-muted-foreground">
          Write, cast and render sequences from the chat you already use.
        </p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          const parsed = z.enum(tabValues).safeParse(value);
          if (parsed.success) {
            void navigate({
              to: '/connect',
              search: { tab: parsed.data },
              replace: true,
            });
          }
        }}
      >
        <TabsList
          variant="line"
          className="w-full justify-start overflow-x-auto"
          aria-label="Client"
        >
          {clients.map(({ value, label, logo: Logo }) => (
            <TabsTrigger key={value} value={value} className="flex-none">
              <Logo className="size-4" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="claude" className="flex flex-col gap-4 pt-4">
          <Steps>
            <li>Add the OpenStory connector. Claude fills in the URL.</li>
            <li>Sign in to OpenStory when Claude asks.</li>
            <li>Ask Claude for a sequence.</li>
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
            <li>
              In the ChatGPT desktop app, open Plugins and choose Add a
              marketplace.
            </li>
            <li>Enter the marketplace below and install OpenStory.</li>
            <li>Sign in to OpenStory when ChatGPT asks.</li>
          </Steps>
          <Terminal label="Marketplace" lines={[SKILLS_REPO]} prompt={false} />
          <Note>
            Desktop only: the plugin ships an MCP server, which chatgpt.com in a
            browser does not run.
          </Note>
        </TabsContent>

        <TabsContent value="claude-code" className="flex flex-col gap-4 pt-4">
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
            comment="Run this in your terminal."
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
            comment="Run this in your terminal."
            lines={[`codex mcp add openstory --url ${MCP_URL}`]}
          />
        </TabsContent>

        <TabsContent value="grok" className="flex flex-col gap-4 pt-4">
          <Steps>
            <li>On grok.com, open Connectors and add a custom connector.</li>
            <li>Paste the URL below and sign in to OpenStory when asked.</li>
          </Steps>
          <McpUrl />
          <Terminal
            label="Grok Build"
            comment="Run these in your terminal."
            lines={[
              `grok plugin marketplace add ${SKILLS_REPO}`,
              'grok plugin install openstory --trust',
            ]}
          />
          <PluginNote />
        </TabsContent>

        <TabsContent value="gemini" className="flex flex-col gap-4 pt-4">
          <Steps>
            <li>
              In the Gemini app, open Settings, then Connected apps, then Custom
              apps.
            </li>
            <li>Paste the URL below and sign in to OpenStory when asked.</li>
          </Steps>
          <McpUrl />
          <Terminal
            label="Gemini CLI"
            comment="Run these in your terminal."
            lines={[
              `gemini mcp add --transport http openstory ${MCP_URL}`,
              `npx skills add ${SKILLS_REPO}`,
            ]}
          />
        </TabsContent>

        <TabsContent value="cursor" className="flex flex-col gap-4 pt-4">
          <Steps>
            <li>Add the MCP server. Cursor asks you to confirm.</li>
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
            lines={[`npx skills add ${SKILLS_REPO}`]}
          />
        </TabsContent>

        <TabsContent value="cli" className="flex flex-col gap-4 pt-4">
          <Terminal
            label="Any agent"
            comment="Installs the skills into the agents it finds."
            lines={[`npx skills add ${SKILLS_REPO}`]}
          />
          <Note>
            create-style, create-sequence and stitch. With no MCP server, the
            skills call the HTTP API and sign in with a device code.
          </Note>
          <McpUrl />
        </TabsContent>
      </Tabs>

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
