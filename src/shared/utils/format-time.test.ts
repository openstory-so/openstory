import { describe, expect, test } from 'vitest';
import { formatTime } from './format-time';

describe('formatTime', () => {
  test('formats zero seconds', () => {
    expect(formatTime(0)).toBe('00:00');
  });

  test('formats single digit seconds', () => {
    expect(formatTime(5)).toBe('00:05');
  });

  test('formats double digit seconds', () => {
    expect(formatTime(45)).toBe('00:45');
  });

  test('formats minutes and seconds', () => {
    expect(formatTime(125)).toBe('02:05');
  });

  test('formats large durations', () => {
    expect(formatTime(3665)).toBe('61:05');
  });
});
