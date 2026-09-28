import { describe, expect, it } from 'vitest';
import { voicedDialogueLines } from '@/motion/dialogue-tts';
import { bindPendingVoices, pendingVoiceId } from './pending-voices';

const characterVoices = [
  { name: 'Ana', voiceId: pendingVoiceId('c-ana'), voiceOnly: false },
  { name: 'Ben', voiceId: 'el-ben', voiceOnly: false },
];
const dialogue = (character: string) => ({
  presence: true,
  lines: [{ character, line: 'Hello.', tone: '' }],
});
const sceneLine = (shotId: string, character: string) => {
  const [line] = voicedDialogueLines(dialogue(character), characterVoices);
  if (!line) throw new Error(`no voiced line for ${character}`);
  return { ...line, shotId };
};

function planWith() {
  const target = (shotId: string, character: string) => ({
    shotId,
    regenDialogue: true,
    regenVideo: true,
    dialogue: dialogue(character),
    dialogueContext: [sceneLine(shotId, character)],
  });
  return {
    characterVoices,
    dialogueRecording: {
      scenes: [
        {
          voiced: [sceneLine('s1', 'Ana')],
          dialogueVersionIdByShotId: {},
          shotSeconds: {},
          forceAdoptShotIds: [],
        },
        {
          voiced: [sceneLine('s2', 'Ben')],
          dialogueVersionIdByShotId: {},
          shotSeconds: {},
          forceAdoptShotIds: [],
        },
      ],
      maxDurationSeconds: 10,
    },
    targets: [target('s1', 'Ana'), target('s2', 'Ben')],
  };
}

describe('bindPendingVoices', () => {
  it('a voice the wave made replaces its placeholder everywhere', () => {
    const { plan, unvoicedShotIds } = bindPendingVoices(planWith(), {
      'c-ana': 'el-ana',
    });
    expect(unvoicedShotIds.size).toBe(0);
    expect(plan.characterVoices.map((c) => c.voiceId)).toEqual([
      'el-ana',
      'el-ben',
    ]);
    expect(plan.dialogueRecording.scenes[0]?.voiced[0]?.voiceId).toBe('el-ana');
    expect(plan.targets[0]?.dialogueContext[0]?.voiceId).toBe('el-ana');
  });

  it('a voice that did not land holds its shots and drops their scene', () => {
    const { plan, unvoicedShotIds } = bindPendingVoices(planWith(), {});
    expect([...unvoicedShotIds]).toEqual(['s1']);
    expect(plan.characterVoices.map((c) => c.name)).toEqual(['Ben']);
    expect(plan.dialogueRecording.scenes).toHaveLength(1);
    expect(plan.dialogueRecording.scenes[0]?.voiced[0]?.shotId).toBe('s2');
  });
});
