// The help sheets: How overdb works, Keyboard shortcuts, and About.
//
// The app uses words it never defines — environment set, baseline, drift,
// Plan versus Explain — and the only explanation of them used to be the
// welcome screen, which disappears the moment a connection exists. Someone
// three weeks in who wants to know what the baseline is for has nowhere to
// ask. This is that place: Help in the menu bar, the ? in the title bar, and
// the command palette all lead here, and each sheet's footer leads to the
// others.
//
// All three share one frame (see SheetHost), so moving between them does not
// resize the window under the pointer.

import { useEffect, useState, type ReactNode } from 'react';
import type { AiTool } from '@shared/types';
import { useStore } from './store';

export const isMac =
  typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');

/// The app mark: three stacked arcs, a platter stack. Same drawing as
/// build/icon.svg, minus the dock finish (shade, rim, drop shadow): in the
/// UI a CSS shadow does that job. The viewBox is cropped to the tile so the
/// shadow hugs it.
/// Below 64px the dock drawing's strokes fall to about two device pixels
/// on a 1x screen and break up, so small marks use a heavier cut of the
/// same shape.
export function Mark({ size = 38 }: { size?: number }): JSX.Element {
  const small = size < 64;
  return (
    <svg width={size} height={size} viewBox="100 100 824 824" className="shrink-0 rounded-[22%] shadow-sm" aria-label="overdb">
      <rect x="100" y="100" width="824" height="824" rx="185" ry="185" fill="#ffffff" />
      {small ? (
        <g fill="none" stroke="#111113" strokeWidth="72" strokeLinecap="round">
          <path d="M322 300 Q 512 466 702 300" />
          <path d="M322 474 Q 512 640 702 474" />
          <path d="M322 648 Q 512 814 702 648" />
        </g>
      ) : (
        <g fill="none" stroke="#111113" strokeWidth="50" strokeLinecap="round">
          <path d="M332 302 Q 512 462 692 302" />
          <path d="M332 472 Q 512 632 692 472" />
          <path d="M332 642 Q 512 802 692 642" />
        </g>
      )}
    </svg>
  );
}

/// A wash behind the mark and a title that is a sentence rather than a noun.
export function HelpHeader({ title, lead }: { title: string; lead: ReactNode }): JSX.Element {
  return (
    <header
      className="relative shrink-0 overflow-hidden border-b border-card px-6 pb-5 pt-5"
      style={{
        backgroundImage:
          'linear-gradient(180deg, rgb(var(--c-accent) / 0.13) 0%, rgb(var(--c-accent) / 0.04) 55%, transparent 100%)',
      }}
    >
      <div className="relative flex items-start gap-4">
        <Mark />
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold leading-tight tracking-tight text-ink">{title}</h2>
          <div className="mt-1.5 max-w-[62ch] text-xs leading-relaxed text-ink-muted">{lead}</div>
        </div>
      </div>
    </header>
  );
}

export function HelpSection({
  title,
  lead,
  children,
  first,
}: {
  title: string;
  lead?: ReactNode;
  children: ReactNode;
  first?: boolean;
}): JSX.Element {
  return (
    <section className={first ? '' : 'mt-6'}>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{title}</span>
        <span className="h-px flex-1 bg-card" />
      </div>
      {lead && <p className="mt-2 max-w-[70ch] text-[11.5px] leading-relaxed text-ink-muted">{lead}</p>}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

/// The thing on the left in the app's own words, what it means on the right.
export function HelpRow({
  title,
  kicker,
  body,
  tone,
}: {
  title: string;
  kicker?: ReactNode;
  body: ReactNode;
  tone?: 'warn';
}): JSX.Element {
  return (
    <div
      className={`rounded-lg border p-3 ${
        tone === 'warn' ? 'border-warn/40 bg-warn/[0.06]' : 'border-card bg-wash'
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-xs font-medium text-ink">{title}</span>
        {kicker && <span className="text-[10.5px] text-ink-faint">{kicker}</span>}
      </div>
      <div className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">{body}</div>
    </div>
  );
}

function HelpFooter({ current }: { current: 'basics' | 'shortcuts' | 'about' }): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  const openSample = useStore((s) => s.openSample);
  const link = (label: string, onClick: () => void) => (
    <button
      onClick={onClick}
      className="rounded px-2.5 py-1.5 text-[11px] text-ink-muted hover:bg-card hover:text-ink"
    >
      {label}
    </button>
  );
  return (
    <footer className="flex shrink-0 items-center gap-1 border-t border-card px-4 py-2.5">
      {current !== 'basics' && link('How overdb works', () => setSheet({ kind: 'basics' }))}
      {current !== 'shortcuts' && link('Keyboard shortcuts', () => setSheet({ kind: 'shortcuts' }))}
      {current !== 'about' && link('About', () => setSheet({ kind: 'about' }))}
      {link('Try the sample', () => void openSample())}
      <span className="flex-1" />
      {link('Close', () => setSheet(null))}
    </footer>
  );
}

/// A key cap. Takes the key as the app writes it on a Mac; everywhere else
/// ⌘ reads as Ctrl, ⌥ as Alt and ⇧ as Shift.
export function Kbd({ keys }: { keys: string }): JSX.Element {
  const parts = isMac
    ? [...keys.replace(/\s+/g, '')]
        // `Esc`, `Tab` and friends stay whole.
        .reduce<string[]>((acc, ch) => {
          const last = acc[acc.length - 1];
          if (last && /^[A-Za-z]+$/.test(last) && /[a-z]/.test(ch)) acc[acc.length - 1] = last + ch;
          else acc.push(ch);
          return acc;
        }, [])
    : keys
        .replace(/⌘/g, 'Ctrl ')
        .replace(/⌥/g, 'Alt ')
        .replace(/⇧/g, 'Shift ')
        .replace(/↵/g, 'Enter')
        .trim()
        .split(/\s+/);
  return (
    <span className="inline-flex items-center gap-0.5 align-middle">
      {parts.map((p, i) => (
        <kbd
          key={i}
          className="inline-flex min-w-[18px] items-center justify-center rounded border border-card bg-surface px-1 py-[1px] font-mono text-[10px] leading-none text-ink-muted shadow-[0_1px_0_rgb(0_0_0/0.08)]"
        >
          {p}
        </kbd>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------
// How overdb works

const NOUNS: { title: string; tone: string; body: string; glyph: ReactNode }[] = [
  {
    title: 'Connection',
    tone: 'var(--c-tag-sky)',
    body: 'One database in one place, tagged with where it runs — local, dev, sandbox, staging or prod. The tag sets the colour it wears everywhere, and how careful overdb is with it.',
    glyph: <path d="M3 4.5C3 3.4 5.2 2.5 8 2.5s5 .9 5 2v7c0 1.1-2.2 2-5 2s-5-.9-5-2v-7Zm0 0c0 1.1 2.2 2 5 2s5-.9 5-2" />,
  },
  {
    title: 'Environment set',
    tone: 'rgb(var(--c-accent))',
    body: 'The same database across environments. Select one and every statement runs on every member, with each answer compared to the baseline. Its Schema drift tab compares their catalogs without running anything.',
    glyph: (
      <>
        <path d="M8 2 14 5.2 8 8.4 2 5.2 8 2Z" />
        <path d="m2 8.4 6 3.2 6-3.2" />
        <path d="m2 11.4 6 3.2 6-3.2" opacity="0.5" />
      </>
    ),
  },
  {
    title: 'Baseline',
    tone: 'var(--c-tag-rose)',
    body: 'The member of a set the others are compared against — usually prod, because prod is the truth. It is what gives "staging is missing an index" a direction.',
    glyph: (
      <>
        <circle cx="8" cy="8" r="5.5" />
        <circle cx="8" cy="8" r="2" />
      </>
    ),
  },
  {
    title: 'Connection group',
    tone: 'var(--c-tag-emerald)',
    body: 'A section of the sidebar: "these are Payments". Independent of sets — the same connection can sit in a group and in any number of sets.',
    glyph: <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.1 1.3H13a1 1 0 0 1 1 1v5.9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5Z" />,
  },
];

export function NounCards(): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {NOUNS.map((n) => (
        <div key={n.title} className="flex gap-3 rounded-lg border border-card bg-wash p-3">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
            style={{ color: n.tone, background: `color-mix(in srgb, ${n.tone} 15%, transparent)` }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden>
              {n.glyph}
            </svg>
          </span>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-ink">{n.title}</div>
            <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">{n.body}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function BasicsSheet(): JSX.Element {
  return (
    <div className="flex max-h-[80vh] flex-col">
      <HelpHeader
        title="You don't have a database. You have environments."
        lead={
          <>
            The same schema lives in local, staging and prod, and the useful questions are
            comparisons between them. overdb keeps them side by side, so a query you ask of one you
            can ask of all of them — and see where they disagree.
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <HelpSection title="The four nouns" first>
          <NounCards />
        </HelpSection>

        <HelpSection
          title="Safe until you say otherwise"
          lead="Every connection opens read-only. The rest of this is what changes that, and what stops it going wrong."
        >
          <div className="grid grid-cols-2 gap-2.5">
            <HelpRow
              title="Read-only"
              kicker="the default"
              body="Postgres, MySQL and SQLite enforce it in the database or the driver, not just in this window. DynamoDB has no such mode, so overdb refuses anything that is not a read — pair it with a read-only IAM policy."
            />
            <HelpRow
              title="Writes"
              kicker="per connection, and they stick"
              body="Turned on from the query bar, and remembered — 'this is my scratch database' is a fact, not a mood. On a prod connection you type its name first."
              tone="warn"
            />
            <HelpRow
              title="Manual transactions"
              kicker="review before commit"
              body="Hold one open across statements so a DELETE can be checked before it lands. Left idle for 90 seconds it rolls itself back, rather than holding locks on a busy server."
            />
            <HelpRow
              title="Passwords"
              kicker="never in this window"
              body="Kept in your OS keychain, or read at connect time from an environment variable, a .env file, 1Password, a command you name, or an AWS IAM token."
            />
          </div>
        </HelpSection>

        <HelpSection title="Where things are">
          <div className="grid grid-cols-2 gap-2.5">
            <HelpRow
              title="Run, Plan, Explain"
              kicker={<><Kbd keys="⌘↵" /> <Kbd keys="⌥↵" /></>}
              body="Run executes the statement at your cursor. Plan draws its EXPLAIN without executing it and uses no AI. Explain is Plan plus a model's reading of it."
            />
            <HelpRow
              title="Tables"
              kicker="query bar"
              body="Browse the catalog and build a query from its keys. Joins complete from the foreign keys the server holds — no guessing from column names."
            />
            <HelpRow
              title="History, Health, Diagram, Slow"
              kicker="tabs under the editor"
              body="Everything you have run, with saved queries; what the server is doing now; the foreign-key graph; and what it has spent its time on across every client."
            />
            <HelpRow
              title="Placeholders"
              kicker="?  :name  #{name}"
              body="Paste a statement straight from an ORM log and fill its holes in the bar under the editor. Values are bound, never pasted in, and remembered per environment."
            />
          </div>
        </HelpSection>

        <AiSection />
      </div>

      <HelpFooter current="basics" />
    </div>
  );
}

/// What AI does here, with the live answer to "will it work on this
/// machine" — which is the question someone opening this actually has.
function AiSection(): JSX.Element {
  const [tools, setTools] = useState<Record<AiTool, boolean> | null>(null);
  const setSheet = useStore((s) => s.setSheet);
  useEffect(() => {
    void window.overdb.invoke('ai:detect').then(setTools).catch(() => setTools(null));
  }, []);

  return (
    <HelpSection
      title="AI, on your own login"
      lead={
        <>
          Ask in plain English, fix a failed statement, read a plan. overdb holds no key: it hands
          the question to whichever of these you have already signed into. Prompts carry schema
          metadata, SQL text and error messages — never result rows or bound values. What comes
          back lands in the editor for you to read; nothing a model writes is run for you.
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {(['claude', 'codex', 'gemini'] as AiTool[]).map((t) => {
          const ok = tools?.[t];
          return (
            <span
              key={t}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] ${
                ok ? 'border-good/40 text-ink' : 'border-card text-ink-faint'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-good' : tools ? 'bg-ink-faint/50' : 'bg-ink-faint/30'}`} />
              {t}
              <span className="font-sans text-[10px] text-ink-faint">
                {tools === null ? 'checking…' : ok ? 'ready' : 'not installed'}
              </span>
            </span>
          );
        })}
        <button
          onClick={() => setSheet({ kind: 'settings' })}
          className="ml-1 text-[11px] text-accent hover:underline"
        >
          Choose which one and its model
        </button>
      </div>
      {tools && !tools.claude && !tools.codex && !tools.gemini && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          None found. Everything else in overdb works without one — install and sign into any of
          the three and the AI features appear, no restart needed.
        </p>
      )}
    </HelpSection>
  );
}

// ---------------------------------------------------------------------
// Keyboard shortcuts

/// Every shortcut the app actually binds, grouped by where it works. Kept by
/// hand, so check it when adding a binding: a list that promises a key that
/// does nothing is worse than no list.
export const SHORTCUTS: { title: string; items: [keys: string, what: string][] }[] = [
  {
    title: 'Anywhere',
    items: [
      ['⌘K', 'Go to a connection, set, saved query or view'],
      ['⌘\\', 'Show or hide the sidebar'],
      ['⌘F', 'Filter the sidebar'],
      ['⌘,', 'Settings'],
      ['⌘/', 'This list'],
      ['Esc', 'Close a sheet or the palette'],
    ],
  },
  {
    title: 'Editor',
    items: [
      ['⌘↵', 'Run the statement at the cursor — or turn a question into SQL'],
      ['⇧⌘↵', 'Run every statement in the editor'],
      ['⌥↵', 'Plan the statement at the cursor, without running it'],
      ['⇧⌥F', 'Format every statement'],
      ['Tab', 'Accept the highlighted completion'],
      ['⌘T', 'New tab on this connection'],
      ['⌘I', 'Ask about this database'],
      ['Esc', 'Cancel a running statement, on the server'],
    ],
  },
  {
    title: 'Results',
    items: [
      ['⌘A', 'Select every row'],
      ['⌘C', 'Copy the selection as tab-separated text'],
      ['⇧', 'Hold while clicking to extend the selection'],
    ],
  },
  {
    title: 'Diagram',
    items: [['⌘', 'Hold while scrolling to zoom; drag to pan']],
  },
];

export function ShortcutsSheet(): JSX.Element {
  return (
    <div className="flex max-h-[80vh] flex-col">
      <HelpHeader
        title="Keyboard shortcuts"
        lead={
          <>
            Right-click a selection for the other copy formats — CSV, JSON, INSERT and Markdown.
            Click a column header to sort it, or its funnel to filter; double-click a cell to edit
            it once writes are on.
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 grid grid-cols-2 gap-x-8 gap-y-5">
        {SHORTCUTS.map((group) => (
          <section key={group.title}>
            <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              {group.title}
            </h3>
            <ul className="flex flex-col gap-1.5">
              {group.items.map(([keys, what]) => (
                <li key={keys + what} className="flex items-baseline gap-3 text-[11.5px] text-ink-muted">
                  <span className="w-[68px] shrink-0">
                    <Kbd keys={keys} />
                  </span>
                  <span className="leading-snug">{what}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <HelpFooter current="shortcuts" />
    </div>
  );
}

// ---------------------------------------------------------------------
// About

export function AboutSheet(): JSX.Element {
  const [enc, setEnc] = useState<{ encrypted: boolean; backend: string } | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void window.overdb.invoke('conn:secretsEncrypted').then(setEnc);
    void window.overdb.invoke('app:version').then((v) => setVersion(v.app));
  }, []);
  const open = (url: string) => void window.overdb.invoke('app:openExternal', url);

  return (
    <div className="flex max-h-[80vh] flex-col">
      <HelpHeader
        title="overdb"
        lead={
          <>
            A database client built around environments rather than connections.{' '}
            {version && <span className="font-mono text-ink-faint">v{version}</span>}
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <HelpSection title="What it keeps, and where" first>
          <div className="grid grid-cols-2 gap-2.5">
            <HelpRow
              title="Credentials"
              body={
                enc && !enc.encrypted
                  ? 'No OS keychain is available here, so a stored password is only base64 on disk — not encrypted. Use the environment variable or 1Password source instead.'
                  : 'Encrypted with your OS keychain, in a file of their own. They never reach this window.'
              }
              tone={enc && !enc.encrypted ? 'warn' : undefined}
            />
            <HelpRow
              title="AI"
              body="Runs through your own installed claude, codex or gemini login. Prompts never contain your rows."
            />
          </div>
        </HelpSection>
        <HelpSection title="The family">
          <p className="text-[11.5px] leading-relaxed text-ink-muted">
            A sibling of{' '}
            <button className="text-accent hover:underline" onClick={() => open('https://github.com/overcodelions/overcli')}>
              overcli
            </button>{' '}
            and{' '}
            <button className="text-accent hover:underline" onClick={() => open('https://github.com/overcodelions/overgit')}>
              overgit
            </button>
            . Source, issues and the changelog are at{' '}
            <button className="text-accent hover:underline" onClick={() => open('https://github.com/overcodelions/overdb')}>
              github.com/overcodelions/overdb
            </button>
            .
          </p>
        </HelpSection>
      </div>
      <HelpFooter current="about" />
    </div>
  );
}
