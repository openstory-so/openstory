/**
 * The chat tool set is the MCP tool set (#2155): same names, same count,
 * and every spend or delete waits for the user. `SPEND_TOOLS` is pinned
 * against the catalog so a new generation tool is named here on purpose.
 */
import { describe, expect, it } from 'vitest';
import { MCP_TOOLS } from '@/platform/server/mcp/server';
import {
  assistantTools,
  chatToolName,
  needsApproval,
  SPEND_TOOLS,
  unwrapMcpResult,
} from './assistant-tools';

// A cancel or a plan costs nothing; everything else named like work does.
const SPEND_WORDS =
  /^openstory\.(?!cancel_|plan_).*(generate|render|execute|export|draft|rewrite|recast|replace_element|create_studio|edit_studio)/;

describe('assistantTools', () => {
  it('serves every MCP tool under its MCP name', () => {
    const chatNames = assistantTools().map((tool) => tool.name);
    expect(chatNames).toEqual(MCP_TOOLS.map((tool) => chatToolName(tool.name)));
    // OpenAI rejects a dot in a tool name.
    for (const name of chatNames) expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('names every spending tool in SPEND_TOOLS', () => {
    const spendLike = MCP_TOOLS.filter((tool) => {
      const annotations: unknown = tool.metadata?.annotations;
      const readOnly =
        typeof annotations === 'object' &&
        annotations !== null &&
        'readOnlyHint' in annotations &&
        annotations.readOnlyHint === true;
      return !readOnly && SPEND_WORDS.test(tool.name);
    }).map((tool) => tool.name);
    const unlisted = spendLike.filter((name) => !SPEND_TOOLS.has(name));
    expect(unlisted).toEqual([]);
    const unknown = [...SPEND_TOOLS].filter(
      (name) => !MCP_TOOLS.some((tool) => tool.name === name)
    );
    expect(unknown).toEqual([]);
  });

  it('asks before a spend or a delete, never before a read', () => {
    const tool = (name: string) => {
      const found = MCP_TOOLS.find((t) => t.name === name);
      if (!found) throw new Error(`no tool ${name}`);
      return found;
    };
    expect(needsApproval(tool('openstory.get_shot'))).toBe(false);
    expect(needsApproval(tool('openstory.update_shot_prompt'))).toBe(false);
    expect(needsApproval(tool('openstory.delete_shot'))).toBe(true);
    expect(needsApproval(tool('openstory.execute_generation'))).toBe(true);
    // Spenders the name regex cannot see.
    expect(needsApproval(tool('openstory.create_sequence'))).toBe(true);
    expect(needsApproval(tool('openstory.rebuild_shot_prompts'))).toBe(true);
    expect(needsApproval(tool('openstory.add_model_to_sequence'))).toBe(true);
  });

  it('gates every write the catalog marks as paid', () => {
    const paidUngated = MCP_TOOLS.filter((tool) => {
      const annotations: unknown = tool.metadata?.annotations;
      if (typeof annotations !== 'object' || annotations === null) return false;
      const readOnly =
        'readOnlyHint' in annotations && annotations.readOnlyHint === true;
      const paid =
        'openWorldHint' in annotations && annotations.openWorldHint === true;
      return !readOnly && paid && !needsApproval(tool);
    }).map((tool) => tool.name);
    expect(paidUngated).toEqual([]);
  });

  it('keeps the first-turn tools eager and the rest lazy', () => {
    const tools = assistantTools();
    const eager = tools.filter((tool) => !tool.lazy).map((tool) => tool.name);
    expect(eager).toContain('openstory_get_shot');
    expect(eager).toContain('openstory_plan_generation');
    expect(tools.find((t) => t.name === 'openstory_delete_shot')?.lazy).toBe(
      true
    );
    expect(eager.length).toBeLessThan(30);
  });
});

describe('unwrapMcpResult', () => {
  it('returns the structured data of a success envelope', () => {
    expect(
      unwrapMcpResult({
        content: [{ type: 'text', text: 'Did it.' }],
        structuredContent: { id: 'x' },
      })
    ).toEqual({ id: 'x' });
  });

  it('throws the text of an error envelope', () => {
    expect(() =>
      unwrapMcpResult({
        isError: true,
        content: [{ type: 'text', text: 'shot not found' }],
      })
    ).toThrow('shot not found');
  });

  it('passes a plain result through', () => {
    expect(unwrapMcpResult({ user: { id: 'u' } })).toEqual({
      user: { id: 'u' },
    });
  });
});
