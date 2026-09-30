import { useEffect, useState } from 'react';
import type { Connection } from '@shared/types';
import { useStore } from './store';
import { Dropdown } from './Menu';
import { Chevron, Clock, Lock, Sparkle } from './Icons';

/// The enable-writes gesture, shared by the header control and the panel
/// that appears when the server has just refused a write. One place, because
/// the prod confirmation is the part that must not be reimplemented slightly
/// differently in the second one.
export function useWriteToggle(conn: Connection): {
  writes: boolean;
  confirming: boolean;
  typed: string;
  error: string | null;
  setTyped(v: string): void;
  cancel(): void;
  begin(): void;
  enable(confirm?: string): Promise<void>;
  disable(): Promise<void>;
} {
  const setWrites = useStore((s) => s.setWrites);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Switching connection must not carry a half-typed prod confirmation with
  // it, or you would be one keystroke from arming the wrong server.
  useEffect(() => {
    setConfirming(false);
    setTyped('');
    setError(null);
  }, [conn.id]);

  const enable = async (confirm?: string) => {
    const problem = await setWrites(conn.id, true, confirm);
    if (problem) {
      setError(problem);
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setTyped('');
    setError(null);
  };

  return {
    writes: Boolean(conn.writesEnabled),
    confirming,
    typed,
    error,
    setTyped,
    cancel: () => {
      setConfirming(false);
      setTyped('');
      setError(null);
    },
    begin: () => setConfirming(true),
    enable,
    disable: async () => {
      await setWrites(conn.id, false);
    },
  };
}

/// The typed-name gate for a production connection. Rendered wherever the
/// gesture is offered.
export function ProdConfirm({
  conn,
  gate,
}: {
  conn: Connection;
  gate: ReturnType<typeof useWriteToggle>;
}): JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <input
        autoFocus
        value={gate.typed}
        onChange={(e) => gate.setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void gate.enable(gate.typed);
          if (e.key === 'Escape') gate.cancel();
        }}
        placeholder={`Type ${conn.name}`}
        className="field px-1.5 py-0.5 text-[10px] w-40"
      />
      <button
        onClick={() => void gate.enable(gate.typed)}
        disabled={gate.typed !== conn.name}
        className="text-[10px] px-1.5 py-0.5 rounded bg-warn/15 text-warn-strong border border-warn/30 disabled:opacity-40"
      >
        Enable
      </button>
      {gate.error && <span className="text-[10px] text-warn/90">{gate.error}</span>}
    </span>
  );
}

/// The header's answer to "can this hurt anything, and is anything pending".
///
/// One chip, always visible: read-only vs writable is the single most
/// consequential fact about the connection you are typing into. It opens a
/// panel for the settings behind it — writes, the transaction mode, which
/// tables the AI always sees — which are changed rarely and read constantly,
/// so the chip says them and the panel changes them.
///
/// An open transaction takes the chip's place outright. It is state you must
/// not have to remember you left behind, and the one moment the header's
/// most important job is Commit and Roll back.
export function ConnectionState({
  conn,
  pinnedCount,
  onPickTables,
}: {
  conn: Connection;
  pinnedCount: number;
  onPickTables(): void;
}): JSX.Element {
  const txn = useStore((s) => s.txnState[conn.id]);
  const setTxnMode = useStore((s) => s.setTxnMode);
  const endTransaction = useStore((s) => s.endTransaction);
  const blockedAt = useStore((s) => s.writeBlockedAt[conn.id]);
  const gate = useWriteToggle(conn);
  const [panel, setPanel] = useState(false);

  const mode = conn.txnMode ?? 'auto';
  const open = Boolean(txn?.open);

  // Pulse only for a few seconds after a refusal, and only while writes are
  // still off — once they are on, the chip has nothing left to say.
  const [pulsing, setPulsing] = useState(false);
  useEffect(() => {
    if (!blockedAt || conn.writesEnabled) return;
    setPulsing(true);
    const id = setTimeout(() => setPulsing(false), 3000);
    return () => clearTimeout(id);
  }, [blockedAt, conn.writesEnabled]);

  useEffect(() => setPanel(false), [conn.id]);

  if (open) return <OpenTransaction txn={txn} onEnd={(a) => void endTransaction(conn.id, a)} />;

  const toggleWrites = async () => {
    if (gate.writes) return void gate.disable();
    if (conn.env === 'prod') return gate.begin();
    await gate.enable();
  };

  return (
    <div className="relative">
      <button
        onClick={() => setPanel((v) => !v)}
        aria-expanded={panel}
        aria-haspopup="dialog"
        title={
          gate.writes
            ? `Writes are on; ${mode === 'auto' ? 'each write commits by itself' : 'writes wait in a transaction for you to commit'}.`
            : 'Read-only — the server refuses writes.'
        }
        className={`h-[26px] px-2.5 rounded-md flex items-center gap-1.5 text-[12px] border ${
          gate.writes
            ? `text-ink border-warn/40 ${panel ? 'bg-warn/15' : 'bg-warn/5 hover:bg-warn/10'}`
            : `text-ink-muted border-transparent ${panel ? 'bg-wash-strong text-ink' : 'hover:bg-wash-strong hover:text-ink'}`
        } ${pulsing ? 'animate-attention' : ''}`}
      >
        {gate.writes ? <span className="w-1.5 h-1.5 rounded-full bg-warn" /> : <Lock />}
        {gate.writes ? (
          <>
            Writes on <span className="text-ink-muted">· {mode === 'auto' ? 'auto-commit' : 'manual'}</span>
          </>
        ) : (
          'Read-only'
        )}
        <Chevron up={panel} className="w-2.5 h-2.5 text-ink-muted" />
      </button>

      <Dropdown
        open={panel}
        onClose={() => {
          setPanel(false);
          gate.cancel();
        }}
        label="Connection state"
        align="left"
        width={360}
        role="dialog"
      >
        <div className="flex flex-col gap-3.5 text-[12px] text-ink">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <div className="font-semibold">Writes</div>
              <p className="text-[11px] text-ink-muted mt-0.5 leading-relaxed">
                {gate.writes
                  ? `Statements may change data on ${conn.name}.`
                  : 'The server refuses anything that would change data.'}
                {conn.env === 'prod' && !gate.writes ? ' Turning them on asks you to type the connection’s name.' : ''}
              </p>
            </div>
            <button
              role="switch"
              aria-checked={gate.writes}
              aria-label="Writes"
              onClick={() => void toggleWrites()}
              className={`shrink-0 mt-0.5 w-9 h-5 rounded-full relative transition-colors ${gate.writes ? 'bg-warn' : 'bg-wash-strong border border-card'}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${gate.writes ? 'left-[18px]' : 'left-0.5'}`} />
            </button>
          </div>
          {gate.confirming && <ProdConfirm conn={conn} gate={gate} />}

          {gate.writes && (
            <div className="flex flex-col gap-1.5">
              <div className="font-semibold">Transactions</div>
              <div role="radiogroup" aria-label="Transactions" className="grid grid-cols-2 rounded-md border border-card overflow-hidden">
                {(
                  [
                    ['auto', 'Auto-commit', 'Each write commits by itself'],
                    ['manual', 'Manual', 'Look before you commit'],
                  ] as const
                ).map(([value, name, note], i) => (
                  <button
                    key={value}
                    role="radio"
                    aria-checked={mode === value}
                    onClick={() => void setTxnMode(conn.id, value)}
                    className={`px-2.5 py-2 text-left ${i ? 'border-l border-card' : ''} ${mode === value ? 'bg-accent/20' : 'hover:bg-wash-strong'}`}
                  >
                    <span className="block font-semibold">{name}</span>
                    <span className="block text-[10.5px] text-ink-muted mt-0.5">{note}</span>
                  </button>
                ))}
              </div>
              {mode === 'manual' && (
                <p className="text-[10.5px] text-ink-muted leading-relaxed">
                  An open transaction rolls itself back after 90 s idle, so it never sits on locks.
                </p>
              )}
            </div>
          )}

          <div className="h-px bg-rule" />
          <div className="flex items-center gap-2.5">
            <Sparkle />
            <div className="flex-1">
              {pinnedCount > 0 ? (
                <>AI always sees <b className="font-semibold">{pinnedCount} pinned table{pinnedCount === 1 ? '' : 's'}</b></>
              ) : (
                <span className="text-ink-muted">AI picks tables from your question</span>
              )}
            </div>
            <button
              onClick={() => {
                setPanel(false);
                onPickTables();
              }}
              className="text-[11px] text-accent hover:underline"
            >
              Choose…
            </button>
          </div>
        </div>
      </Dropdown>
    </div>
  );
}

/// A countdown rather than a static badge: the transaction rolls itself
/// back when it goes idle, and a number you can watch is the only honest
/// way to say so.
function OpenTransaction({
  txn,
  onEnd,
}: {
  txn?: { statements: number; expiresAt: number | null };
  onEnd(action: 'commit' | 'rollback'): void;
}): JSX.Element {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const left = txn?.expiresAt ? Math.max(0, Math.round((txn.expiresAt - Date.now()) / 1000)) : null;
  const n = txn?.statements ?? 0;

  return (
    <div role="status" className="h-7 flex items-center gap-2.5 pl-2.5 pr-1 rounded-md border border-warn/50 bg-warn/10 text-[12px]">
      <Clock className="w-[13px] h-[13px] text-warn" />
      <span>
        <b className="font-semibold">Transaction open</b>
        <span className="text-ink-muted"> · {n} statement{n === 1 ? '' : 's'}</span>
      </span>
      {left !== null && (
        <span
          className="font-mono text-[11px] text-warn-strong tabular-nums"
          title="An open transaction holds locks, so it rolls back on its own if left idle."
        >
          rolls back in {left} s
        </span>
      )}
      <button
        onClick={() => onEnd('rollback')}
        className="h-[22px] px-2.5 rounded border border-card bg-wash-strong text-[11px] text-ink hover:text-bad"
      >
        Roll back
      </button>
      <button
        onClick={() => onEnd('commit')}
        className="h-[22px] px-2.5 rounded bg-[rgb(4_113_82)] hover:bg-[rgb(6_95_70)] text-white text-[11px] font-semibold"
      >
        Commit
      </button>
    </div>
  );
}
