import type { Connection, EnvKind } from '@shared/types';
import { useStore } from './store';

/// Env sets sit ABOVE connection groups, deliberately: the in-flight unit
/// of work should be reachable without scrolling past durable structure.
/// Same call overgit makes with active worksets.
export function Sidebar(): JSX.Element {
  const connections = useStore((s) => s.connections);
  const groups = useStore((s) => s.groups);
  const envSets = useStore((s) => s.envSets);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const setSheet = useStore((s) => s.setSheet);

  const ungrouped = connections.filter(
    (c) => !groups.some((g) => g.connectionIds.includes(c.id)),
  );
  const active = envSets.filter((e) => !e.archived);

  // Environment order is deliberate and fixed: it reads the way work flows,
  // and it puts prod at the bottom where it is hardest to click by accident.
  const ENV_ORDER: EnvKind[] = ['local', 'dev', 'staging', 'prod', 'other'];
  const byEnv = ENV_ORDER.map((env) => ({
    env,
    items: ungrouped.filter((c) => c.env === env),
  })).filter((bucket) => bucket.items.length > 0);
  // One environment is not a grouping, it is a list — don't add a heading
  // that tells the user something they can already see.
  const showEnvHeadings = byEnv.length > 1;

  return (
    <div className="h-full flex flex-col bg-surface-muted border-r border-card overflow-y-auto">
      <Section
        label="Environment sets"
        action={{ title: 'New environment set', onClick: () => setSheet({ kind: 'newEnvSet' }) }}
      >
        {active.length === 0 ? (
          <Empty>Group the same database across local, staging, and prod to query them together.</Empty>
        ) : (
          active.map((e) => (
            <Row
              key={e.id}
              label={e.name}
              detail={`${e.memberIds.length} env${e.memberIds.length === 1 ? '' : 's'}`}
              selected={selection?.kind === 'envSet' && selection.id === e.id}
              onClick={() => select({ kind: 'envSet', id: e.id })}
            />
          ))
        )}
      </Section>

      {groups.map((g) => (
        <Section key={g.id} label={g.name}>
          {connections
            .filter((c) => g.connectionIds.includes(c.id))
            .map((c) => (
              <ConnectionRow key={c.id} connection={c} />
            ))}
        </Section>
      ))}

      {ungrouped.length === 0 ? (
        <Section label="Connections">
          <Empty>No connections yet.</Empty>
        </Section>
      ) : showEnvHeadings ? (
        byEnv.map(({ env, items }) => (
          <Section key={env} label={env}>
            {items.map((c) => (
              <ConnectionRow key={c.id} connection={c} showEnv={false} />
            ))}
          </Section>
        ))
      ) : (
        <Section label="Connections">
          {ungrouped.map((c) => (
            <ConnectionRow key={c.id} connection={c} />
          ))}
        </Section>
      )}

      {/* Pinned to the bottom: adding a connection is the one action you
          need before anything else works, and hunting for a 10px + in a
          section header is a poor way to offer it. */}
      <div className="mt-auto sticky bottom-0 border-t border-card bg-surface-muted px-3 py-2">
        <button
          onClick={() => setSheet({ kind: 'newConnection' })}
          className="w-full text-left text-xs px-1 py-1 text-ink-faint hover:text-accent flex items-center gap-1.5"
        >
          <span className="text-sm leading-none">+</span>
          New connection
        </button>
        <button
          onClick={() => setSheet({ kind: 'importConnections' })}
          title="Import from DataGrip, DataSpell, IntelliJ or ~/.pgpass"
          className="w-full text-left text-xs px-1 py-1 text-ink-faint hover:text-accent"
        >
          Import from another tool…
        </button>
      </div>
    </div>
  );
}

function ConnectionRow({
  connection,
  showEnv = true,
}: {
  connection: Connection;
  /// Suppressed when the section heading already says it.
  showEnv?: boolean;
}): JSX.Element {
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const askConfirm = useStore((s) => s.askConfirm);
  const setSheet = useStore((s) => s.setSheet);
  const removeConnection = useStore((s) => s.removeConnection);

  const requestDelete = () =>
    askConfirm({
      title: `Delete ${connection.name}?`,
      body:
        'This removes the connection from overdb and deletes its stored password. ' +
        'The database itself is untouched — nothing is dropped, and no data is deleted.',
      confirmLabel: 'Delete connection',
      destructive: true,
      onConfirm: () => removeConnection(connection.id),
    });

  return (
    <Row
      label={connection.name}
      detail={showEnv ? connection.env : undefined}
      onEdit={() => setSheet({ kind: 'editConnection', id: connection.id })}
      editTitle={`Edit ${connection.name}`}
      onDelete={requestDelete}
      deleteTitle={`Delete ${connection.name}`}
      // A prod connection is worth spotting at a glance, before you run
      // anything — not only at the moment the write gate stops you.
      tone={connection.env === 'prod' ? 'warn' : 'normal'}
      mark={connection.env === 'prod' && !showEnv ? 'prod' : undefined}
      selected={selection?.kind === 'connection' && selection.id === connection.id}
      onClick={() => select({ kind: 'connection', id: connection.id })}
    />
  );
}

function Section({
  label,
  action,
  children,
}: {
  label: string;
  action?: { title: string; onClick: () => void };
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="py-2">
      <div className="flex items-center px-3 pb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
          {label}
        </span>
        <div className="flex-1" />
        {action && (
          <button
            onClick={action.onClick}
            title={action.title}
            aria-label={action.title}
            className="text-ink-faint hover:text-ink w-4 h-4 leading-none text-sm"
          >
            +
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function Row({
  label,
  detail,
  selected,
  tone = 'normal',
  onClick,
  onEdit,
  editTitle,
  onDelete,
  deleteTitle,
  mark,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  tone?: 'normal' | 'warn';
  mark?: string;
  onClick: () => void;
  onEdit?: () => void;
  editTitle?: string;
  onDelete?: () => void;
  deleteTitle?: string;
}): JSX.Element {
  // A div rather than a button: a delete control nested inside a button is
  // invalid HTML and behaves unpredictably when activated by keyboard.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={`group sidebar-row w-full text-left px-3 py-1.5 flex items-center gap-2 cursor-default ${
        selected ? 'sidebar-row-selected' : 'hover:bg-card'
      }`}
    >
      <span className="text-xs text-ink truncate">{label}</span>
      {mark && (
        <span className="shrink-0 text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-amber-500/10 text-amber-400/90 border border-amber-500/25">
          {mark}
        </span>
      )}
      <div className="flex-1" />
      {detail && (
        <span
          className={`text-[10px] shrink-0 ${
            tone === 'warn' ? 'text-amber-400' : 'text-ink-faint'
          }`}
        >
          {detail}
        </span>
      )}
      {onEdit && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          title={editTitle}
          aria-label={editTitle}
          className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-ink-faint opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-ink hover:bg-card"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M8.2 1.8a1.1 1.1 0 0 1 1.6 1.6L4.4 8.8l-2.2.6.6-2.2 5.4-5.4Z"
                  stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      {onDelete && (
        <button
          // Hidden until hover or keyboard focus, so the sidebar stays calm,
          // but never hidden from assistive tech.
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title={deleteTitle}
          aria-label={deleteTitle}
          className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-ink-faint opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-red-400 hover:bg-card"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="px-3 py-1 text-[11px] leading-snug text-ink-faint">{children}</p>;
}

