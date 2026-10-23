/**
 * The chat tool set is the MCP tool set (#2155): same names, same count,
 * and a delete waits for the user while a spend does not: the user is in
 * the app and sees the generation start.
 */
import { describe, expect, it } from 'vitest';
import { MCP_TOOLS } from '@/platform/server/mcp/server';
import {
  assistantTools,
  chatToolName,
  needsApproval,
  takesUrl,
  unwrapMcpResult,
} from './assistant-tools';

describe('assistantTools', () => {
  it('serves every MCP tool under its MCP name', () => {
    const chatNames = assistantTools().map((tool) => tool.name);
    expect(chatNames).toEqual(MCP_TOOLS.map((tool) => chatToolName(tool.name)));
    // OpenAI rejects a dot in a tool name.
    for (const name of chatNames) expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('asks before a delete, never before a spend or a read', () => {
    const tool = (name: string) => {
      const found = MCP_TOOLS.find((t) => t.name === name);
      if (!found) throw new Error(`no tool ${name}`);
      return found;
    };
    expect(needsApproval(tool('openstory.get_shot'))).toBe(false);
    expect(needsApproval(tool('openstory.update_shot_prompt'))).toBe(false);
    expect(needsApproval(tool('openstory.delete_shot'))).toBe(true);
    // Spending does not ask: the page shows the generation as it starts.
    expect(needsApproval(tool('openstory.execute_generation'))).toBe(false);
    expect(needsApproval(tool('openstory.create_studio_assets'))).toBe(false);
    expect(needsApproval(tool('openstory.delete_character'))).toBe(true);
    // A model-chosen URL is shown before it goes out; a search query is not.
    expect(needsApproval(tool('openstory.fetch_url'))).toBe(true);
    expect(needsApproval(tool('openstory.web_search'))).toBe(false);
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

describe('model-written URLs', () => {
  it('asks before every tool whose input holds a URL the model writes', () => {
    // A page the model read could tell it to send the user's work to a URL
    // of its choosing. The set is read off the schemas; this pins it so a
    // new URL-taking tool is a deliberate addition here, and asks.
    const urlTools = MCP_TOOLS.filter(takesUrl).map((tool) => tool.name);
    expect(urlTools.sort()).toEqual([
      'openstory.apply_sequence_edits',
      'openstory.create_sequence',
      'openstory.create_stitch',
      'openstory.fetch_url',
      'openstory.upload_media',
    ]);
    for (const name of urlTools) {
      const tool = MCP_TOOLS.find((t) => t.name === name);
      expect(tool && needsApproval(tool), name).toBe(true);
    }
    expect(MCP_TOOLS.filter(takesUrl).map((t) => t.name)).not.toContain(
      'openstory.web_search'
    );
  });
});
