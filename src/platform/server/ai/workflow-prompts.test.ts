import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_CHAT_PROMPTS,
  WORKFLOW_TEXT_PROMPTS,
} from './workflow-prompts';

describe('remote participant location extraction', () => {
  it.each(['phase/scene-bibles-chat', 'phase/location-extraction-chat'])(
    '%s distinguishes physical rooms from the call interface',
    (name) => {
      const system = WORKFLOW_CHAT_PROMPTS[name]?.[0]?.content ?? '';
      expect(system).toContain('A video call is a connection between places');
      expect(system).toContain('create a separate location bible entry');
      expect(system).toContain('including participants who join later');
      expect(system).toContain(
        'Name an inferred location after its participant'
      );
      expect(system).toContain('Reuse that entry on every return');
      expect(system).toContain(
        'two people using the same camera in the same room share one location'
      );
      expect(system).toContain('firstMention still quotes real script text');
      expect(system).toContain('audio-only participant');
    }
  );
});

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
    // Length is per scene (#1593): the budget line, not a film target.
    // Enhance no longer labels shots itself (#1621), so the budget is always
    // grid-derived, never "as labelled in the script".
    expect(system).toContain('shots:');
    expect(system).not.toContain('as labelled in the script');
    expect(system).toContain(
      'the system divides it across the scene\x27s shots'
    );
    expect(system).not.toContain('hits the target running time');
    expect(system).not.toContain('A scene with no internal cut is ONE shot');
    expect(prompt?.[1]?.content).toContain('{{scenes}}');
    expect(prompt?.[1]?.content).toContain('{{style}}');
    expect(prompt?.[1]?.content).toContain('DIRECTOR_STYLE');
  });

  it('extracts dialogue per shot from the bible cast (#1585)', () => {
    const prompt = WORKFLOW_CHAT_PROMPTS['phase/scene-shot-list-chat'];
    expect(prompt?.[0]?.content).toContain('## Dialogue');
    expect(prompt?.[0]?.content).toContain('copied verbatim');
    expect(prompt?.[0]?.content).toContain('(voice only)');
    expect(prompt?.[1]?.content).toContain('{{characters}}');
    expect(prompt?.[1]?.content).toContain('<CHARACTERS>');
    // aimock routes recordings by this prefix (e2e/mocks/aimock-server.ts).
    expect(String(prompt?.[1]?.content)).toMatch(/^Cover each scene\./);
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

  it('labels only scene totals, never shots or clip lengths (#1621)', () => {
    expect(enhance).toContain('Scene 2 — 12s');
    expect(enhance).toContain("scene's playing time, not a clip length");
    expect(enhance).toContain('TOTAL: <sum>s');
    expect(enhance).not.toMatch(/Shot \d+ — \d+s/);
    expect(enhance).toContain('Do not label shots or clip lengths');
  });

  it('treats each shot as one video clip, not a packed multi-shot render', () => {
    expect(enhance).toContain(
      'Each shot becomes one still image that is then animated into a short clip'
    );
  });
});
