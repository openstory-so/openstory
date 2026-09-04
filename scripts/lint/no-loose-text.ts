/**
 * oxlint rule `openstory/no-loose-text` (#1283).
 *
 * Chrome auto-translate replaces every DOM text node with `<font>` wrappers.
 * React still holds the old text nodes, so the next `removeChild(textNode)`
 * or `insertBefore(x, textNode)` throws and the nearest boundary shows
 * "Something went wrong". Elements survive translation; only text nodes are
 * swapped. So JSX must never (A) render text conditionally — React would
 * delete the text fiber — and (B) put text after a sibling that can mount
 * later — React would use the text node as the insertion anchor.
 *
 *   ✗ Image Model{!single && 's'}        → {single ? 'Image Model' : 'Image Models'}
 *   ✗ {busy ? 'Saving…' : <Icon />}      → {busy ? <span>Saving…</span> : <Icon />}
 *   ✗ {c && <Icon />} Save               → {c && <Icon />}<span>Save</span>, or Save {c && <Icon />}
 *   ✓ {busy ? 'Saving…' : 'Save'}        (same text fiber, React updates nodeValue)
 *
 * Not caught (needs types): `<span>{label}</span>` with `label: string | null`.
 * `onCaughtError` in src/client.tsx reports those with a component stack.
 *
 * oxlint's JS-plugin API is alpha and ships no plugin/AST types, so the
 * ESTree+JSX shapes this rule touches are declared structurally below.
 */

type Position = { line: number; column: number };
type SourceLocation = { start: Position; end: Position };

type Kind = 'text' | 'empty' | 'element' | 'unknown';

type BaseNode = { type: string; loc?: SourceLocation | null };
type Literal = BaseNode & { type: 'Literal'; value: unknown };
type Identifier = BaseNode & { type: 'Identifier'; name: string };
type Conditional = BaseNode & {
  type: 'ConditionalExpression';
  consequent: BaseNode;
  alternate: BaseNode;
};
type Logical = BaseNode & {
  type: 'LogicalExpression';
  operator: '&&' | '||' | '??';
  left: BaseNode;
  right: BaseNode;
};
type Parenthesized = BaseNode & {
  type: 'ParenthesizedExpression';
  expression: BaseNode;
};
type Call = BaseNode & { type: 'CallExpression'; callee: BaseNode };
type Member = BaseNode & { type: 'MemberExpression'; property: BaseNode };
type JsxText = BaseNode & { type: 'JSXText'; value: string };
type JsxContainer = BaseNode & {
  type: 'JSXExpressionContainer';
  expression: BaseNode;
};
type JsxParent = BaseNode & {
  type: 'JSXElement' | 'JSXFragment';
  children: BaseNode[];
};

type Context = {
  report(diagnostic: { loc: SourceLocation; message: string }): void;
};

const is =
  <T extends BaseNode>(...types: T['type'][]) =>
  (node: BaseNode): node is T =>
    types.includes(node.type);

const isLiteral = is<Literal>('Literal');
const isIdentifier = is<Identifier>('Identifier');
const isConditional = is<Conditional>('ConditionalExpression');
const isLogical = is<Logical>('LogicalExpression');
const isParenthesized = is<Parenthesized>('ParenthesizedExpression');
const isCall = is<Call>('CallExpression');
const isMember = is<Member>('MemberExpression');
const isJsxText = is<JsxText>('JSXText');
const isJsxContainer = is<JsxContainer>('JSXExpressionContainer');
const isJsxParent = is<JsxParent>('JSXElement', 'JSXFragment');

function unwrap(node: BaseNode): BaseNode {
  return isParenthesized(node) ? unwrap(node.expression) : node;
}

function branchKinds(raw: BaseNode, out = new Set<Kind>()): Set<Kind> {
  const expr = unwrap(raw);
  if (isLiteral(expr)) {
    const v = expr.value;
    // React renders no text node for '' — flipping to it deletes the fiber.
    out.add(
      v === '' || v === null || typeof v === 'boolean'
        ? 'empty'
        : typeof v === 'string' || typeof v === 'number'
          ? 'text'
          : 'unknown'
    );
  } else if (expr.type === 'TemplateLiteral') {
    out.add('text');
  } else if (isIdentifier(expr)) {
    out.add(expr.name === 'undefined' ? 'empty' : 'unknown');
  } else if (isJsxParent(expr)) {
    out.add('element');
  } else if (isConditional(expr)) {
    branchKinds(expr.consequent, out);
    branchKinds(expr.alternate, out);
  } else if (isLogical(expr)) {
    if (expr.operator === '&&') out.add('empty');
    else branchKinds(expr.left, out);
    branchKinds(expr.right, out);
  } else {
    out.add('unknown');
  }
  return out;
}

const isBranching = (node: BaseNode): boolean =>
  isConditional(node) || isLogical(node);

/** Text React renders as a bare DOM text node. */
function isText(child: BaseNode): boolean {
  if (isJsxText(child)) return child.value.trim() !== '';
  if (!isJsxContainer(child)) return false;
  const kinds = branchKinds(child.expression);
  return kinds.size === 1 && kinds.has('text');
}

/**
 * A sibling React may mount (or swap) after first render: a conditional that
 * can be absent or an element, or a `.map()` list. Text-only ternaries keep
 * one fiber (nodeValue update), and plain calls are opaque — neither counts.
 */
function isDynamic(child: BaseNode): boolean {
  if (!isJsxContainer(child)) return false;
  const e = unwrap(child.expression);
  if (isBranching(e)) {
    const kinds = branchKinds(e);
    return kinds.has('empty') || kinds.has('element');
  }
  return (
    isCall(e) &&
    isMember(e.callee) &&
    isIdentifier(e.callee.property) &&
    e.callee.property.name === 'map'
  );
}

const CONDITIONAL_TEXT =
  'Conditionally rendered text: React deletes the text node when the condition flips, which throws once Chrome translate has replaced it. Make both branches text, or render a <span> (#1283).';
const TEXT_AFTER_DYNAMIC =
  'Text after a conditional sibling: React inserts the sibling before this text node, which throws once Chrome translate has replaced it. Wrap the text in a <span> or move the conditional after it (#1283).';

function checkParent(context: Context, node: BaseNode): void {
  if (!isJsxParent(node)) return;
  let sawDynamic = false;
  for (const child of node.children) {
    if (isJsxText(child) && child.value.trim() === '') continue;
    const report = (message: string) => {
      if (child.loc) context.report({ loc: child.loc, message });
    };
    const expr = isJsxContainer(child) ? unwrap(child.expression) : null;
    if (expr && isBranching(expr)) {
      const kinds = branchKinds(expr);
      if (kinds.has('text') && (kinds.has('empty') || kinds.has('element'))) {
        report(CONDITIONAL_TEXT);
      }
    } else if (sawDynamic && isText(child)) {
      report(TEXT_AFTER_DYNAMIC);
    }
    if (isDynamic(child)) sawDynamic = true;
  }
}

export default {
  meta: { name: 'openstory' },
  rules: {
    'no-loose-text': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Text nodes React may delete or insert before break once Chrome translate has replaced them',
        },
      },
      create: (context: Context) => ({
        JSXElement: (node: BaseNode) => checkParent(context, node),
        JSXFragment: (node: BaseNode) => checkParent(context, node),
      }),
    },
  },
};
