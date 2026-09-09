import { create } from 'zustand';
import type {
  AppSettings,
  Connection,
  ConnectionGroup,
  EnvSet,
  SchemaSnapshot,
  StoreSnapshot,
} from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';

/// Selectors that derive a list must never build a fresh array on every
/// call — zustand compares by reference, so `[]` inline re-renders the
/// subscriber forever. Return this instead.
const EMPTY: readonly never[] = [];
export function emptyList<T>(): readonly T[] {
  return EMPTY as readonly T[];
}

export type Sheet =
  | { kind: 'about' }
  | { kind: 'settings' }
  | { kind: 'newConnection' }
  | { kind: 'importConnections' }
  | { kind: 'editConnection'; id: string }
  | { kind: 'newEnvSet' };

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm(): void | Promise<void>;
}

export interface Toast {
  id: string;
  text: string;
  tone: 'info' | 'error';
}

interface State {
  ready: boolean;
  connections: Connection[];
  groups: ConnectionGroup[];
  envSets: EnvSet[];
  settings: AppSettings;

  /// Which connection or env set the main pane is showing. Exactly one is
  /// set; an env set selection is what turns a query into a fan-out.
  selection: { kind: 'connection'; id: string } | { kind: 'envSet'; id: string } | null;

  /// Introspected catalog per connection. Drives editor completion and the
  /// schema tree; fetched once per connection and reused.
  schemas: Record<string, SchemaSnapshot | undefined>;
  schemaLoading: Record<string, boolean>;
  /// Why the catalog could not be read, per connection. Silently swallowing
  /// this made a broken schema look exactly like a working one with no
  /// completions.
  schemaError: Record<string, string | undefined>;
  /// Every schema/database the connection could switch to, and which one is
  /// currently active.
  schemaList: Record<string, string[]>;
  /// Editor text per connection, mirrored from disk.
  buffers: Record<string, string>;
  activeSchema: Record<string, string>;

  sheet: Sheet | null;
  paletteOpen: boolean;
  toasts: Toast[];
  confirm: ConfirmRequest | null;

  hydrate(): Promise<void>;
  setSheet(sheet: Sheet | null): void;
  setPaletteOpen(open: boolean): void;
  select(selection: State['selection']): void;
  toggleSidebar(): void;
  saveSettings(patch: Partial<AppSettings>): void;
  addConnection(
    draft: Omit<Connection, 'id'>,
    password: string | null,
  ): Promise<{ ok: boolean; serverVersion?: string; error?: string }>;
  removeConnection(id: string): Promise<void>;
  importConnections(
    items: Array<Omit<Connection, 'id'> & { password?: string }>,
  ): Promise<number>;
  updateConnection(
    id: string,
    patch: Partial<Connection>,
    password: { source: 'stored'; value: string } | { source: 'clear' } | null,
  ): Promise<{ ok: boolean; serverVersion?: string; error?: string }>;
  askConfirm(request: ConfirmRequest | null): void;
  loadSchema(connectionId: string, opts?: { force?: boolean }): Promise<void>;
  loadSchemaList(connectionId: string): Promise<void>;
  setBuffer(connectionId: string, text: string): void;
  switchSchema(connectionId: string, name: string): Promise<void>;
  toast(text: string, tone?: Toast['tone']): void;
  dismissToast(id: string): void;
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  connections: [],
  groups: [],
  envSets: [],
  settings: { ...DEFAULT_SETTINGS },
  schemas: {},
  schemaLoading: {},
  schemaError: {},
  schemaList: {},
  buffers: {},
  activeSchema: {},
  selection: null,
  sheet: null,
  paletteOpen: false,
  toasts: [],
  confirm: null,

  async hydrate() {
    const snapshot: StoreSnapshot = await window.overdb.invoke('store:load');
    set({
      ready: true,
      connections: snapshot.connections,
      groups: snapshot.groups,
      envSets: snapshot.envSets,
      settings: { ...DEFAULT_SETTINGS, ...snapshot.settings },
      buffers: snapshot.buffers ?? {},
    });
  },

  setSheet(sheet) {
    set({ sheet });
  },

  setPaletteOpen(paletteOpen) {
    set({ paletteOpen });
  },

  select(selection) {
    set({ selection });
  },

  toggleSidebar() {
    get().saveSettings({ sidebarVisible: !get().settings.sidebarVisible });
  },

  saveSettings(patch) {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    // Main debounces the disk write, so a resize drag firing this on
    // every mousemove costs one trailing write rather than dozens.
    void window.overdb.invoke('store:saveSettings', settings);
  },

  async addConnection(draft, password) {
    const id = crypto.randomUUID();
    const connection: Connection = { ...draft, id, lastOpenedAt: new Date().toISOString() };

    // The secret is written under the connection's id and never read back
    // here — the renderer's relationship to credentials is write-only.
    if (password) {
      await window.overdb.invoke('conn:setSecret', { connectionId: id, value: password });
      connection.secretRef = id;
    }

    const connections = [...get().connections, connection];
    set({ connections });
    await window.overdb.invoke('store:saveConnections', connections);

    // Connect immediately: an "added" connection that turns out to be
    // unreachable is worse than an error at the moment you typed it.
    const opened = await window.overdb.invoke('conn:open', id);
    if (opened.ok) set({ selection: { kind: 'connection', id } });
    return opened;
  },

  async removeConnection(id) {
    const conn = get().connections.find((c) => c.id === id);

    // Closes the live host and drops the stored credential. Done before the
    // record goes away, because afterwards there is nothing left to name it.
    await window.overdb.invoke('conn:deleteSecret', id);

    const connections = get().connections.filter((c) => c.id !== id);
    // A deleted connection must not linger as a dangling member id in a
    // group or env set — that would leave a set claiming three members and
    // showing two.
    const groups = get().groups.map((g) => ({
      ...g,
      connectionIds: g.connectionIds.filter((cid) => cid !== id),
    }));
    const envSets = get().envSets
      .map((e) => ({ ...e, memberIds: e.memberIds.filter((mid) => mid !== id) }))
      // An env set whose baseline is gone has nothing to diff against, and
      // one with no members has nothing to run. Both are dropped rather than
      // left in a state the UI would have to apologise for.
      .filter((e) => e.memberIds.length > 0 && e.memberIds.includes(e.baselineId));

    const selection = get().selection;
    const cleared =
      selection && 'id' in selection && selection.id === id ? null : selection;

    const buffers = { ...get().buffers };
    delete buffers[id];
    set({ connections, groups, envSets, selection: cleared, buffers });
    await Promise.all([
      window.overdb.invoke('store:saveConnections', connections),
      window.overdb.invoke('store:saveGroups', groups),
      window.overdb.invoke('store:saveEnvSets', envSets),
    ]);
    get().toast(`Removed ${conn?.name ?? 'connection'}.`);
  },

  async updateConnection(id, patch, password) {
    if (password?.source === 'stored') {
      await window.overdb.invoke('conn:setSecret', { connectionId: id, value: password.value });
    } else if (password?.source === 'clear') {
      await window.overdb.invoke('conn:deleteSecret', id);
    }

    const connections = get().connections.map((c) => (c.id === id ? { ...c, ...patch } : c));
    set({ connections });
    await window.overdb.invoke('store:saveConnections', connections);

    // Settings only take effect on a fresh handshake, so reconnect rather
    // than leaving the old session running under the new label.
    await window.overdb.invoke('conn:close', id);
    set((st) => ({ schemas: { ...st.schemas, [id]: undefined } }));
    return window.overdb.invoke('conn:open', id);
  },

  async loadSchema(connectionId, opts = {}) {
    if (!opts.force && (get().schemas[connectionId] || get().schemaLoading[connectionId])) return;
    set((st) => ({ schemaLoading: { ...st.schemaLoading, [connectionId]: true } }));
    try {
      if (!(await window.overdb.invoke('conn:isOpen', connectionId))) {
        const opened = await window.overdb.invoke('conn:open', connectionId);
        if (!opened.ok) throw new Error(opened.error ?? 'Could not connect.');
      }
      const snapshot = await window.overdb.invoke('conn:introspect', { connectionId });

      // Then the cheap part: names of every table in every visible schema,
      // one catalog query. Without this, `other_db.<tab>` has nothing behind
      // it and CodeMirror falls back to offering SQL keywords, which looks
      // like the feature is broken.
      let merged = snapshot;
      try {
        const index = await window.overdb.invoke('conn:listTables', connectionId);
        const loaded = new Set(snapshot.schemas.map((sc) => sc.name));
        const extra = new Map<string, typeof snapshot.schemas[number]>();
        for (const entry of index) {
          if (loaded.has(entry.schema)) continue;
          let sc = extra.get(entry.schema);
          if (!sc) {
            sc = { name: entry.schema, tables: [] };
            extra.set(entry.schema, sc);
          }
          // Columns are deliberately absent — they arrive if and when the
          // user actually opens that schema. Table names alone are what
          // make qualified completion work.
          sc.tables.push({
            name: entry.table, kind: entry.kind, columns: [],
            primaryKey: [], indexes: [], foreignKeys: [],
          });
        }
        merged = { ...snapshot, schemas: [...snapshot.schemas, ...extra.values()] };
      } catch {
        // No index just means no cross-schema completion.
      }
      set((st) => ({
        schemas: { ...st.schemas, [connectionId]: merged },
        schemaError: { ...st.schemaError, [connectionId]: undefined },
      }));
    } catch (err) {
      // A catalog we can't read costs completion, not the connection — so
      // querying keeps working, but the failure is now visible rather than
      // presenting as "completion just doesn't work here".
      set((st) => ({
        schemaError: {
          ...st.schemaError,
          [connectionId]: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      set((st) => ({ schemaLoading: { ...st.schemaLoading, [connectionId]: false } }));
    }
  },

  setBuffer(connectionId, text) {
    set((st) => ({ buffers: { ...st.buffers, [connectionId]: text } }));
    void window.overdb.invoke('store:saveBuffer', { connectionId, text });
  },

  async loadSchemaList(connectionId) {
    try {
      // listSchemas talks to the connection host, so the connection has to
      // be up first. Previously this raced the open, failed with
      // "connection is not open", and the swallowed error left the picker
      // rendering nothing at all.
      if (!(await window.overdb.invoke('conn:isOpen', connectionId))) {
        const opened = await window.overdb.invoke('conn:open', connectionId);
        if (!opened.ok) return;
      }
      const names = await window.overdb.invoke('conn:listSchemas', connectionId);
      set((st) => ({ schemaList: { ...st.schemaList, [connectionId]: names } }));
      if (!get().activeSchema[connectionId]) {
        const conn = get().connections.find((c) => c.id === connectionId);
        const current = conn?.database ?? conn?.defaultSchema ?? names[0];
        if (current) {
          set((st) => ({ activeSchema: { ...st.activeSchema, [connectionId]: current } }));
        }
      }
    } catch {
      // Losing the list costs the picker, not the connection.
    }
  },

  async switchSchema(connectionId, name) {
    await window.overdb.invoke('conn:useSchema', { connectionId, name });
    set((st) => ({
      activeSchema: { ...st.activeSchema, [connectionId]: name },
      // The catalog is per-schema, so the cached one is now wrong.
      schemas: { ...st.schemas, [connectionId]: undefined },
    }));
    await get().loadSchema(connectionId, { force: true });
  },

  async importConnections(items) {
    const created: Connection[] = [];
    for (const item of items) {
      const { password, ...draft } = item;
      const id = crypto.randomUUID();
      const connection: Connection = { ...draft, id };
      // Only sources that legitimately carry a password set one; it goes
      // straight into the OS keychain, same as one you typed.
      if (password) {
        await window.overdb.invoke('conn:setSecret', { connectionId: id, value: password });
        connection.secretRef = id;
        connection.secretSource = 'stored';
      }
      created.push(connection);
    }
    const connections = [...get().connections, ...created];
    set({ connections });
    await window.overdb.invoke('store:saveConnections', connections);
    // Deliberately does NOT connect: importing twenty connections should not
    // open twenty sockets, and several will need a password first.
    get().toast(`Imported ${created.length} connection${created.length === 1 ? '' : 's'}.`);
    return created.length;
  },

  askConfirm(confirm) {
    set({ confirm });
  },

  toast(text, tone = 'info') {
    const id = Math.random().toString(36).slice(2);
    set({ toasts: [...get().toasts, { id, text, tone }] });
    setTimeout(() => get().dismissToast(id), 4000);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));
