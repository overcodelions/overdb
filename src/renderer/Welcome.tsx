// What the main pane shows when nothing is selected.
//
// Two different people see it. Someone who has just installed overdb has no
// connections, and needs to learn what the app is FOR and get one working —
// ideally without typing a host they have to go and look up. Someone with
// twenty connections has just not picked one yet, and needs a way back in,
// not a lecture.
//
// The first-run page leads with the cheapest way to a working connection:
// servers already answering on this machine, then import from the tool they
// use today, then a blank form. The sample sits beside them for anyone who
// would rather see the comparison working before handing over a password.

import { useEffect, useState, type ReactNode } from 'react';
import type { Connection, EnvKind } from '@shared/types';
import { Kbd, Mark } from './Help';
import { useStore } from './store';
import { suggestEnvSet } from './envSetHint';

type Found = { engine: 'postgres' | 'mysql' | 'sqlite' | 'dynamodb'; host: string; port: number; version?: string };

export function Welcome(): JSX.Element {
  const hasConnections = useStore((s) => s.connections.length > 0);
  return hasConnections ? <PickUp /> : <FirstRun />;
}

// ---------------------------------------------------------------------
// First run

function FirstRun(): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  const openSample = useStore((s) => s.openSample);
  const [found, setFound] = useState<Found[] | null>(null);
  const [making, setMaking] = useState(false);

  useEffect(() => {
    let live = true;
    void window.overdb
      .invoke('conn:discoverLocal')
      .then((f) => live && setFound(f as Found[]))
      .catch(() => live && setFound([]));
    return () => {
      live = false;
    };
  }, []);

  const sample = async () => {
    setMaking(true);
    try {
      await openSample();
    } finally {
      setMaking(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-8 pb-12 pt-12">
        <header className="flex items-start gap-4">
          <Mark size={44} />
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Welcome to overdb</p>
            <h1 className="mt-1 text-[26px] font-semibold leading-[1.15] tracking-tight text-ink">
              Run it once.
              <br />
              See the answer in every environment.
            </h1>
            <p className="mt-3 max-w-[60ch] text-[12.5px] leading-relaxed text-ink-muted">
              The same database lives in local, staging and prod. overdb keeps them side by side:
              one statement runs on all of them, each answer is compared to prod, and the schema
              differences are listed before they surprise you.
            </p>
          </div>
        </header>

        <Steps />

        <SectionLabel>Get connected</SectionLabel>
        <div className="grid grid-cols-2 gap-2.5">
          <Tile
            title="Found on this machine"
            body={
              found === null
                ? 'Asking the usual ports what is running…'
                : found.length === 0
                  ? 'Nothing answering on the usual Postgres and MySQL ports.'
                  : 'Engine, host and port filled in. The database and password are still yours to give.'
            }
            muted={found !== null && found.length === 0}
            icon={<Glyph d="M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Zm0 3v2.8l1.8 1.2" />}
          >
            {found && found.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {found.map((s) => (
                  <button
                    key={`${s.engine}:${s.port}`}
                    onClick={() => setSheet({ kind: 'newConnection', found: s })}
                    className="flex items-center gap-1.5 rounded border border-card bg-surface px-2 py-1 text-[11px] text-ink hover:border-accent/60 hover:bg-card"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-good" />
                    {s.version?.replace(/^5\.5\.5-/, '') ?? s.engine}
                    <span className="font-mono text-ink-faint">:{s.port}</span>
                  </button>
                ))}
              </div>
            )}
          </Tile>

          <Tile
            title="Import what you already have"
            body="From DataGrip, DataSpell or IntelliJ, a project's .idea folder, ~/.pgpass, or DATABASE_URL-style variables. Nothing is created until you pick."
            onClick={() => setSheet({ kind: 'importConnections' })}
            icon={<Glyph d="M8 2.5v7m0 0L5.2 6.7M8 9.5l2.8-2.8M3 10.5v1.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1.5" />}
          />

          <Tile
            title="New connection"
            body="Postgres, MySQL, SQLite or DynamoDB. Paste a connection URL and the form fills itself; SSH tunnels, TLS certificates and IAM auth are there when you need them."
            onClick={() => setSheet({ kind: 'newConnection' })}
            icon={<Glyph d="M8 3.5v9M3.5 8h9" />}
            primary
          />

          <Tile
            title={making ? 'Building the sample…' : 'Try it on a sample'}
            body="One small shop database in three environments that have drifted apart. SQLite files on this machine — nothing to configure, nothing leaves it."
            onClick={making ? undefined : () => void sample()}
            icon={
              <Glyph d="M3 4.5C3 3.4 5.2 2.5 8 2.5s5 .9 5 2v7c0 1.1-2.2 2-5 2s-5-.9-5-2v-7Zm0 0c0 1.1 2.2 2 5 2s5-.9 5-2M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
            }
          />
        </div>

        <Promises />
      </div>
    </div>
  );
}

/// The three moves the whole app is built out of, drawn as the thing they
/// build: connections on the left, gathered into a set, answering together.
function Steps(): JSX.Element {
  const steps: { n: string; title: string; body: string }[] = [
    {
      n: '1',
      title: 'Add a connection per environment',
      body: 'Each one tagged local, staging, prod… The tag is what overdb is careful about.',
    },
    {
      n: '2',
      title: 'Gather them into an environment set',
      body: 'The same database in each place, with prod as the baseline. overdb offers to when it spots one.',
    },
    {
      n: '3',
      title: 'Ask once',
      body: 'Every member runs the statement; each answer is compared to the baseline. Schema drift needs no statement at all.',
    },
  ];
  return (
    <ol className="mt-8 grid grid-cols-3 gap-2.5">
      {steps.map((s) => (
        <li key={s.n} className="rounded-lg border border-card bg-wash p-3">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/15 font-mono text-[10px] font-semibold text-accent">
            {s.n}
          </span>
          <div className="mt-2 text-xs font-medium text-ink">{s.title}</div>
          <div className="mt-1 text-[11px] leading-relaxed text-ink-muted">{s.body}</div>
        </li>
      ))}
    </ol>
  );
}

/// What someone is agreeing to by adding a production password. Said on the
/// first screen because it is the question they have before the first one.
function Promises(): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  const items: [string, string][] = [
    ['Read-only by default', 'Writes are switched on per connection, and on prod you type its name first.'],
    ['Passwords stay in your keychain', 'Or are read at connect time from an env var, .env file, 1Password or IAM.'],
    ['AI on your own login', 'Through claude, codex or gemini if you have one. Never your rows; never run for you.'],
  ];
  return (
    <>
      <SectionLabel>Before you add a password</SectionLabel>
      <div className="grid grid-cols-3 gap-4">
        {items.map(([title, body]) => (
          <div key={title}>
            <div className="flex items-center gap-1.5 text-xs font-medium text-ink">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-good" aria-hidden>
                <path d="m3.5 8.5 3 3 6-7" />
              </svg>
              {title}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{body}</p>
          </div>
        ))}
      </div>
      <div className="mt-8 flex items-center gap-3 border-t border-card pt-4 text-[11px] text-ink-faint">
        <button onClick={() => setSheet({ kind: 'basics' })} className="text-accent hover:underline">
          How overdb works
        </button>
        <span>·</span>
        <button onClick={() => setSheet({ kind: 'shortcuts' })} className="hover:text-ink">
          Keyboard shortcuts
        </button>
        <span className="flex-1" />
        <span className="flex items-center gap-1.5">
          <Kbd keys="⌘K" /> goes anywhere
        </span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------
// Connections exist, none selected

const ENV_DOT: Record<EnvKind, string> = {
  local: 'bg-good/80',
  dev: 'bg-good/60',
  sandbox: 'bg-warn/80',
  staging: 'bg-warn/60',
  prod: 'bg-bad/80',
  other: 'bg-ink-faint/70',
};

function PickUp(): JSX.Element {
  const connections = useStore((s) => s.connections);
  const envSets = useStore((s) => s.envSets);
  const select = useStore((s) => s.select);
  const setSheet = useStore((s) => s.setSheet);

  const recent = [...connections]
    .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''))
    .slice(0, 6);
  const sets = envSets.filter((e) => !e.archived).slice(0, 4);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[620px] px-8 pb-12 pt-14">
        <div className="flex items-center gap-3">
          <Mark size={30} />
          <div>
            <h1 className="text-base font-semibold text-ink">Pick up where you left off</h1>
            <p className="text-[11.5px] text-ink-muted">
              Choose a connection or a set, or press <Kbd keys="⌘K" /> to jump by name.
            </p>
          </div>
        </div>

        <EnvSetSuggestion className="mt-6" />

        {sets.length > 0 && (
          <>
            <SectionLabel>Environment sets</SectionLabel>
            <List>
              {sets.map((e) => (
                <ListRow
                  key={e.id}
                  onClick={() => select({ kind: 'envSet', id: e.id })}
                  label={e.name}
                  detail={[
                    ...new Set(
                      e.memberIds
                        .map((id) => connections.find((c) => c.id === id)?.env)
                        .filter((x): x is EnvKind => !!x),
                    ),
                  ].join(' · ')}
                  lead={<span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                />
              ))}
            </List>
          </>
        )}

        <SectionLabel>{recent.some((c) => c.lastOpenedAt) ? 'Recently opened' : 'Connections'}</SectionLabel>
        <List>
          {recent.map((c) => (
            <ListRow
              key={c.id}
              onClick={() => select({ kind: 'connection', id: c.id })}
              label={c.name}
              detail={describe(c)}
              lead={<span className={`h-1.5 w-1.5 rounded-full ${ENV_DOT[c.env]}`} />}
            />
          ))}
        </List>

        <div className="mt-6 flex flex-wrap items-center gap-2 text-[11px]">
          <button onClick={() => setSheet({ kind: 'newConnection' })} className="rounded border border-card px-2.5 py-1.5 text-ink-muted hover:bg-card hover:text-ink">
            New connection
          </button>
          <button onClick={() => setSheet({ kind: 'newEnvSet' })} className="rounded border border-card px-2.5 py-1.5 text-ink-muted hover:bg-card hover:text-ink">
            New environment set
          </button>
          <span className="flex-1" />
          <button onClick={() => setSheet({ kind: 'basics' })} className="text-ink-faint hover:text-ink">
            How overdb works
          </button>
        </div>
      </div>
    </div>
  );
}

function describe(c: Connection): string {
  const where =
    c.engine === 'sqlite'
      ? c.file?.split(/[\\/]/).pop()
      : c.engine === 'dynamodb'
        ? c.region
        : [c.host, c.database].filter(Boolean).join(' / ');
  return [c.env, where].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------
// The set-up suggestion. Shown here and at the top of the sidebar, because
// it is the one step people skip and the one the app is built around.

export function EnvSetSuggestion({ className = '', compact }: { className?: string; compact?: boolean }): JSX.Element | null {
  const connections = useStore((s) => s.connections);
  const envSets = useStore((s) => s.envSets);
  const dismissed = useStore((s) => s.settings.dismissedHints);
  const dismissHint = useStore((s) => s.dismissHint);
  const setSheet = useStore((s) => s.setSheet);

  const hint = suggestEnvSet(connections, envSets, dismissed);
  if (!hint) return null;
  const members = hint.memberIds
    .map((id) => connections.find((c) => c.id === id))
    .filter((c): c is Connection => !!c);
  const envs = [...new Set(members.map((c) => c.env))];

  return (
    <div className={`rounded-lg border border-accent/35 bg-accent/[0.06] ${compact ? 'p-2.5' : 'p-3.5'} ${className}`}>
      <div className={`${compact ? 'text-[11px]' : 'text-xs'} font-medium text-ink`}>
        <span className="font-mono">{hint.name}</span> is in {envs.join(' and ')}
      </div>
      <p className={`mt-1 ${compact ? 'text-[10.5px]' : 'text-[11.5px]'} leading-relaxed text-ink-muted`}>
        Put {members.length === 2 ? 'both' : `all ${members.length}`} in an environment set to run
        one statement on each and see where they differ.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() =>
            setSheet({
              kind: 'newEnvSet',
              suggested: { name: hint.name, memberIds: hint.memberIds, baselineId: hint.baselineId },
            })
          }
          className="rounded bg-accent px-2.5 py-1 text-[11px] text-white hover:bg-accent-strong"
        >
          Make a set
        </button>
        <button onClick={() => dismissHint(hint.id)} className="px-1.5 py-1 text-[11px] text-ink-faint hover:text-ink">
          Not now
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Pieces

function SectionLabel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="mb-2.5 mt-8 flex items-baseline gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{children}</span>
      <span className="h-px flex-1 bg-card" />
    </div>
  );
}

function Tile({
  title,
  body,
  icon,
  onClick,
  primary,
  muted,
  children,
}: {
  title: string;
  body: string;
  icon: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  muted?: boolean;
  children?: ReactNode;
}): JSX.Element {
  const inner = (
    <>
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
          primary ? 'bg-accent text-white' : 'bg-accent/15 text-accent'
        } ${muted ? 'opacity-50' : ''}`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-xs font-semibold ${muted ? 'text-ink-muted' : 'text-ink'}`}>{title}</span>
        <span className="mt-1 block text-[11.5px] leading-relaxed text-ink-muted">{body}</span>
        {children}
      </span>
    </>
  );
  const cls = `flex gap-3 rounded-lg border p-3.5 text-left ${
    primary ? 'border-accent/50 bg-accent/[0.05]' : 'border-card bg-wash'
  }`;
  return onClick ? (
    <button onClick={onClick} className={`${cls} transition-colors hover:border-accent/60 hover:bg-wash-strong`}>
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

function Glyph({ d }: { d: string }): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function List({ children }: { children: ReactNode }): JSX.Element {
  return <div className="overflow-hidden rounded-lg border border-card divide-y divide-rule">{children}</div>;
}

function ListRow({
  label,
  detail,
  lead,
  onClick,
}: {
  label: string;
  detail: string;
  lead: ReactNode;
  onClick(): void;
}): JSX.Element {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-card">
      <span className="flex w-2 justify-center">{lead}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-ink">{label}</span>
      <span className="truncate text-[10.5px] text-ink-faint">{detail}</span>
    </button>
  );
}
