import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_CHAT_PROMPTS,
  WORKFLOW_TEXT_PROMPTS,
} from './workflow-prompts';

describe('scene-splitting-boundaries-chat — shots vs scenes (#1486)', () => {
  const system =
    WORKFLOW_CHAT_PROMPTS['phase/scene-splitting-boundaries-chat']?.[0]
      ?.content ?? '';

  it('does not tell the model a scene is one shot', () => {
    expect(system).not.toContain('ONE SHOT RULE');
    expect(system).not.toMatch(/SCENE = .+ ONE SHOT/);
    expect(system).toContain('1..N shots');
    expect(system).toContain(
      'Do NOT split on camera cuts or framing changes alone'
    );
  });

  it('keeps an internal cut in the same scene', () => {
    expect(system).toContain('Cut to...');
    expect(system).toMatch(/same scene/i);
  });
});

describe('scene-shot-list-chat', () => {
  it('is registered and covers scenes as a director, not a script splitter', () => {
    const prompt = WORKFLOW_CHAT_PROMPTS['phase/scene-shot-list-chat'];
    expect(prompt).toBeDefined();
    const system = prompt?.[0]?.content ?? '';
    expect(system).toContain('1..N shots');
    expect(system).toContain('HOW TO SHOOT');
    expect(system).toContain('Style is the director');
    expect(system).toContain('You NEVER create, merge, or rewrite scenes');
    expect(system).toContain('The system assigns the real clip lengths');
    expect(system).not.toContain('A scene with no internal cut is ONE shot');
    expect(prompt?.[1]?.content).toContain('{{scenes}}');
    expect(prompt?.[1]?.content).toContain('{{style}}');
    expect(prompt?.[1]?.content).toContain('DIRECTOR_STYLE');
  });
});

describe('script/enhance — two levels (#1486)', () => {
  const enhance = WORKFLOW_TEXT_PROMPTS['script/enhance'] ?? '';

  it('no longer defines a scene as one clip', () => {
    expect(enhance).not.toContain(
      'each scene becomes one still image that is then animated into a ~5-second clip'
    );
    expect(enhance).toContain('may hold several SHOTS');
    expect(enhance).toContain('Cut to: the hallway beyond');
  });

  it('labels scene totals and per-shot clip durations', () => {
    expect(enhance).toContain('Shot 1 — 6s');
    expect(enhance).toContain('one-shot scene needs only the scene label');
    expect(enhance).toContain('TOTAL: <sum>s');
  });

  it('treats each shot as one video clip, not a packed multi-shot render', () => {
    expect(enhance).toContain(
      'Each shot becomes one still image that is then animated into a short clip'
    );
  });
});
