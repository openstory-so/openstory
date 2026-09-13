import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { DependencyGraphView } from '@/ui/docs/dependency-graph-view';
import { GRAPH_MODES, nodeById } from '@/ui/docs/dependency-graph';

const title = 'Dependency graph';
const description =
  'Interactive map of the generation graph: pick anything you can edit and see which prompts, sheets, stills and clips go stale.';

const searchSchema = z.object({
  node: z
    .string()
    .refine((id) => nodeById(id) !== undefined)
    .optional(),
  mode: z.enum(GRAPH_MODES).optional(),
});

// Interactive companion to docs/architecture/prompt-staleness-dependency-graph.md
// (#1595). The graph data lives in `src/ui/docs/dependency-graph.ts` and is
// transcribed from the hash bodies in `src/shots/input-hash.ts`.
export const Route = createFileRoute('/docs/dependency-graph')({
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      { title: `${title} - OpenStory Docs` },
      { name: 'description', content: description },
    ],
  }),
  component: DependencyGraphArticle,
});

function DependencyGraphArticle() {
  const { node = 'character', mode = 'reference-only' } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <article className="flex flex-col gap-8">
      <header>
        <p className="text-sm font-medium text-muted-foreground">
          Developer Guide
        </p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">{title}</h1>
        <p className="mt-2 text-lg text-muted-foreground">{description}</p>
      </header>
      <div className="prose dark:prose-invert max-w-none text-sm">
        <p>
          Every generated artifact stores a hash of the inputs it was made from.
          Staleness is never a flag we set: on every read we recompute the hash
          from the current inputs and compare. A mismatch is{' '}
          <strong>stale</strong>. A row with no stored hash is{' '}
          <strong>untracked</strong> and never stale. Versioned things (green
          border) keep every generation as a row and a pointer picks one.
          Renders record which <em>version</em> of a prompt or sheet they used,
          so selecting a different version is what makes them stale, not editing
          the text.
        </p>
      </div>
      <DependencyGraphView
        node={node}
        mode={mode}
        onChange={(next) =>
          void navigate({
            search: (prev) => ({ ...prev, ...next }),
            replace: true,
          })
        }
      />
    </article>
  );
}
