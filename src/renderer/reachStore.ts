import { create } from 'zustand';
import type { Connection } from '@shared/types';
import { diagnose } from '@shared/connectDiagnosis';

/// Can each connection be reached right now?
///
/// Asked once and shared, because several things on a set's screen want
/// the answer at the same time — the member list, the Run button, the
/// offline panel — and each asking for itself meant each opening its own
/// connection, and a timed-out VPN host costing its timeout three times.
///
/// Checked, never claimed: `up` means a connection opened or was already
/// open, not that one was configured once.

export interface Reach {
  status: 'checking' | 'up' | 'down';
  /// The driver's message, verbatim, when down.
  error?: string;
  /// When this was last settled, ms.
  at: number;
}

interface ReachState {
  reach: Record<string, Reach>;
  /// Ask again. A check already in flight for the same connection is
  /// joined, not repeated.
  check(id: string): Promise<void>;
  checkAll(ids: string[]): Promise<void>;
}

const inFlight = new Map<string, Promise<void>>();

export const useReach = create<ReachState>((set, get) => ({
  reach: {},

  check(id) {
    const running = inFlight.get(id);
    if (running) return running;
    const settle = (r: Omit<Reach, 'at'>) =>
      set((st) => ({ reach: { ...st.reach, [id]: { ...r, at: Date.now() } } }));
    // Keep a known answer on screen while it is asked again; "Checking…"
    // replacing "down" every twenty seconds would flicker for nothing.
    if (!get().reach[id]) settle({ status: 'checking' });
    const job = (async () => {
      try {
        if (await window.overdb.invoke('conn:isOpen', id)) {
          settle({ status: 'up' });
          return;
        }
        const res = await window.overdb.invoke('conn:open', id);
        settle(res.ok ? { status: 'up' } : { status: 'down', error: res.error ?? 'Could not connect.' });
      } catch (err) {
        settle({ status: 'down', error: err instanceof Error ? err.message : String(err) });
      } finally {
        inFlight.delete(id);
      }
    })();
    inFlight.set(id, job);
    return job;
  },

  async checkAll(ids) {
    await Promise.all(ids.map((id) => get().check(id)));
  },
}));

/// Why a connection is down, as a sentence about this machine rather than
/// a driver's message.
export function whyDown(connection: Connection, error: string): string {
  return diagnose({
    engine: connection.engine,
    error,
    host: connection.host,
    port: connection.port,
  }).cause;
}
