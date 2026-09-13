import { useState } from 'react';
import { Badge } from '@/ui/shadcn/badge';
import { Button } from '@/ui/shadcn/button';
import { ToggleGroup, ToggleGroupItem } from '@/ui/shadcn/toggle-group';
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
  isGraphMode,
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
const NW = 112;
const NH = 40;
const GAP = 8;
const BAND_Y: Record<Band, number> = {
  settings: 28,
  story: 108,
  references: 208,
  prompts: 308,
  renders: 408,
  cut: 508,
};
const H = BAND_Y.cut + NH + 16;

type Placed = GraphNode & { x: number; y: number };

function place(): Placed[] {
  return BAND_ORDER.flatMap((band) => {
    const row = GRAPH_NODES.filter((n) => n.band === band);
    const total = row.length * NW + (row.length - 1) * GAP;
    const start = (W - total) / 2;
    return row.map((n, i) => ({
      ...n,
      x: start + i * (NW + GAP),
      y: BAND_Y[band],
    }));
  });
}

const PLACED = place();
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

const DASH: Record<Tracking, string | undefined> = {
  hash: undefined,
  pointer: '7 4',
  cascade: '2 4',
  untracked: '1 5',
};

const TRACKING_COPY: Record<Tracking, string> = {
  hash: 'in the input hash',
  pointer: 'by selected version',
  cascade: 'cascade only, never flagged',
  untracked: 'not tracked',
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
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={mode}
          onValueChange={(v) => isGraphMode(v) && onChange({ mode: v })}
          aria-label="Render mode"
        >
          <ToggleGroupItem value="start-frame">Start frames</ToggleGroupItem>
          <ToggleGroupItem value="reference-only">
            Reference only
          </ToggleGroupItem>
        </ToggleGroup>
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
              y={BAND_Y[band] - 8}
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
              const toStale = lit && staleIds.has(e.to);
              return (
                <path
                  key={key}
                  d={edgePath(e)}
                  strokeDasharray={DASH[e.tracking]}
                  strokeLinecap="round"
                  className={cn(
                    'transition-[opacity,stroke] motion-reduce:transition-none',
                    lit
                      ? toStale
                        ? 'stroke-warning stroke-2'
                        : 'stroke-primary stroke-2'
                      : side
                        ? 'stroke-muted-foreground stroke-[1.5]'
                        : 'stroke-border opacity-60'
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
                    className={cn(
                      'transition-[fill,stroke] motion-reduce:transition-none group-focus-visible:stroke-ring group-focus-visible:stroke-2',
                      n.kind === 'input' ? 'fill-background' : 'fill-muted',
                      isActive
                        ? 'stroke-primary stroke-2'
                        : isStale
                          ? 'fill-warning/15 stroke-warning stroke-[1.5]'
                          : isCause
                            ? 'fill-primary/10 stroke-primary/70 stroke-[1.5]'
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
            strokeDasharray={DASH[t]}
            strokeLinecap="round"
            className="stroke-foreground stroke-[1.5]"
          />
        </svg>
        {TRACKING_COPY[t]}
      </li>
    ))}
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
        {node.storedAs && (
          <code className="text-xs text-muted-foreground">{node.storedAs}</code>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{node.summary}</p>
    </header>

    <div className="grid gap-5 sm:grid-cols-2">
      <FieldList title="Counts" items={node.counts} />
      <FieldList title="Does not count" items={node.ignored} />
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
        <h3 className="text-sm font-medium">Feeds it, but not tracked</h3>
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

const FieldList: React.FC<{ title: string; items: string[] }> = ({
  title,
  items,
}) => (
  <div className="flex flex-col gap-2">
    <h3 className="text-sm font-medium">{title}</h3>
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
