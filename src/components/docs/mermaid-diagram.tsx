import { useEffect, useId, useState } from 'react';

type MermaidDiagramProps = {
  source: string;
};

function MermaidPlaceholder() {
  return <div className="my-4 flex justify-center overflow-x-auto" />;
}

/**
 * Vite replaces `import.meta.env.SSR` at compile time, so the mermaid
 * dynamic import is dead on the worker/SSR graph and stays a client chunk.
 * mermaid.render() needs a DOM; Workerd does not have one.
 */
async function loadMermaid() {
  if (import.meta.env.SSR) {
    throw new Error('mermaid is client-only');
  }
  return import('mermaid');
}

let initialized = false;
let initializedTheme: 'default' | 'dark' | null = null;

async function ensureInitialized(theme: 'default' | 'dark') {
  const { default: mermaid } = await loadMermaid();
  if (!initialized || initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
    });
    initialized = true;
    initializedTheme = theme;
  }
  return mermaid;
}

const MermaidDiagramClient: React.FC<MermaidDiagramProps> = ({ source }) => {
  const reactId = useId();
  const diagramId = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    void (async () => {
      try {
        const mermaid = await ensureInitialized('dark');
        const { svg: rendered } = await mermaid.render(diagramId, source);
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- mutated by cleanup
        if (!cancelled) setSvg(rendered);
      } catch (err) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- mutated by cleanup
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, diagramId]);

  if (error) {
    return (
      <div className="my-4 rounded-md border border-destructive/50 bg-destructive/5 p-4">
        <p className="mb-2 text-sm font-medium text-destructive">
          Failed to render diagram: {error}
        </p>
        <pre className="overflow-x-auto text-xs">
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  return (
    <div
      className="my-4 flex justify-center overflow-x-auto"
      // mermaid.render + securityLevel: 'strict' is the trusted SVG source.
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
};

export const MermaidDiagram: React.FC<MermaidDiagramProps> = (props) => {
  if (import.meta.env.SSR) {
    return <MermaidPlaceholder />;
  }
  return <MermaidDiagramClient {...props} />;
};
