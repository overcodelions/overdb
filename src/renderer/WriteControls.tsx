import { useEffect, useState } from 'react';
import type { Connection } from '@shared/types';
import { useStore } from './store';

/// The header's answer to "can this hurt anything, and is anything pending".
///
/// Deliberately always visible rather than tucked in a menu: read-only vs
/// writable is the single most consequential fact about the connection you
/// are typing into, and an open transaction is state you must not have to
/// remember you left behind.
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

export function WriteControls({ conn }: { conn: Connection }): JSX.Element {
  const txn = useStore((s) => s.txnState[conn.id]);
  const setTxnMode = useStore((s) => s.setTxnMode);
  const endTransaction = useStore((s) => s.endTransaction);
  const toast = useStore((s) => s.toast);
  const blockedAt = useStore((s) => s.writeBlockedAt[conn.id]);
  const gate = useWriteToggle(conn);

  const mode = conn.txnMode ?? 'auto';
  const open = Boolean(txn?.open);

  // Pulse only for a few seconds after a refusal, and only while writes are
  // still off — once they are on, the control has nothing left to say.
  const [pulsing, setPulsing] = useState(false);
  useEffect(() => {
    if (!blockedAt || conn.writesEnabled) return;
    setPulsing(true);
    const id = setTimeout(() => setPulsing(false), 3000);
    return () => clearTimeout(id);
  }, [blockedAt, conn.writesEnabled]);

  const toggle = async () => {
    if (gate.writes) {
      if (open) {
        toast('Commit or roll back the open transaction first.', 'error');
        return;
      }
      await gate.disable();
      return;
    }
    if (conn.env === 'prod') {
      gate.begin();
      return;
    }
    await gate.enable();
  };

  return (
    <>
      <button
        onClick={() => void toggle()}
        title={
          gate.writes
            ? 'Writes are enabled on this connection. Click to make it read-only again.'
            : 'This connection is read-only — the server refuses writes. Click to enable them.'
        }
        className={`text-[10px] px-1.5 py-0.5 rounded border ${
          gate.writes
            ? 'bg-warn/10 text-warn/90 border-warn/25'
            : 'bg-card border-card text-ink-faint hover:text-ink'
        } ${pulsing ? 'animate-attention' : ''}`}
      >
        {gate.writes ? 'writes on' : 'read-only'}
      </button>

      {gate.writes && (
        <select
          value={mode}
          onChange={(e) => void setTxnMode(conn.id, e.target.value as 'auto' | 'manual')}
          disabled={open}
          title={
            open
              ? 'Finish the open transaction before changing this.'
              : 'Auto-commit closes each write on its own. Manual holds one transaction open so you can check before committing.'
          }
          className="field px-1.5 py-0.5 text-[10px] disabled:opacity-50"
        >
          <option value="auto">auto-commit</option>
          <option value="manual">manual</option>
        </select>
      )}

      {open && <OpenTransaction txn={txn} onEnd={(a) => void endTransaction(conn.id, a)} />}

      {gate.confirming && <ProdConfirm conn={conn} gate={gate} />}
    </>
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
    <span className="flex items-center gap-1.5 px-1.5 py-0.5 rounded border border-accent/40 bg-accent/10">
      <span className="w-1.5 h-1.5 rounded-full bg-accent" />
      <span className="text-[10px] text-ink">
        {n} statement{n === 1 ? '' : 's'} uncommitted
      </span>
      {left !== null && (
        <span
          className="text-[10px] text-ink-faint tabular-nums"
          title="An open transaction holds locks, so it rolls back on its own if left idle."
        >
          {left}s
        </span>
      )}
      <button
        onClick={() => onEnd('commit')}
        className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-white hover:bg-accent-strong"
      >
        Commit
      </button>
      <button
        onClick={() => onEnd('rollback')}
        className="text-[10px] px-1.5 py-0.5 rounded border border-card text-ink-muted hover:text-bad"
      >
        Roll back
      </button>
    </span>
  );
}
