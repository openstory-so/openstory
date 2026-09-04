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

describe('script/enhance — Fountain, not clip labels', () => {
  const enhance = WORKFLOW_TEXT_PROMPTS['script/enhance'] ?? '';

  it('asks for a Fountain screenplay, not Scene/Shot duration headings', () => {
    expect(enhance).toContain('Fountain');
    expect(enhance).toContain('INT. LOCATION - DAY');
    expect(enhance).toContain('CUT TO:');
    expect(enhance).not.toContain('Scene 2 — 12s');
    expect(enhance).not.toContain('Shot 1 — 6s');
    expect(enhance).not.toContain('TOTAL:');
  });

  it('asks for a film title as the first line', () => {
    expect(enhance).toContain("First line: the film's title");
    expect(enhance).toContain('no "Title:" prefix');
  });

  it('keeps internal cuts under the current slugline', () => {
    expect(enhance).toContain('write CUT TO:');
    expect(enhance).toContain('do not start a new INT');
  });
});
