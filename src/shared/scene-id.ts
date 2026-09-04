/**
 * Branded `scenes.id` (see the column doc in `db/schema/scenes.ts`). Lives in
 * `src/shared`, not next to the table, because client code mints it too: a
 * Storybook fixture importing the brand from `@/lib/db/schema` once pulled 32
 * Drizzle table modules into the browser graph (#1445).
 */
export type DbSceneId = string & { readonly __brand: 'DbSceneId' };

/**
 * Brand a raw ULID string as a `DbSceneId` (no conversion, just a type cast).
 * The single sanctioned place to mint the brand — mirrors `micros()` in
 * billing/money.ts.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sole brand constructor for DbSceneId
export const dbSceneId = (id: string): DbSceneId => id as DbSceneId;
