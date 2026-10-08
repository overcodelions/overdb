// Interface size: the whole window scaled by Electron's zoom factor.
//
// Not a root font size. Most of the UI is sized in px (`text-[11px]` and
// friends), which a rem change would leave exactly as small as it was —
// and small is the complaint, from Linux desktops especially, where
// Chromium does not follow the system's text scaling.

export const UI_SCALES = [0.85, 1, 1.1, 1.25, 1.5] as const;

/// Anything read from disk, kept within what is usable.
export function clampScale(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  return Math.min(2, Math.max(0.75, n));
}

/// The next size up or down from `current`, for ⌘+ and ⌘−. A value between
/// steps (hand-edited, or from an older list) moves to the nearest step in
/// that direction rather than skipping one.
export function stepScale(current: number, direction: 1 | -1): number {
  if (direction > 0) return UI_SCALES.find((s) => s > current + 1e-6) ?? UI_SCALES[UI_SCALES.length - 1];
  return [...UI_SCALES].reverse().find((s) => s < current - 1e-6) ?? UI_SCALES[0];
}
