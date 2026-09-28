import { globSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/** Pin the construction boundary, including local aliases and contextual object types. */
function violationsIn(text: string): string[] {
  const source = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*/gm, '');
  const names = new Set(['MotionWorkflowInput']);
  for (const match of source.matchAll(/\bMotionWorkflowInput\s+as\s+(\w+)/g))
    if (match[1]) names.add(match[1]);
  // Resolve a chain of local aliases before looking for constructions.
  for (let changed = true; changed;) {
    changed = false;
    for (const match of source.matchAll(/\btype\s+(\w+)\s*=\s*(\w+)\s*[;&]/g)) {
      if (match[1] && match[2] && names.has(match[2]) && !names.has(match[1])) {
        names.add(match[1]);
        changed = true;
      }
    }
  }
  const input = `(?:${[...names].join('|')})`;
  const violations: string[] = [];
  const rules: Array<[string, RegExp]> = [
    ['assembly import', /import\s*\{[^}]*\bassemble(?:Packed)?MotionPrompt\b/],
    [
      'namespace assembly import',
      /import\s+\*\s+as\s+\w+\s+from\s+['"][^'"]*assemble-motion-prompt['"]/,
    ],
    ['assembly call', /\bassemble(?:Packed)?MotionPrompt\s*\(/],
    ['typed construction', new RegExp(`:\\s*${input}\\s*(?:&[^=]+)?=\\s*\\{`)],
    [
      'asserted construction',
      new RegExp(`\\}\\s*(?:as|satisfies)\\s+${input}\\b`),
    ],
    [
      'typed return',
      new RegExp(
        `\\)\\s*:\\s*(?:Promise<)?${input}>?\\s*\\{[^]*?\\breturn\\s*\\{`
      ),
    ],
    [
      'implicit return',
      new RegExp(`\\)\\s*:\\s*${input}\\s*=>\\s*\\(?\\s*\\{`),
    ],
    ['inline trigger', /\btriggerWorkflow\s*\(\s*['"]\/motion['"]\s*,\s*\{/],
    [
      'inline child',
      new RegExp(
        `spawnAndAwaitChild\\s*<\\s*${input}(?:(?!childPayload)[^])*childPayload\\s*:\\s*\\{`
      ),
    ],
  ];
  for (const [reason, rule] of rules)
    if (rule.test(source)) violations.push(reason);
  return violations;
}

it('only the builder assembles prompts and constructs motion workflow inputs', () => {
  const violations = globSync('src/**/*.ts')
    .filter(
      (path) =>
        !path.endsWith('.test.ts') &&
        path !== 'src/motion/server/build-motion-render.ts' &&
        path !== 'src/motion/server/assemble-motion-prompt.ts'
    )
    .flatMap((path) =>
      violationsIn(readFileSync(path, 'utf8')).map(
        (reason) => `${path}: ${reason}`
      )
    );
  expect(violations).toEqual([]);
});

it.each([
  `import { assembleMotionPrompt as assemble } from './assemble-motion-prompt'; assemble({});`,
  `import * as assembly from './assemble-motion-prompt'; assembly.assemblePackedMotionPrompt({});`,
  `import type { MotionWorkflowInput as Input } from './types'; const input: Input = {};`,
  `function render(): MotionWorkflowInput { return {}; }`,
  `const render = (): MotionWorkflowInput => ({});`,
  `const input = {} as MotionWorkflowInput;`,
  `triggerWorkflow('/motion', {});`,
  `spawnAndAwaitChild<MotionWorkflowInput, Result>(step, { childPayload: {} });`,
])('rejects an alternative constructor spelling: %s', (source) => {
  expect(violationsIn(source).length).toBeGreaterThan(0);
});
