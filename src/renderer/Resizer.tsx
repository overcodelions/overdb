import { useEffect, useRef, useState } from 'react';

/// A drag handle you can find without hunting for it.
///
/// The previous split was a 1px border: it read as a hairline rule, gave no
/// hint that it moved, and presented a one-pixel target to hit. This is 5px
/// of hit area with a visible grip at rest, the accent under the cursor, and
/// a double-click back to the default — the same treatment on both axes so
/// one look teaches both.
/// The handle's thickness, for layouts that have to reproduce the column
/// structure a resizer creates — the bottom rail draws its own copy of the
/// sidebar/main split and has to land on the same edges. Keep it in step
/// with the `w-[5px]` / `h-[5px]` classes below; Tailwind needs those spelled
/// out literally, so the number genuinely lives in two places.
export const RESIZER_PX = 5;

export function Resizer({
  axis,
  value,
  min,
  max,
  fallback,
  onChange,
  label,
}: {
  axis: 'x' | 'y';
  value: number;
  min: number;
  max: number | (() => number);
  /// Where a double-click puts it back to.
  fallback: number;
  onChange(next: number): void;
  label: string;
}): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Read inside the move handler without re-subscribing on every pixel.
  const latest = useRef({ value, min, max, onChange });
  latest.current = { value, min, max, onChange };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const { min: lo, max: hi, onChange: emit } = latest.current;
      const ceiling = typeof hi === 'function' ? hi() : hi;
      const box = ref.current?.parentElement?.getBoundingClientRect();
      const raw = axis === 'x' ? e.clientX : e.clientY - (box?.top ?? 0);
      const next = Math.round(Math.min(ceiling, Math.max(lo, raw)));
      if (next !== latest.current.value) emit(next);
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // Without this the pointer flickers between the resize cursor and the
    // text I-beam every time it crosses the editor underneath.
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, axis]);

  const nudge = (delta: number) => {
    const ceiling = typeof max === 'function' ? max() : max;
    onChange(Math.round(Math.min(ceiling, Math.max(min, value + delta))));
  };

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={value}
      tabIndex={0}
      onMouseDown={() => setDragging(true)}
      onDoubleClick={() => onChange(fallback)}
      onKeyDown={(e) => {
        // Arrow keys move it too, because a drag handle that only responds
        // to a mouse is not a control everyone can reach.
        const step = e.shiftKey ? 40 : 8;
        if (axis === 'x' && e.key === 'ArrowLeft') nudge(-step);
        else if (axis === 'x' && e.key === 'ArrowRight') nudge(step);
        else if (axis === 'y' && e.key === 'ArrowUp') nudge(-step);
        else if (axis === 'y' && e.key === 'ArrowDown') nudge(step);
        else return;
        e.preventDefault();
      }}
      title={`${label} — drag, or double-click to reset`}
      className={`group relative shrink-0 flex items-center justify-center ${
        axis === 'x' ? 'w-[5px] cursor-col-resize' : 'h-[5px] cursor-row-resize'
      } ${dragging ? 'bg-accent/50' : 'hover:bg-accent/30 focus:bg-accent/30'} outline-none`}
    >
      {/* The grip: enough to read as a handle at rest, not enough to become
          a second border competing with the real ones. */}
      <span
        className={`rounded-full transition-colors ${
          axis === 'x' ? 'w-[3px] h-6' : 'h-[3px] w-8'
        } ${dragging ? 'bg-accent' : 'bg-ink-faint/40 group-hover:bg-accent'}`}
      />
    </div>
  );
}
