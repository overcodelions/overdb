import { describe, expect, it } from 'vitest';
import { clampScale, stepScale } from './uiScale';

describe('stepScale', () => {
  it('walks the steps and stops at either end', () => {
    expect(stepScale(1, 1)).toBe(1.1);
    expect(stepScale(1.1, -1)).toBe(1);
    expect(stepScale(1.5, 1)).toBe(1.5);
    expect(stepScale(0.85, -1)).toBe(0.85);
  });

  it('moves an off-step value to the nearest step in that direction', () => {
    expect(stepScale(1.2, 1)).toBe(1.25);
    expect(stepScale(1.2, -1)).toBe(1.1);
  });
});

describe('clampScale', () => {
  it('falls back to 100% for anything that is not a number, and bounds the rest', () => {
    expect(clampScale(undefined)).toBe(1);
    expect(clampScale('big')).toBe(1);
    expect(clampScale(9)).toBe(2);
    expect(clampScale(0.1)).toBe(0.75);
    expect(clampScale(1.25)).toBe(1.25);
  });
});
