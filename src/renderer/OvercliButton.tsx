import { useState } from 'react';

import { OVERCLI_SITE, useOvercliAvailable } from './overcli';

const PROMO_HIDDEN_KEY = 'overdb.overcli.promoHidden';

function promoHidden(): boolean {
  try {
    return localStorage.getItem(PROMO_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

/// The way from a finding to the code behind it.
///
/// With overcli installed: a lit button that hands the finding over. Without
/// it: the same spot, quieter, pointing at overcli.app — once per finding
/// view, with a × that puts it away for good, because an ad on every plan
/// is how a tool loses the benefit of the doubt.
export function OvercliButton({
  onSend,
  compact = false,
}: {
  onSend(): void;
  /// The slow-query row's inline size.
  compact?: boolean;
}): JSX.Element | null {
  const available = useOvercliAvailable();
  const [hidden, setHidden] = useState(promoHidden);
  const size = compact ? 'text-[10px] px-2 py-0.5' : 'text-[11px] px-2.5 py-1';

  if (available === null) return null;

  if (available) {
    return (
      <button
        onClick={onSend}
        title="Hand this to overcli, to find and fix the code behind it. It opens there as a draft; nothing runs until you send it."
        className={`overcli-glow inline-flex items-center gap-1.5 rounded-full font-medium ${size} bg-accent/15 border border-accent/60 text-accent hover:bg-accent/25`}
      >
        <Arrow />
        Fix it in overcli
      </button>
    );
  }

  if (hidden) return null;
  return (
    <span className={`inline-flex items-center rounded-full border border-card ${size} text-ink-faint`}>
      <button
        onClick={() => void window.overdb.invoke('app:openExternal', OVERCLI_SITE)}
        title="overcli is a desktop app for coding agents. With it installed, overdb can hand this finding to an agent working in the repo behind it."
        className="inline-flex items-center gap-1.5 hover:text-accent"
      >
        <Arrow />
        Fix it with overcli ↗
      </button>
      <button
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem(PROMO_HIDDEN_KEY, '1');
          } catch {
            // Hidden for this session, then.
          }
        }}
        title="Don’t suggest overcli again"
        aria-label="Don’t suggest overcli again"
        className="ml-1.5 -mr-0.5 hover:text-ink"
      >
        ×
      </button>
    </span>
  );
}

function Arrow(): JSX.Element {
  return (
    <svg aria-hidden width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 8h9M8 4.5 11.5 8 8 11.5M14 3v10" />
    </svg>
  );
}
