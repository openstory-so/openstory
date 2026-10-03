/** Parent-first D1 data import; exports are alphabetical, while D1 chunks imports. */
export function foreignKeysFromSchema(
  schema: string
): Array<{ child: string; parent: string }> {
  const edges: Array<{ child: string; parent: string }> = [];
  const tables =
    /CREATE TABLE(?: IF NOT EXISTS)? ["`]?([\w]+)["`]?\s*\(([\s\S]*?)\);/g;
  for (const match of schema.matchAll(tables)) {
    const child = match[1];
    if (!child) continue;
    for (const reference of match[2]?.matchAll(
      /REFERENCES ["`]?([\w]+)["`]?/gi
    ) ?? []) {
      const parent = reference[1];
      if (parent) edges.push({ child, parent });
    }
  }
  return edges;
}

export function reorderPreviewDump(
  dump: string,
  edges: Array<{ child: string; parent: string }>
): string {
  const header: string[] = [];
  const buckets = new Map<string, string[]>();
  let current = header;
  for (const line of dump.replace(/\n$/, '').split('\n')) {
    const table = /^INSERT INTO "(\w+)"/.exec(line)?.[1];
    if (table) {
      current = buckets.get(table) ?? [];
      buckets.set(table, current);
    }
    current.push(line);
  }
  const ordered: string[] = [];
  const remaining = new Set(buckets.keys());
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((table) =>
        edges.every(
          (edge) =>
            edge.child !== table ||
            !remaining.has(edge.parent) ||
            edge.parent === table
        )
      )
      .sort();
    if (!ready.length)
      throw new Error(`Cyclic D1 foreign keys: ${[...remaining].join(', ')}`);
    for (const table of ready) {
      ordered.push(table);
      remaining.delete(table);
    }
  }
  return (
    [...header, ...ordered.flatMap((table) => buckets.get(table) ?? [])].join(
      '\n'
    ) + '\n'
  );
}
