import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnimaticPlayback } from './animatic-playback';
import {
  animaticLines,
  animaticSceneId,
  orderAnimaticShots,
  type AnimaticShot,
} from './animatic-shots';
import { dbSceneId } from '@/shots/scene-id';

const clip = (id: string) => ({
  id,
  url: `${id}.wav`,
  token: 'DIALOGUE',
  durationSeconds: 1,
});
function shot(id: string, overrides: Partial<AnimaticShot> = {}): AnimaticShot {
  return {
    id,
    sceneId: dbSceneId('scene-a'),
    shotNumber: 0,
    durationMs: 1000,
    previewThumbnailUrl: null,
    image: null,
    dialogue: null,
    audioClips: [],
    ...overrides,
  };
}
class FakeAudio extends EventTarget {
  src = '';
  currentTime = 0;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  load = vi.fn();
  removeAttribute() {
    this.src = '';
  }
  end() {
    this.dispatchEvent(new Event('ended'));
  }
}
const players: AnimaticPlayback[] = [];
function setup(shots: AnimaticShot[]) {
  const audio = new FakeAudio();
  const changed = vi.fn();
  const player = new AnimaticPlayback(shots, audio, changed);
  players.push(player);
  return { audio, changed, player, state: () => changed.mock.lastCall?.[0] };
}
beforeEach(() =>
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
);
afterEach(() => {
  for (const player of players.splice(0)) player.dispose();
  vi.useRealTimers();
});

describe('animatic playback', () => {
  it('holds silent shots for their own duration and resumes the remaining time', () => {
    const { player, state } = setup([
      shot('one'),
      shot('two', { durationMs: 2000 }),
    ]);
    player.play();
    vi.advanceTimersByTime(400);
    player.pause();
    vi.advanceTimersByTime(5000);
    expect(state().shotIndex).toBe(0);
    player.play();
    vi.advanceTimersByTime(599);
    expect(state().shotIndex).toBe(0);
    vi.advanceTimersByTime(1);
    expect(state().shotIndex).toBe(1);
    vi.advanceTimersByTime(1999);
    expect(state().playing).toBe(true);
    vi.advanceTimersByTime(1);
    expect(state()).toMatchObject({ playing: false, finished: true });
    player.play();
    expect(state()).toMatchObject({
      shotIndex: 0,
      playing: true,
      finished: false,
    });
  });
  it('waits for actual dialogue end, plays every selected clip, then advances', () => {
    const { audio, player, state } = setup([
      shot('one', { audioClips: [clip('a'), clip('b')] }),
      shot('two'),
    ]);
    player.play();
    expect(audio.src).toBe('a.wav');
    vi.advanceTimersByTime(10000);
    expect(state().shotIndex).toBe(0);
    audio.end();
    expect(audio.src).toBe('b.wav');
    expect(state()).toMatchObject({ clipIndex: 1, playing: true });
    audio.end();
    expect(state()).toMatchObject({
      shotIndex: 1,
      clipIndex: 0,
      playing: true,
    });
    expect(audio.src).toBe('');
  });
  it('preserves audio position on pause and resets clips when stepping', () => {
    const { audio, player, state } = setup([
      shot('one', { audioClips: [clip('a')] }),
      shot('two'),
    ]);
    player.play();
    audio.currentTime = 0.4;
    player.pause();
    player.play();
    expect(audio.currentTime).toBe(0.4);
    player.step(1);
    expect(state()).toMatchObject({ shotIndex: 1, playing: true });
    player.pause();
    player.step(-1);
    expect(state()).toMatchObject({ shotIndex: 0, playing: false });
    expect(audio.src).toBe('a.wav');
    player.step(-1);
    expect(state().shotIndex).toBe(0);
  });
  it('reports failed media and allows skipping it', () => {
    const { audio, player, state } = setup([
      shot('one', { audioClips: [clip('a')] }),
      shot('two'),
    ]);
    player.play();
    audio.dispatchEvent(new Event('error'));
    expect(state()).toMatchObject({
      playing: false,
      error: expect.stringContaining('could not load'),
    });
    player.step(1);
    expect(state()).toMatchObject({ shotIndex: 1, error: null });
  });
  it('reports rejected play requests without claiming playback is running', async () => {
    const { audio, player, state } = setup([
      shot('one', { audioClips: [clip('a')] }),
    ]);
    audio.play.mockRejectedValueOnce(new Error('Autoplay blocked'));
    player.play();
    await Promise.resolve();
    expect(state()).toMatchObject({
      playing: false,
      error: expect.stringContaining('could not play'),
    });
    player.play();
    expect(state()).toMatchObject({ playing: true, error: null });
  });
  it('ignores obsolete play rejections after stepping to another shot', async () => {
    const { audio, player, state } = setup([
      shot('one', { audioClips: [clip('a')] }),
      shot('two'),
    ]);
    audio.play.mockRejectedValueOnce(new Error('Interrupted'));
    player.play();
    player.step(1);
    await Promise.resolve();
    expect(state()).toMatchObject({ shotIndex: 1, playing: true, error: null });
  });
  it('cancels timers and audio on close and ignores late end events', () => {
    const { audio, player, state } = setup([shot('one'), shot('two')]);
    player.play();
    player.dispose();
    vi.advanceTimersByTime(10000);
    audio.end();
    expect(state()).toMatchObject({ shotIndex: 0, playing: false });
    expect(audio.src).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses a finite default hold when a legacy duration is absent', () => {
    const { player, state } = setup([
      shot('one', { durationMs: null }),
      shot('two'),
    ]);
    player.play();
    vi.advanceTimersByTime(3000);
    expect(state().shotIndex).toBe(1);
  });
});

describe('animatic playlist', () => {
  it('follows scene order then shot order, keeping unassigned shots', () => {
    const shots = [
      shot('a2', { shotNumber: 2 }),
      shot('orphan', { sceneId: null }),
      shot('b1', { sceneId: dbSceneId('scene-b') }),
      shot('a1', { shotNumber: 1 }),
    ];
    expect(
      orderAnimaticShots(shots, ['scene-b', 'scene-a']).map((entry) => entry.id)
    ).toEqual(['b1', 'a1', 'a2', 'orphan']);
    expect(animaticSceneId({ shotId: 'b1', sceneIds: [] }, shots)).toBe(
      'scene-b'
    );
    expect(animaticSceneId({ sceneIds: ['scene-a'] }, shots)).toBe('scene-a');
    expect(animaticSceneId({ sceneIds: [] }, shots)).toBeNull();
  });
  it('shows shortened recorded wording while retaining unchanged lines', () => {
    const entry = shot('one', {
      dialogue: {
        presence: true,
        lines: [
          { character: 'Ana', line: 'A very long greeting', tone: '' },
          { character: 'Bo', line: 'Hello', tone: '' },
        ],
      },
      audioClips: [{ ...clip('a'), spokenLines: [{ index: 0, text: 'Hi' }] }],
    });
    expect(animaticLines(entry, 0)).toEqual([
      { character: 'Ana', text: 'Hi' },
      { character: 'Bo', text: 'Hello' },
    ]);
  });
});
