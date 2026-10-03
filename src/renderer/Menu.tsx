import { useEffect, useRef, type ReactNode } from 'react';

// A dropdown anchored under its trigger. The trigger and the panel sit in
// one `relative` wrapper the caller provides; the panel positions itself
// against it, so nothing has to measure the page.
//
// Dismissed by a click anywhere else and by Escape — Escape in the capture
// phase and stopped there, because the query pane also listens for it (to
// cancel a run) and closing a menu must not cancel anything.

const ITEMS = '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])';

export function Dropdown({
  open,
  onClose,
  label,
  align = 'right',
  width = 300,
  role = 'menu',
  children,
}: {
  open: boolean;
  onClose(): void;
  label: string;
  align?: 'left' | 'right';
  width?: number;
  role?: 'menu' | 'dialog';
  children: ReactNode;
}): JSX.Element | null {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // The wrapper holds the trigger too; a click on it toggles through
      // its own handler, and closing here first would reopen it.
      const wrapper = panel.current?.parentElement;
      if (wrapper && !wrapper.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose]);

  // A menu opened from the keyboard should be usable from the keyboard.
  useEffect(() => {
    if (!open || role !== 'menu') return;
    // A radio menu starts on the checked choice, not on whatever follows it.
    const el = panel.current;
    (el?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])') ?? el?.querySelector<HTMLElement>(ITEMS))?.focus();
  }, [open, role]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (role !== 'menu' || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const items = [...(panel.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div
      ref={panel}
      role={role}
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{ width }}
      className={`absolute top-full mt-1.5 z-40 ${align === 'right' ? 'right-0' : 'left-0'} rounded-lg border border-card bg-surface-elevated shadow-2xl shadow-black/40 ${
        role === 'menu' ? 'p-1 flex flex-col gap-px' : 'p-3.5'
      }`}
    >
      {children}
    </div>
  );
}

export function MenuItem({
  icon,
  label,
  detail,
  kbd,
  onSelect,
  disabled,
  tone,
}: {
  icon?: ReactNode;
  label: string;
  /// A second line saying what exactly this acts on.
  detail?: string;
  kbd?: string;
  onSelect(): void;
  disabled?: boolean;
  tone?: 'ai';
}): JSX.Element {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className="w-full min-h-[32px] px-2.5 py-1.5 rounded-[5px] flex items-center gap-2.5 text-left text-[12px] text-ink hover:bg-accent/15 focus:bg-accent/15 focus:outline-none disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <span className={`w-3.5 shrink-0 flex justify-center ${tone === 'ai' ? '' : 'text-ink-muted'}`}>{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block truncate">{label}</span>
        {detail && <span className="block truncate text-[10.5px] text-ink-muted mt-0.5">{detail}</span>}
      </span>
      {kbd && <kbd className="font-mono text-[10px] text-ink-muted">{kbd}</kbd>}
    </button>
  );
}

export function MenuDivider(): JSX.Element {
  return <div role="separator" className="h-px bg-rule my-1 mx-1.5" />;
}
