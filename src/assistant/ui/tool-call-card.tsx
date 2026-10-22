/**
 * One tool call as a compact card (#2155): what ran, its key inputs, and
 * its result or error behind a native `<details>`. A call waiting for the
 * user carries Allow / Deny and the estimate when a plan came before it.
 */

import type { ToolCallPart, ToolResultPart } from '@tanstack/ai';
import { Button } from '@/ui/shadcn/button';
import { cn } from '@/ui/utils';

/** "openstory.get_shot_frames" → "Get shot frames". */
function toolTitle(name: string): string {
  const bare = name.replace(/^openstory\./, '').replaceAll('_', ' ');
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

/** Up to three scalar inputs, ids shortened, for the card's one line. */
function keyInputs(input: unknown): Array<[string, string]> {
  if (typeof input !== 'object' || input === null) return [];
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(input)) {
    if (out.length === 3) break;
    if (key === 'confirm' || key === 'planToken') continue;
    if (typeof value === 'string') {
      out.push([key, value.length > 40 ? `${value.slice(0, 39)}…` : value]);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out.push([key, String(value)]);
    }
  }
  return out;
}

type ToolCardStatus = 'running' | 'waiting' | 'done' | 'error';

function toolCardStatus(
  part: ToolCallPart,
  result: ToolResultPart | undefined
): ToolCardStatus {
  if (result?.state === 'error' || part.state === 'error') return 'error';
  if (result?.state === 'complete') return 'done';
  if (part.state === 'approval-requested') return 'waiting';
  if (part.approval && part.approval.approved === false) return 'error';
  return 'running';
}

const STATUS_LABEL: Record<ToolCardStatus, string> = {
  running: 'Running…',
  waiting: 'Needs your OK',
  done: 'Done',
  error: 'Failed',
};

function resultText(result: ToolResultPart | undefined): string {
  if (!result) return '';
  if (result.error) return result.error;
  if (typeof result.content === 'string') {
    try {
      return JSON.stringify(JSON.parse(result.content), null, 2);
    } catch {
      return result.content;
    }
  }
  return result.content
    .map((part) => (part.type === 'text' ? part.content : `[${part.type}]`))
    .join('\n');
}

export type ToolCallCardProps = {
  part: ToolCallPart;
  result?: ToolResultPart;
  /** "$1.20" from the plan that came before an execute call. */
  estimate?: string;
  onApprove?: () => void;
  onDeny?: () => void;
};

export const ToolCallCard: React.FC<ToolCallCardProps> = ({
  part,
  result,
  estimate,
  onApprove,
  onDeny,
}) => {
  const status = toolCardStatus(part, result);
  const inputs = keyInputs(part.input);
  const details = resultText(result);
  const denied = result?.outcome === 'denied';
  return (
    <div
      data-status={status}
      className={cn(
        'flex flex-col gap-2 rounded-lg border bg-card px-3 py-2 text-sm',
        status === 'error' && 'border-destructive/40',
        status === 'waiting' && 'border-ring'
      )}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            'size-2 shrink-0 rounded-full',
            status === 'running' && 'motion-safe:animate-pulse bg-foreground',
            status === 'waiting' && 'bg-ring',
            status === 'done' && 'bg-muted-foreground',
            status === 'error' && 'bg-destructive'
          )}
        />
        <span className="min-w-0 flex-1 truncate font-medium">
          {toolTitle(part.name)}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {denied ? 'Denied' : STATUS_LABEL[status]}
        </span>
      </div>
      {inputs.length > 0 && (
        <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {inputs.map(([key, value]) => (
            <div key={key} className="flex gap-1">
              <dt>{key}</dt>
              <dd className="truncate text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {status === 'waiting' && (
        <div className="flex flex-col gap-2">
          {estimate && (
            <p className="text-xs text-muted-foreground">
              Estimated cost {estimate}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={onApprove}>
              Allow
            </Button>
            <Button size="sm" variant="outline" onClick={onDeny}>
              Deny
            </Button>
          </div>
        </div>
      )}
      {details && (
        <details className="group text-xs">
          <summary className="cursor-pointer text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {status === 'error' ? 'What went wrong' : 'Result'}
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2">
            {details}
          </pre>
        </details>
      )}
    </div>
  );
};
