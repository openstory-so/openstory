# Public API OpenAPI document

`GET /api/v1/openapi.json` is built by `src/platform/server/api-v1/openapi.ts`, and **every
schema in it is generated** — nothing is hand-authored. Request bodies come
from the validators the routes parse with; response documents come from the
Zod schemas their TypeScript types are `z.infer`'d from (`state.ts`,
`create.ts`, `list.ts`, `styles.ts`, `hal.ts`). So a response shape cannot
drift from its published contract: change the schema and both move together.

- A component is named by `.meta({ id })`; `componentDefs()` hoists the `$defs`
  Zod emits into `components.schemas` and repoints the refs.
- **`.extend()` mints a new schema and drops the `.meta({ id })`.** Tag the
  shape you actually return — the `_links`-bearing _resource_
  (`sequenceStateResourceSchema`, `styleResourceSchema`), not the bare body —
  or the component is published but never referenced.
- `openapi.test.ts` fails on any dangling `$ref`, which is what caught that.
- Use `z.string().meta({ format: 'date-time' })`, not `z.iso.datetime()`: the
  latter also publishes a multi-hundred-character regex.
