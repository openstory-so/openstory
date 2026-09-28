import type { WorkflowStep } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { CloudflareEnv } from '@/platform/server/workflow/types';
import {
  workflowBinding,
  workflowStep,
} from '@/platform/server/workflow/test-doubles';

describe('workflow test doubles', () => {
  it('is a WorkflowStep and a workflow binding', () => {
    const step: WorkflowStep = workflowStep();
    const binding: CloudflareEnv['CHARACTER_SHEET_WORKFLOW'] =
      workflowBinding();
    expect(typeof step.do).toBe('function');
    expect(typeof binding.create).toBe('function');
  });

  it('invokes a step callback once and records its name', async () => {
    const names: string[] = [];
    const step = workflowStep({ names });
    const value = await step.do('persist', async () => 7);
    expect(value).toBe(7);
    expect(names).toEqual(['persist']);
  });

  it('invokes the callback from the config overload', async () => {
    const step = workflowStep();
    const value = await step.do(
      'retry',
      { retries: { limit: 1, delay: '1 second' } },
      async () => 'ok'
    );
    expect(value).toBe('ok');
  });

  it('uses a custom sleep and leaves the default sleep unimplemented', async () => {
    const slept: string[] = [];
    const step = workflowStep({
      sleep: async (name) => {
        slept.push(name);
      },
    });
    await step.sleep('hold', '1 second');
    expect(slept).toEqual(['hold']);
    await expect(workflowStep().sleep('hold', '1 second')).rejects.toThrow(
      /sleep "hold"/
    );
  });
});
