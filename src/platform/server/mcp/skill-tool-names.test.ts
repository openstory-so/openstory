/**
 * The agent skills name MCP tools as clients see them (#2357): renaming a
 * tool without updating the skills fails here. Clients list `openstory.x`
 * as `openstory_x`, the same name the in-app chat uses.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chatToolName } from '@/assistant/server/assistant-tools';
import { MCP_TOOLS } from './server';

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const SKILL_DIRS = ['skills', 'packages/stitch/skills'];

const skills = SKILL_DIRS.flatMap((dir) =>
  readdirSync(join(ROOT, dir)).map((name) => {
    const path = join(dir, name, 'SKILL.md');
    return { path, text: readFileSync(join(ROOT, path), 'utf8') };
  })
);
const toolNames = new Set(MCP_TOOLS.map((tool) => chatToolName(tool.name)));

describe('agent skills', () => {
  it('name only MCP tools that exist, with the openstory_ prefix', () => {
    const bad: string[] = [];
    for (const { path, text } of skills) {
      for (const [, token = ''] of text.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
        const isTool = token === 'whoami' || token.startsWith('openstory_');
        if (isTool && !toolNames.has(token)) bad.push(`${path}: ${token}`);
        if (toolNames.has(`openstory_${token}`))
          bad.push(`${path}: ${token} (write openstory_${token})`);
      }
    }
    expect(bad).toEqual([]);
  });
});
