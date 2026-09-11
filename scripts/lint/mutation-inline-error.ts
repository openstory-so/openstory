/**
 * oxlint rule `mutations/declare-inline-error` (#1571).
 *
 * `src/ui/query-client.ts` toasts `error.message` for every failed mutation
 * unless the mutation sets `meta.inlineError`. Most call sites also surface
 * the failure themselves — a titled toast, an inline error state, a
 * try/catch — so an untagged mutation reports twice. Whether a call site
 * handles the error is not knowable from the cache (`mutate(vars, { onError })`
 * lives on the observer), so the choice is made explicitly, on the hook:
 *
 *   meta: { inlineError: true }   the hook or its callers own the error UI
 *   meta: { inlineError: false }  nobody does — the global toast is the UI
 *
 * oxlint's JS-plugin API is alpha and ships no plugin/AST types, so the
 * ESTree shapes this rule touches are declared structurally below.
 */

type Position = { line: number; column: number };
type SourceLocation = { start: Position; end: Position };
type BaseNode = { type: string; loc?: SourceLocation | null };
type Identifier = BaseNode & { type: 'Identifier'; name: string };
type Property = BaseNode & { type: 'Property'; key: BaseNode; value: BaseNode };
type ObjectExpression = BaseNode & {
  type: 'ObjectExpression';
  properties: BaseNode[];
};
type Call = BaseNode & {
  type: 'CallExpression';
  callee: BaseNode;
  arguments: BaseNode[];
};
type Context = {
  report(diagnostic: { loc: SourceLocation; message: string }): void;
};

const MESSAGE =
  'Every useMutation declares meta.inlineError: true when the hook or its callers surface the failure themselves (toast, inline state, try/catch), false to rely on the global error toast in src/ui/query-client.ts (#1571).';

const is =
  <T extends BaseNode>(type: T['type']) =>
  (node: BaseNode): node is T =>
    node.type === type;

const isIdentifier = is<Identifier>('Identifier');
const isProperty = is<Property>('Property');
const isObject = is<ObjectExpression>('ObjectExpression');
const isCall = is<Call>('CallExpression');

function property(obj: ObjectExpression, name: string): Property | undefined {
  return obj.properties.find(
    (p): p is Property =>
      isProperty(p) && isIdentifier(p.key) && p.key.name === name
  );
}

function check(context: Context, node: BaseNode): void {
  if (!isCall(node)) return;
  const { callee } = node;
  if (!isIdentifier(callee) || callee.name !== 'useMutation' || !callee.loc) {
    return;
  }
  const [options] = node.arguments;
  if (options && isObject(options)) {
    const meta = property(options, 'meta');
    if (meta && isObject(meta.value) && property(meta.value, 'inlineError')) {
      return;
    }
  }
  context.report({ loc: callee.loc, message: MESSAGE });
}

export default {
  meta: { name: 'mutations' },
  rules: {
    'declare-inline-error': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'useMutation must say whether its errors are surfaced locally or by the global toast',
        },
      },
      create: (context: Context) => ({
        CallExpression: (node: BaseNode) => check(context, node),
      }),
    },
  },
};
