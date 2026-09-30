// Small stroke icons shared by the editor header and the statement strip.
// Inline SVG in currentColor, so each one takes the colour of the text
// beside it and needs no theme of its own.

type Props = { className?: string };

/// "A model is involved" — filled in `--c-ai` by the `.ai-spark` rule in
/// styles.css, the same mark the gutter uses.
export function Sparkle({ className = 'w-[13px] h-[13px]' }: Props): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={`ai-spark block ${className}`} aria-hidden="true">
      <path d="M12 3.5 13.6 8.9 19 10.5 13.6 12.1 12 17.5 10.4 12.1 5 10.5 10.4 8.9Z" />
      <path d="M18.2 16.4 18.9 18.6 21 19.3 18.9 20 18.2 22.2 17.5 20 15.4 19.3 17.5 18.6Z" />
    </svg>
  );
}

export function Chevron({ className = 'w-2.5 h-2.5', up = false }: Props & { up?: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={className} aria-hidden="true">
      <path d={up ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'} />
    </svg>
  );
}

export function Dots({ className = 'w-3.5 h-3.5' }: Props): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

export function Play({ className = 'w-2.5 h-2.5' }: Props): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M6 4l14 8-14 8z" />
    </svg>
  );
}

export function Stop({ className = 'w-2.5 h-2.5' }: Props): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

export function TableGrid({ className = 'w-[13px] h-[13px]' }: Props): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M9 10v10" />
    </svg>
  );
}

/// An environment set: several of the same thing.
export function SetIcon({ className = 'w-3 h-3' }: Props): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden="true">
      <rect x="3" y="4" width="7" height="7" rx="1.5" />
      <rect x="14" y="4" width="7" height="7" rx="1.5" />
      <rect x="8.5" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function Lines({ className = 'w-3 h-3' }: Props): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

export function PlanIcon({ className = 'w-3 h-3' }: Props): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 5h6v4H4zM14 15h6v4h-6zM7 9v4h10v2" />
    </svg>
  );
}

export function Clock({ className = 'w-[13px] h-[13px]' }: Props): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function Lock({ className = 'w-3 h-3' }: Props): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function Wand({ className = 'w-3 h-3' }: Props): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 20L16 8M14 6l4 4M18 3v3M21 6h-3M20 13v2M21 14h-2" />
    </svg>
  );
}
