/**
 * Skills & MCP (#2138): connect an agent to OpenStory's MCP server and
 * install the agent skills. Anonymous-browsable; the client signs in when it
 * first calls the server.
 */

import { copyTextToClipboard } from '@/ui/clipboard';
import { SITE_CONFIG } from '@/ui/marketing/constants';
import { Button } from '@/ui/shadcn/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/ui/shadcn/card';
import { createFileRoute } from '@tanstack/react-router';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';

const MCP_URL = `${SITE_CONFIG.url}/mcp`;
const SKILLS_REPO = 'openstory-so/skills';
const CURSOR_INSTALL = `cursor://anysphere.cursor-deeplink/mcp/install?name=openstory&config=${btoa(JSON.stringify({ url: MCP_URL }))}`;

const title = `Skills & MCP — ${SITE_CONFIG.name}`;
const description =
  'Connect Claude, Codex or Cursor to OpenStory over MCP, and install the agent skills.';

export const Route = createFileRoute('/_app/connect')({
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
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle>MCP server</CardTitle>
          <CardDescription>
            Sign in when your client asks. Grants are listed under Settings →
            Developer.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Snippet text={MCP_URL} />
          <Step label="Claude Code">
            <Snippet
              text={`claude mcp add --transport http openstory ${MCP_URL}`}
            />
          </Step>
          <Step label="Codex">
            <Snippet text={`codex mcp add openstory --url ${MCP_URL}`} />
          </Step>
          <Step label="Cursor">
            <div>
              <Button asChild variant="outline">
                <a href={CURSOR_INSTALL}>Add to Cursor</a>
              </Button>
            </div>
          </Step>
          <Step label="Claude app">
            <p className="text-sm text-muted-foreground">
              Settings → Connectors → Add custom connector. Paste the URL above.
            </p>
          </Step>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Skills</CardTitle>
          <CardDescription>
            create-style, create-sequence and stitch. The plugin also connects
            the MCP server.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Step label="Any agent">
            <Snippet text={`npx skills add ${SKILLS_REPO}`} />
          </Step>
          <Step label="Claude Code">
            <Snippet text={`/plugin marketplace add ${SKILLS_REPO}`} />
            <Snippet text="/plugin install openstory@openstory" />
          </Step>
          <Step label="Codex">
            <Snippet text={`codex plugin marketplace add ${SKILLS_REPO}`} />
            <Snippet text="codex plugin add openstory@openstory" />
          </Step>
          <Step label="Grok">
            <Snippet text={`grok plugin marketplace add ${SKILLS_REPO}`} />
            <Snippet text="grok plugin install openstory --trust" />
          </Step>
          <Step label="ChatGPT desktop">
            <p className="text-sm text-muted-foreground">
              Plugins → Add a marketplace → {SKILLS_REPO}. Install OpenStory.
            </p>
          </Step>
          <a
            href={`https://github.com/${SKILLS_REPO}`}
            target="_blank"
            rel="noreferrer"
            className="text-sm underline underline-offset-4"
          >
            {SKILLS_REPO} on GitHub
          </a>
        </CardContent>
      </Card>
    </div>
  );
}

function Step({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{label}</h3>
      {children}
    </div>
  );
}

function Snippet({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!(await copyTextToClipboard(text))) {
      toast.error('Could not copy', { description: 'Select it and copy.' });
      return;
    }
    setCopied(true);
    toast.success('Copied');
  };

  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 overflow-x-auto whitespace-nowrap rounded bg-muted px-2 py-1.5 font-mono text-xs">
        {text}
      </code>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={`Copy ${text}`}
        onClick={() => void copy()}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
