import { describe, expect, it } from 'vitest';
import {
  bibleLikeness,
  likenessFromTalentCast,
  registersWithArk,
} from './likeness';

describe('registersWithArk', () => {
  it('registers real and fictional faces, and a missing value on in-flight payloads', () => {
    expect(registersWithArk('real')).toBe(true);
    expect(registersWithArk('fictional')).toBe(true);
    expect(registersWithArk(undefined)).toBe(true);
    expect(registersWithArk(null)).toBe(true);
  });

  it('does not register a non-person sheet', () => {
    expect(registersWithArk('none')).toBe(false);
  });
});

describe('likenessFromTalentCast', () => {
  it('stamps real when the talent has a signed release', () => {
    expect(likenessFromTalentCast('fictional', true)).toBe('real');
    expect(likenessFromTalentCast('none', true)).toBe('real');
  });

  it('keeps the bible value when the talent is unsigned', () => {
    expect(likenessFromTalentCast('fictional', false)).toBe('fictional');
    expect(likenessFromTalentCast('none', false)).toBe('none');
    expect(likenessFromTalentCast('fictional', undefined)).toBe('fictional');
  });

  it('does not keep real after recasting off a signed talent', () => {
    expect(likenessFromTalentCast('real', false)).toBe('fictional');
  });
});

describe('bibleLikeness', () => {
  it('collapses real to fictional and keeps none', () => {
    expect(bibleLikeness('real')).toBe('fictional');
    expect(bibleLikeness('fictional')).toBe('fictional');
    expect(bibleLikeness('none')).toBe('none');
  });
});
