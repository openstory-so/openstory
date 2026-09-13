import { useState } from 'react';
import { Badge } from '@/ui/shadcn/badge';
import { Button } from '@/ui/shadcn/button';
import { Label } from '@/ui/shadcn/label';
import { Switch } from '@/ui/shadcn/switch';
import { cn } from '@/ui/utils';
import {
  UPDATE_STALE_DEPTHS,
  UPDATE_STALE_DEPTH_LABELS,
} from '@/shots/update-stale-depth';
import {
  BAND_LABELS,
  BAND_ORDER,
  edgesForMode,
  GRAPH_NODES,
  type Band,
  type GraphEdge,
  type GraphMode,
  type GraphNode,
  nodeById,
  propagates,
  type Reach,
  staleAfterEdit,
  staleBecauseOf,
  type Tracking,
  TRACKINGS,
} from './dependency-graph';

// --- Layout ---------------------------------------------------------------

const W = 760;
const NW = 100;
const NH = 40;
const GAP = 6;
const PER_ROW = 7;
const ROW_PITCH = 52;
const BAND_GAP = 100;
const TOP = 28;

type Placed = GraphNode & { x: number; y: number };

/** Rows wrap at PER_ROW; bands stack with a gap wide enough for edges. */
function place(): {
  placed: Placed[];
  bandY: Map<Band, number>;
  height: number;
} {
  const placed: Placed[] = [];
  const bandY = new Map<Band, number>();
  let y = TOP;
  for (const band of BAND_ORDER) {
    bandY.set(band, y);
    const nodes = GRAPH_NODES.filter((n) => n.band === band);
    const rows = Math.ceil(nodes.length / PER_ROW);
    for (let r = 0; r < rows; r++) {
      const row = nodes.slice(r * PER_ROW, (r + 1) * PER_ROW);
      const total = row.length * NW + (row.length - 1) * GAP;
      const start = (W - total) / 2;
      row.forEach((n, i) =>
        placed.push({ ...n, x: start + i * (NW + GAP), y: y + r * ROW_PITCH })
      );
    }
    y += (rows - 1) * ROW_PITCH + BAND_GAP;
  }
  return { placed, bandY, height: y - BAND_GAP + NH + 16 };
}

const { placed: PLACED, bandY: BAND_Y, height: H } = place();
const placedById = new Map(PLACED.map((n) => [n.id, n]));

/** Two lines at most; split at the space nearest the middle. */
function wrapLabel(label: string): string[] {
  if (label.length <= 12) return [label];
  const spaces = [...label.matchAll(/ /g)].map((m) => m.index);
  if (spaces.length === 0) return [label];
  const mid = label.length / 2;
  const at = spaces.reduce((best, i) =>
    Math.abs(i - mid) < Math.abs(best - mid) ? i : best
  );
  return [label.slice(0, at), label.slice(at + 1)];
}

function edgePath(e: GraphEdge): string {
  const a = placedById.get(e.from);
  const b = placedById.get(e.to);
  if (!a || !b) return '';
  const sx = a.x + NW / 2;
  const sy = a.y + NH;
  const tx = b.x + NW / 2;
  const ty = b.y;
  const c = (ty - sy) / 2;
  return `M${sx},${sy} C${sx},${sy + c} ${tx},${ty - c} ${tx},${ty}`;
}

/** One colour per edge kind; a lit edge keeps its colour and thickens. */
const EDGE_STROKE: Record<Tracking, string> = {
  hash: 'stroke-chart-1',
  pointer: 'stroke-chart-4',
  cascade: 'stroke-chart-3',
  untracked: 'stroke-muted-foreground',
  seeded: 'stroke-chart-5',
};

const TRACKING_COPY: Record<Tracking, string> = {
  hash: 'in the input hash',
  pointer: 'by selected version',
  cascade: 'cascade only, never flagged',
  untracked: 'not tracked',
  seeded: 'seeded once, then yours',
};

// --- View -----------------------------------------------------------------

export type DependencyGraphViewProps = {
  node: string;
  mode: GraphMode;
  onChange: (next: { node?: string; mode?: GraphMode }) => void;
};

export const DependencyGraphView: React.FC<DependencyGraphViewProps> = ({
  node,
  mode,
  onChange,
}) => {
  const [hovered, setHovered] = useState<string | null>(null);
  const active = hovered ?? node;
  const activeNode = nodeById(active);
  const edges = edgesForMode(mode);

  const downstream = staleAfterEdit(active, mode);
  const upstream =
    activeNode?.kind === 'artifact' ? staleBecauseOf(active, mode) : [];
  const staleIds = new Set(downstream.map((r) => r.id));
  const causeIds = new Set(upstream.map((r) => r.id));
  const litEdges = new Set(
    [...downstream, ...upstream].map((r) => edgeKey(r.via))
  );
  const sideEdges = edges.filter(
    (e) => !propagates(e) && (e.from === active || e.to === active)
  );

  const select = (id: string) => onChange({ node: id });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Switch
            id="use-start-frames"
            checked={mode === 'start-frame'}
            onCheckedChange={(on) =>
              onChange({ mode: on ? 'start-frame' : 'reference-only' })
            }
          />
          <Label htmlFor="use-start-frames">Use start frames</Label>
        </div>
        <Legend />
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full min-w-[640px] select-none text-[11px]"
        >
          <title>Dependency graph</title>
          {BAND_ORDER.map((band) => (
            <text
              key={band}
              x={12}
              y={(BAND_Y.get(band) ?? 0) - 8}
              className="fill-muted-foreground text-[9px] font-medium uppercase tracking-wider"
            >
              {BAND_LABELS[band]}
            </text>
          ))}
          <g fill="none">
            {edges.map((e) => {
              const key = edgeKey(e);
              const lit = litEdges.has(key);
              const side =
                !propagates(e) && (e.from === active || e.to === active);
              return (
                <path
                  key={key}
                  d={edgePath(e)}
                  strokeLinecap="round"
                  className={cn(
                    'transition-opacity motion-reduce:transition-none',
                    EDGE_STROKE[e.tracking],
                    lit ? 'stroke-[2.5]' : side ? 'stroke-2' : 'opacity-25'
                  )}
                />
              );
            })}
          </g>
          {PLACED.map((n) => {
            const isActive = n.id === active;
            const isStale = staleIds.has(n.id);
            const isCause = causeIds.has(n.id);
            const dim = !isActive && !isStale && !isCause;
            return (
              <g key={n.id} transform={`translate(${n.x} ${n.y})`}>
                <a
                  href={`?node=${n.id}&mode=${mode}`}
                  aria-current={n.id === node ? 'true' : undefined}
                  aria-label={n.label}
                  className={cn(
                    'group cursor-pointer outline-none transition-opacity motion-reduce:transition-none',
                    dim && 'opacity-45'
                  )}
                  onClick={(ev) => {
                    if (
                      ev.metaKey ||
                      ev.ctrlKey ||
                      ev.shiftKey ||
                      ev.button !== 0
                    ) {
                      return;
                    }
                    ev.preventDefault();
                    select(n.id);
                  }}
                  onMouseEnter={() => setHovered(n.id)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(n.id)}
                  onBlur={() => setHovered(null)}
                >
                  <title>{n.summary}</title>
                  <rect
                    width={NW}
                    height={NH}
                    rx={8}
                    strokeDasharray={n.optional ? '4 3' : undefined}
                    className={cn(
                      'transition-[fill,stroke] motion-reduce:transition-none group-focus-visible:stroke-ring group-focus-visible:stroke-2',
                      n.kind === 'input' ? 'fill-background' : 'fill-muted',
                      isActive
                        ? 'stroke-primary stroke-2'
                        : isStale
                          ? 'fill-warning/15 stroke-warning stroke-[1.5]'
                          : isCause
                            ? 'fill-primary/10 stroke-primary/70 stroke-[1.5]'
                            : n.versionedIn
                              ? 'stroke-chart-2'
                              : 'stroke-border'
                    )}
                  />
                  <text
                    x={NW / 2}
                    y={NH / 2}
                    textAnchor="middle"
                    dominantBaseline="central"
                    className="pointer-events-none fill-foreground font-medium"
                  >
                    {wrapLabel(n.label).map((line, i, lines) => (
                      <tspan
                        key={line}
                        x={NW / 2}
                        dy={i === 0 ? (lines.length === 2 ? -6.5 : 0) : 13}
                      >
                        {line}
                      </tspan>
                    ))}
                  </text>
                </a>
              </g>
            );
          })}
        </svg>
      </div>

      {activeNode && (
        <DetailPanel
          node={activeNode}
          downstream={downstream}
          upstream={upstream}
          sideEdges={sideEdges}
          onSelect={select}
        />
      )}

      <UpdateAllLadder />
    </div>
  );
};

const edgeKey = (e: GraphEdge) => `${e.from}>${e.to}`;

const withNote = (copy: string, note: string | undefined) =>
  note ? `${copy} — ${note}` : copy;

const Legend: React.FC = () => (
  <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
    {TRACKINGS.map((t) => (
      <li key={t} className="flex items-center gap-1.5">
        <svg width="28" height="8" aria-hidden="true">
          <line
            x1="1"
            y1="4"
            x2="27"
            y2="4"
            strokeLinecap="round"
            className={cn('stroke-[2.5]', EDGE_STROKE[t])}
          />
        </svg>
        {TRACKING_COPY[t]}
      </li>
    ))}
    <li className="flex items-center gap-1.5">
      <span className="inline-block size-3 rounded-sm border border-chart-2" />
      versioned
    </li>
    <li className="flex items-center gap-1.5">
      <span className="inline-block size-3 rounded-sm border border-dashed border-foreground" />
      optional
    </li>
    <li className="flex items-center gap-1.5">
      <span className="inline-block size-3 rounded-sm border border-warning bg-warning/15" />
      goes stale
    </li>
    <li className="flex items-center gap-1.5">
      <span className="inline-block size-3 rounded-sm border border-primary/70 bg-primary/10" />
      makes it stale
    </li>
  </ul>
);

// --- Detail panel ---------------------------------------------------------

type DetailPanelProps = {
  node: GraphNode;
  downstream: Reach[];
  upstream: Reach[];
  sideEdges: GraphEdge[];
  onSelect: (id: string) => void;
};

const DetailPanel: React.FC<DetailPanelProps> = ({
  node,
  downstream,
  upstream,
  sideEdges,
  onSelect,
}) => (
  <section
    aria-live="polite"
    className="flex flex-col gap-5 rounded-lg border bg-card p-5"
  >
    <header className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{node.label}</h2>
        <Badge variant="outline">
          {node.kind === 'input' ? 'you edit' : 'generated'}
        </Badge>
        {node.versionedIn && (
          <Badge variant="outline" className="border-chart-2">
            versioned — {node.versionedIn}
          </Badge>
        )}
        {node.optional && (
          <Badge variant="outline" className="border-dashed">
            optional — {node.optional}
          </Badge>
        )}
        {node.storedAs && (
          <code className="text-xs text-muted-foreground">{node.storedAs}</code>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{node.summary}</p>
    </header>

    <div className="grid gap-5 sm:grid-cols-2">
      <FieldList
        title="Counts"
        hint={
          node.kind === 'input'
            ? 'Change one of these and what depends on it goes stale.'
            : 'The check compares these. Change one upstream and this goes stale.'
        }
        items={node.counts}
      />
      <FieldList
        title="Does not count"
        hint="Change these freely. Nothing goes stale."
        items={node.ignored}
      />
    </div>

    <div className="grid gap-5 sm:grid-cols-2">
      <ReachList
        title={
          node.kind === 'input'
            ? 'Edit this and these go stale'
            : 'Regenerate this and these go stale'
        }
        empty="Nothing downstream is tracked."
        reach={downstream}
        origin={node}
        direction="down"
        tone="warning"
        onSelect={onSelect}
      />
      {node.kind === 'artifact' && (
        <ReachList
          title="Goes stale when any of these change"
          empty="Nothing. It is never flagged stale."
          reach={upstream}
          origin={node}
          direction="up"
          tone="primary"
          onSelect={onSelect}
        />
      )}
    </div>

    {sideEdges.length > 0 && (
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Connected, but not tracked</h3>
        <ul className="flex flex-col gap-1 text-sm">
          {sideEdges.map((e) => {
            const other = e.from === node.id ? e.to : e.from;
            const o = nodeById(other);
            if (!o) return null;
            return (
              <li key={edgeKey(e)} className="flex flex-wrap gap-x-2">
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => onSelect(other)}
                >
                  {e.from === node.id ? `→ ${o.label}` : `${o.label} →`}
                </Button>
                <span className="text-muted-foreground">
                  {withNote(TRACKING_COPY[e.tracking], e.note)}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    )}
  </section>
);

const FieldList: React.FC<{ title: string; hint: string; items: string[] }> = ({
  title,
  hint,
  items,
}) => (
  <div className="flex flex-col gap-2">
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
    {items.length === 0 ? (
      <p className="text-sm text-muted-foreground">Nothing.</p>
    ) : (
      <ul className="list-disc pl-5 text-sm text-muted-foreground">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    )}
  </div>
);

type ReachListProps = {
  title: string;
  empty: string;
  reach: Reach[];
  origin: GraphNode;
  direction: 'down' | 'up';
  tone: 'warning' | 'primary';
  onSelect: (id: string) => void;
};

const ReachList: React.FC<ReachListProps> = ({
  title,
  empty,
  reach,
  origin,
  direction,
  tone,
  onSelect,
}) => (
  <div className="flex flex-col gap-2">
    <h3 className="text-sm font-medium">{title}</h3>
    {reach.length === 0 ? (
      <p className="text-sm text-muted-foreground">{empty}</p>
    ) : (
      <ol className="flex flex-col gap-1.5 text-sm">
        {reach.map((r) => {
          const target = nodeById(r.id);
          const viaId = direction === 'down' ? r.via.from : r.via.to;
          const via = nodeById(viaId);
          if (!target) return null;
          return (
            <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
              <span
                aria-hidden="true"
                className={cn(
                  'inline-block size-2 shrink-0 translate-y-px rounded-full',
                  tone === 'warning' ? 'bg-warning' : 'bg-primary'
                )}
              />
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 font-medium"
                onClick={() => onSelect(r.id)}
              >
                {target.label}
              </Button>
              <span className="text-muted-foreground">
                {withNote(
                  viaId === origin.id
                    ? TRACKING_COPY[r.via.tracking]
                    : `via ${via?.label ?? viaId}`,
                  r.via.note
                )}
              </span>
            </li>
          );
        })}
      </ol>
    )}
  </div>
);

// --- Update all -----------------------------------------------------------

const DEPTH_DETAIL: Record<(typeof UPDATE_STALE_DEPTHS)[number], string> = {
  prompts: 'Rewrites stale visual and motion prompts. Nothing renders.',
  images:
    'Also re-renders a still that is stale, or whose prompt was just rewritten. Never renders a first still.',
  video:
    'Also re-renders a clip whose prompt or still changed in this run, or whose manifest already diverged. Never renders a first clip.',
  music:
    'Also rewrites a stale music prompt, then the track if one exists. Never a first track.',
};

const UpdateAllLadder: React.FC = () => (
  <section className="flex flex-col gap-3">
    <h2 className="text-lg font-semibold">What "Update all" regenerates</h2>
    <p className="text-sm text-muted-foreground">
      The depth picker is cumulative. Each rung includes the ones above it, and
      no rung ever creates an artifact that does not exist yet.
    </p>
    <ol className="flex flex-col gap-2">
      {UPDATE_STALE_DEPTHS.map((depth, i) => (
        <li key={depth} className="flex gap-3 text-sm">
          <span className="w-5 shrink-0 tabular-nums text-muted-foreground">
            {i + 1}.
          </span>
          <span>
            <span className="font-medium">
              {UPDATE_STALE_DEPTH_LABELS[depth]}
            </span>
            <span className="text-muted-foreground">
              {' '}
              — {DEPTH_DETAIL[depth]}
            </span>
          </span>
        </li>
      ))}
    </ol>
  </section>
);
