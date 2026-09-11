import { create } from 'zustand';
import type {
  AppSettings,
  AskTurn,
  Connection,
  ConnectionGroup,
  EnvKind,
  EnvSet,
  SchemaSnapshot,
  StoreSnapshot,
} from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import type { HistoryEntry, RunRecord, SavedQuery } from '@shared/history';
import {
  blankBinding,
  clearValue,
  forgetConnection,
  upsertBinding,
  withValue,
  type ParamBinding,
  type ParamScope,
  type ParamSlot,
} from '@shared/params';
import { buffersFor, nextBufferKey, ownsBuffer } from '@shared/buffers';
import { copyName } from '@shared/copyName';

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
  | { kind: 'newEnvSet' }
  | { kind: 'editEnvSet'; id: string }
  | { kind: 'pickTables'; connectionId: string };

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
  /// Editor text per buffer key, mirrored from disk. A connection has one
  /// tab by default and as many as you open — see src/shared/buffers.ts for
  /// how the keys are shaped.
  buffers: Record<string, string>;
  /// Which of a connection's tabs is in front, per connection id.
  activeBuffer: Record<string, string>;
  /// The schema each tab was last written against, per buffer key.
  ///
  /// The server has exactly one — `USE db` / `set search_path` is session
  /// state on the single connection every tab shares — so this is not a
  /// per-tab session. It is what the tab ASKS FOR when you switch to it,
  /// which is the useful half: a query written against acme_dm lands you
  /// back on acme_dm instead of running against whatever the last tab left
  /// the session on.
  bufferSchema: Record<string, string>;
  /// Ask threads per connection, loaded from disk and written back after
  /// every turn. They used to live inside the panel, which meant closing it
  /// threw the conversation away — and there was no way to look up what you
  /// asked yesterday.
  askThreads: Record<string, AskTurn[]>;
  /// Durable statement history, newest first. Owned by main — the renderer
  /// holds a copy for rendering and never folds a run into it itself, so
  /// two windows cannot each write a different array over the other.
  history: HistoryEntry[];
  savedQueries: SavedQuery[];
  activeSchema: Record<string, string>;
  /// Which connections are actually alive right now. Pushed from main —
  /// absent means "not connected", which is the common case.
  connState: Record<string, 'open' | 'closed' | 'error'>;
  /// Open transactions, pushed from main — including when the idle timeout
  /// rolls one back without anyone asking.
  txnState: Record<string, { open: boolean; statements: number; expiresAt: number | null }>;
  /// When the server last refused a write on this connection, so the
  /// read-only toggle can draw attention to itself. A timestamp rather than
  /// a boolean: the pulse has to be able to fire again for the same
  /// connection.
  writeBlockedAt: Record<string, number>;

  /// Remembered values for placeholders in pasted SQL, keyed by slot —
  /// see src/shared/params.ts. One library for the app; the per-environment
  /// and per-connection answers live inside each binding.
  params: ParamBinding[];

  sheet: Sheet | null;
  paletteOpen: boolean;
  toasts: Toast[];
  confirm: ConfirmRequest | null;

  hydrate(): Promise<void>;
  /// Set one slot's value in one layer — the default, this environment, or
  /// this connection. Creates the binding if the slot has never been
  /// filled in.
  setParamValue(
    slot: ParamSlot,
    text: string,
    scope: ParamScope,
    target: { connectionId?: string; env?: EnvKind },
  ): void;
  /// Change how a slot's text is read (auto, text, number, …).
  setParamType(slot: ParamSlot, type: ParamBinding['type']): void;
  /// Drop one override, falling back to the layer beneath it.
  clearParamValue(
    key: string,
    scope: ParamScope,
    target: { connectionId?: string; env?: EnvKind },
  ): void;
  /// Forget a slot entirely, overrides included.
  forgetParam(key: string): void;
  /// The one write path for the library — state and disk together, so no
  /// caller can update one without the other.
  writeParams(params: ParamBinding[]): void;
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
  /// Copy an existing connection into a new one. Nothing connects: a
  /// duplicate exists to be changed — a different database, a different
  /// host — and opening a second session against the place you are about to
  /// stop pointing at is work nobody asked for.
  ///
  /// `draft` lets the connection form hand over what is on screen, so
  /// duplicating from an open dialog copies what you have typed and leaves
  /// the original untouched. Omitted, the saved record is copied verbatim.
  /// Returns the new connection's id.
  duplicateConnection(
    id: string,
    draft?: Omit<Connection, 'id'>,
    password?: string | null,
  ): Promise<string | null>;
  importConnections(items: Array<Omit<Connection, 'id'> & { sourceId?: string }>): Promise<number>;
  updateConnection(
    id: string,
    patch: Partial<Connection>,
    password: { source: 'stored'; value: string } | { source: 'clear' } | null,
  ): Promise<{ ok: boolean; serverVersion?: string; error?: string }>;
  askConfirm(request: ConfirmRequest | null): void;
  /// Add one turn to a connection's Ask thread, and persist it.
  appendAskTurn(connectionId: string, turn: AskTurn): void;
  /// Forget a connection's thread, on the user's say-so only.
  clearAskThread(connectionId: string): void;
  /// Pin or unpin a table into this connection's AI context. Deliberately
  /// NOT updateConnection: that reconnects, and dropping the session to
  /// change what goes in a prompt would be an absurd price for a checkbox.
  togglePinnedTable(connectionId: string, qualified: string): void;
  /// Fold a schema out of the table explorer, or bring it back. Same reason
  /// as togglePinnedTable for not going through updateConnection: what you
  /// want to LOOK at is not worth dropping the session over.
  toggleHiddenSchema(connectionId: string, schema: string): void;
  /// Bring every hidden schema back at once — the way out of having hidden
  /// the one you actually needed.
  showAllSchemas(connectionId: string): void;

  /// Environment sets: the same logical database in several places. Created
  /// and edited here rather than by hand-editing a config file, which is
  /// what "the + button opens a placeholder" amounted to.
  setConnState(connectionId: string, state: 'open' | 'closed' | 'error'): void;
  /// Replace what the window believes about every connection with what main
  /// actually has open. Called once on mount: the pushes that built this up
  /// happened before this renderer existed.
  seedConnStates(openIds: string[]): void;
  flagWriteBlocked(connectionId: string): void;
  setTxnState(
    connectionId: string,
    txn: { open: boolean; statements: number; expiresAt: number | null },
  ): void;
  /// Returns the refusal, so the caller can show it where the user is
  /// looking rather than in a toast they may miss.
  setWrites(connectionId: string, enabled: boolean, confirm?: string): Promise<string | null>;
  setTxnMode(connectionId: string, mode: 'auto' | 'manual'): Promise<void>;
  endTransaction(connectionId: string, action: 'commit' | 'rollback'): Promise<void>;
  /// Pin either kind of thing — a connection or a set. Both land in the
  /// same section, because "what I am working with" is one list.
  togglePin(kind: 'connection' | 'envSet', id: string): Promise<void>;
  saveEnvSet(draft: {
    id?: string;
    name: string;
    memberIds: string[];
    baselineId: string;
    memberSchemas?: Record<string, string>;
  }): Promise<void>;
  removeEnvSet(id: string): Promise<void>;
  loadSchema(connectionId: string, opts?: { force?: boolean }): Promise<void>;
  /// Fold one completed run into the durable history. Main does the fold
  /// and hands back the result — see StoreSnapshot.history.
  recordRun(run: RunRecord): Promise<void>;
  clearHistory(): Promise<void>;
  /// Name a statement and keep it. Returns the saved query, so the caller
  /// can put the cursor in its name.
  saveQuery(query: Omit<SavedQuery, 'id' | 'createdAt' | 'updatedAt'>): Promise<SavedQuery>;
  updateSavedQuery(id: string, patch: Partial<Omit<SavedQuery, 'id' | 'createdAt'>>): Promise<void>;
  deleteSavedQuery(id: string): Promise<void>;
  loadSchemaList(connectionId: string): Promise<void>;
  setBuffer(key: string, text: string): void;
  /// Opens an empty tab on a connection and switches to it.
  /// Returns the new tab's key, so a caller can put something in it.
  newBuffer(connectionId: string): string;
  /// Closes one. The last tab is emptied rather than removed — a connection
  /// always has somewhere to type.
  closeBuffer(connectionId: string, key: string): void;
  selectBuffer(connectionId: string, key: string): void;
  applyBufferSchema(connectionId: string, key: string): void;
  persistBufferState(): void;
  switchSchema(connectionId: string, name: string): Promise<void>;
  syncSchema(connectionId: string): Promise<void>;
  toast(text: string, tone?: Toast['tone']): void;
  dismissToast(id: string): void;
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  connections: [],
  askThreads: {},
  history: [],
  savedQueries: [],
  groups: [],
  envSets: [],
  settings: { ...DEFAULT_SETTINGS },
  schemas: {},
  schemaLoading: {},
  schemaError: {},
  schemaList: {},
  buffers: {},
  activeBuffer: {},
  bufferSchema: {},
  activeSchema: {},
  connState: {},
  txnState: {},
  writeBlockedAt: {},
  selection: null,
  params: [],
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
      activeBuffer: snapshot.bufferState?.active ?? {},
      bufferSchema: snapshot.bufferState?.schema ?? {},
      askThreads: snapshot.askThreads ?? {},
      history: snapshot.history ?? [],
      savedQueries: snapshot.savedQueries ?? [],
      params: snapshot.params ?? [],
    });
  },

  setParamValue(slot, text, scope, target) {
    const existing = get().params.find((b) => b.key === slot.key);
    // The label is refreshed from the slot on every write, so a value first
    // saved from a `?` that was labelled by guesswork picks up the real
    // name the moment the same slot is seen spelled out as `:clientName`.
    const base: ParamBinding = existing
      ? { ...existing, label: slot.label }
      : blankBinding(slot);
    get().writeParams(upsertBinding(get().params, withValue(base, text, scope, target)));
  },

  setParamType(slot, type) {
    const existing = get().params.find((b) => b.key === slot.key) ?? blankBinding(slot);
    get().writeParams(upsertBinding(get().params, { ...existing, type }));
  },

  clearParamValue(key, scope, target) {
    const existing = get().params.find((b) => b.key === key);
    if (!existing) return;
    get().writeParams(upsertBinding(get().params, clearValue(existing, scope, target)));
  },

  forgetParam(key) {
    get().writeParams(get().params.filter((b) => b.key !== key));
  },

  writeParams(params: ParamBinding[]) {
    set({ params });
    void window.overdb.invoke('store:saveParams', params);
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

  async duplicateConnection(id, draft, password) {
    const source = get().connections.find((c) => c.id === id);
    if (!source) return null;

    const newId = crypto.randomUUID();
    const {
      id: _id,
      // Deliberately not carried over. A pin is about where YOU want this
      // row; a thread is a conversation about the original; and a copy has
      // never been opened, whatever its source's history says.
      pinned: _pinned,
      lastOpenedAt: _lastOpenedAt,
      secretRef: _secretRef,
      // Both are deliberate arms — writes off by default, and handing an
      // agent a connection is an act. Neither should arrive by having been
      // true on the row you copied.
      writesEnabled: _writesEnabled,
      mcpExposed: _mcpExposed,
      ...base
    } = { ...source, ...(draft ?? {}) } as Connection;

    // The password follows the connection, which is the whole point — but
    // it does so inside main. A typed one wins, exactly as it does on save.
    let secretRef: string | undefined;
    if (base.secretSource === 'stored') {
      if (password) {
        await window.overdb.invoke('conn:setSecret', { connectionId: newId, value: password });
        secretRef = newId;
      } else if (source.secretRef) {
        const copied = await window.overdb.invoke('conn:copySecret', {
          fromId: source.secretRef,
          toId: newId,
        });
        if (copied) secretRef = newId;
      }
    }

    const connection: Connection = {
      ...base,
      id: newId,
      name: copyName(base.name, get().connections.map((c) => c.name)),
      secretRef,
    };

    const connections = [...get().connections, connection];
    set({ connections });
    await window.overdb.invoke('store:saveConnections', connections);
    return newId;
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
    const bufferSchema = { ...get().bufferSchema };
    for (const key of Object.keys(buffers)) {
      if (ownsBuffer(id, key)) {
        delete buffers[key];
        delete bufferSchema[key];
      }
    }
    const activeBuffer = { ...get().activeBuffer };
    delete activeBuffer[id];
    set({ connections, groups, envSets, selection: cleared, buffers, bufferSchema, activeBuffer });
    // A placeholder value keyed to this connection goes with it. Nothing
    // could ever resolve it again, and it would be handed to the window on
    // every launch from now on.
    const params = forgetConnection(get().params, id);
    if (params.some((b, i) => b !== get().params[i])) get().writeParams(params);
    await Promise.all([
      window.overdb.invoke('store:saveConnections', connections),
      window.overdb.invoke('store:saveGroups', groups),
      window.overdb.invoke('store:saveEnvSets', envSets),
    ]);
    get().toast(`Removed ${conn?.name ?? 'connection'}.`);
  },

  togglePinnedTable(connectionId, qualified) {
    const connections = get().connections.map((c) => {
      if (c.id !== connectionId) return c;
      const have = c.pinnedTables ?? [];
      const next = have.includes(qualified)
        ? have.filter((t) => t !== qualified)
        : [...have, qualified];
      return { ...c, pinnedTables: next };
    });
    set({ connections });
    void window.overdb.invoke('store:saveConnections', connections);
  },

  async recordRun(run) {
    const history = await window.overdb.invoke('store:recordRun', run);
    set({ history });
  },

  async clearHistory() {
    await window.overdb.invoke('store:clearHistory');
    set({ history: [] });
  },

  async saveQuery(query) {
    const now = Date.now();
    const saved: SavedQuery = { ...query, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    const next = [saved, ...get().savedQueries];
    set({ savedQueries: next });
    await window.overdb.invoke('store:saveQueries', next);
    return saved;
  },

  async updateSavedQuery(id, patch) {
    const next = get().savedQueries.map((q) =>
      q.id === id ? { ...q, ...patch, updatedAt: Date.now() } : q,
    );
    set({ savedQueries: next });
    await window.overdb.invoke('store:saveQueries', next);
  },

  async deleteSavedQuery(id) {
    const next = get().savedQueries.filter((q) => q.id !== id);
    set({ savedQueries: next });
    await window.overdb.invoke('store:saveQueries', next);
  },

  toggleHiddenSchema(connectionId, schema) {
    const connections = get().connections.map((c) => {
      if (c.id !== connectionId) return c;
      const have = c.hiddenSchemas ?? [];
      const next = have.includes(schema)
        ? have.filter((s) => s !== schema)
        : [...have, schema];
      return { ...c, hiddenSchemas: next.length ? next : undefined };
    });
    set({ connections });
    void window.overdb.invoke('store:saveConnections', connections);
  },

  showAllSchemas(connectionId) {
    const connections = get().connections.map((c) =>
      c.id === connectionId ? { ...c, hiddenSchemas: undefined } : c,
    );
    set({ connections });
    void window.overdb.invoke('store:saveConnections', connections);
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

  setBuffer(key, text) {
    set((st) => ({ buffers: { ...st.buffers, [key]: text } }));
    void window.overdb.invoke('store:saveBuffer', { key, text });
  },

  newBuffer(connectionId) {
    const key = nextBufferKey(connectionId, get().buffers);
    // Written empty rather than left absent: the key IS the tab, so a tab
    // the map has never heard of does not exist and would vanish on the
    // next reload.
    //
    // It inherits the schema you are on. A new tab is almost always more of
    // the same work, and inheriting nothing would make the FIRST switch
    // away from it silently move the session.
    const inherited = get().activeSchema[connectionId];
    set((st) => ({
      buffers: { ...st.buffers, [key]: '' },
      activeBuffer: { ...st.activeBuffer, [connectionId]: key },
      bufferSchema: inherited ? { ...st.bufferSchema, [key]: inherited } : st.bufferSchema,
    }));
    void window.overdb.invoke('store:saveBuffer', { key, text: '' });
    get().persistBufferState();
    return key;
  },

  closeBuffer(connectionId, key) {
    const keys = buffersFor(connectionId, get().buffers);
    if (keys.length <= 1) {
      get().setBuffer(key, '');
      return;
    }
    // Land on the neighbour to the left, or the first tab when closing the
    // first — the same place your eye already is.
    const at = keys.indexOf(key);
    const nextActive = keys[at > 0 ? at - 1 : 1];
    const buffers = { ...get().buffers };
    delete buffers[key];
    const bufferSchema = { ...get().bufferSchema };
    delete bufferSchema[key];
    set((st) => ({
      buffers,
      bufferSchema,
      activeBuffer: { ...st.activeBuffer, [connectionId]: nextActive },
    }));
    void window.overdb.invoke('store:dropBuffer', { key });
    get().persistBufferState();
    get().applyBufferSchema(connectionId, nextActive);
  },

  selectBuffer(connectionId, key) {
    if (get().activeBuffer[connectionId] === key) return;
    set((st) => ({ activeBuffer: { ...st.activeBuffer, [connectionId]: key } }));
    get().persistBufferState();
    get().applyBufferSchema(connectionId, key);
  },

  /// Put the session on the schema this tab expects.
  ///
  /// Deliberately a no-op mid-transaction: the statements already in that
  /// transaction ran against the schema it started on, and moving the
  /// session out from under them to satisfy a tab switch is how you end up
  /// committing against tables you never looked at.
  applyBufferSchema(connectionId, key) {
    const want = get().bufferSchema[key];
    const now = get().activeSchema[connectionId];
    if (!want || want === now) return;
    if (get().txnState[connectionId]?.open) {
      get().toast(
        `This tab is on ${want}, but a transaction is open — the session stays on ${now}.`,
        'error',
      );
      return;
    }
    void get().switchSchema(connectionId, want);
  },

  persistBufferState() {
    void window.overdb.invoke('store:saveBufferState', {
      active: get().activeBuffer,
      schema: get().bufferSchema,
    });
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

      // Ask the SESSION what it resolves to, rather than inferring it from
      // the saved connection. Those two disagree the moment anything
      // reconnects, and the picker then displayed a schema the server had
      // never been switched to — so re-choosing that same entry fired no
      // change event and there was no way to fix it from the UI.
      const current = await window.overdb.invoke('conn:currentSchema', connectionId);
      const conn = get().connections.find((c) => c.id === connectionId);
      const resolved = current ?? conn?.database ?? conn?.defaultSchema ?? names[0];
      if (resolved) {
        set((st) => ({ activeSchema: { ...st.activeSchema, [connectionId]: resolved } }));
      }
      // The session came up on whatever the connection was saved with, but
      // the tab about to be in front may have been written against
      // something else — this is the restart case, where the whole point of
      // remembering a tab's schema is that you land back on it.
      const key = get().activeBuffer[connectionId];
      if (key) get().applyBufferSchema(connectionId, key);
    } catch {
      // Losing the list costs the picker, not the connection.
    }
  },

  /// Ask the server what the session is actually on and make the picker
  /// agree. Cheap (`select database()` / `current_schema()`), and it closes
  /// the whole class of divergence rather than one path into it — a `USE
  /// other_db;` typed as SQL moves the session with nothing to tell us.
  async syncSchema(connectionId) {
    try {
      const actual = await window.overdb.invoke('conn:currentSchema', connectionId);
      if (!actual) return;
      const before = get().activeSchema[connectionId];
      if (before === actual) return;
      set((st) => ({
        activeSchema: { ...st.activeSchema, [connectionId]: actual },
        // The catalog is per-schema, so a cached one from the old schema is
        // now describing the wrong database.
        schemas: { ...st.schemas, [connectionId]: undefined },
      }));
      if (before) get().toast(`Now on ${actual}.`);
      await get().loadSchema(connectionId, { force: true });
    } catch {
      // The picker keeps whatever it had; the error surfaces on the next
      // statement, where it means something.
    }
  },

  async switchSchema(connectionId, name) {
    // The host has to be up: `request` rejects outright when it isn't, and
    // that rejection used to be swallowed by the caller's `void`.
    if (!(await window.overdb.invoke('conn:isOpen', connectionId))) {
      const opened = await window.overdb.invoke('conn:open', connectionId);
      if (!opened.ok) {
        get().toast(opened.error ?? 'Could not connect.', 'error');
        return;
      }
    }

    let actual: string;
    try {
      actual = await window.overdb.invoke('conn:useSchema', { connectionId, name });
    } catch (err) {
      get().toast(
        `Could not switch to ${name}: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
      return;
    }

    // `actual` is read back from the server, so this reflects what queries
    // will actually run against — including the case where it isn't what
    // was asked for.
    // Recorded against the tab in front, so coming back to it puts the
    // session where you left it. `actual`, not `name` — remembering a schema
    // the server declined would re-ask for it on every switch.
    const key = get().activeBuffer[connectionId] ?? connectionId;
    set((st) => ({
      activeSchema: { ...st.activeSchema, [connectionId]: actual },
      bufferSchema: { ...st.bufferSchema, [key]: actual },
      // The catalog is per-schema, so the cached one is now wrong.
      schemas: { ...st.schemas, [connectionId]: undefined },
    }));
    get().persistBufferState();
    if (actual !== name) {
      get().toast(`Asked for ${name}, but the session is on ${actual}.`, 'error');
    }
    await get().loadSchema(connectionId, { force: true });
  },

  async importConnections(items) {
    const created: Connection[] = [];
    for (const item of items) {
      const { sourceId, ...draft } = item;
      const id = crypto.randomUUID();
      const connection: Connection = { ...draft, id };
      // The password never enters this process: main looks it up by sourceId
      // and writes it to the keychain directly. secretSource is set from
      // what actually got stored, not from what the sheet guessed earlier —
      // those can disagree if a re-scan cleared the main-side scanned map
      // between pick and apply.
      if (sourceId) {
        const res = await window.overdb.invoke('import:commit', { sourceId, connectionId: id });
        connection.secretSource = res.stored ? 'stored' : 'none';
        if (res.stored) connection.secretRef = id;
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

  setConnState(connectionId, state) {
    set((st) => ({ connState: { ...st.connState, [connectionId]: state } }));
  },

  seedConnStates(openIds) {
    // The seed goes UNDER what is already here, not over it: a push that
    // lands while the round trip is in flight is newer than the answer, and
    // a connection that closed during it must not come back green.
    const seeded: Record<string, 'open' | 'closed' | 'error'> = {};
    for (const id of openIds) seeded[id] = 'open';
    set((st) => ({ connState: { ...seeded, ...st.connState } }));
  },

  flagWriteBlocked(connectionId) {
    set((st) => ({ writeBlockedAt: { ...st.writeBlockedAt, [connectionId]: Date.now() } }));
  },

  setTxnState(connectionId, txn) {
    set((st) => ({ txnState: { ...st.txnState, [connectionId]: txn } }));
  },

  async setWrites(connectionId, enabled, confirm) {
    const res = await window.overdb.invoke('conn:setWrites', { connectionId, enabled, confirm });
    if (!res.ok) return res.error ?? 'Could not change this.';
    set((st) => ({
      connections: st.connections.map((c) =>
        c.id === connectionId ? { ...c, writesEnabled: enabled } : c,
      ),
    }));
    const name = get().connections.find((c) => c.id === connectionId)?.name ?? 'connection';
    get().toast(enabled ? `Writes enabled on ${name}.` : `${name} is read-only again.`);
    return null;
  },

  async setTxnMode(connectionId, mode) {
    await window.overdb.invoke('conn:setTxnMode', { connectionId, mode });
    set((st) => ({
      connections: st.connections.map((c) => (c.id === connectionId ? { ...c, txnMode: mode } : c)),
    }));
  },

  async endTransaction(connectionId, action) {
    const res = await window.overdb.invoke(
      action === 'commit' ? 'txn:commit' : 'txn:rollback',
      connectionId,
    );
    const statements = get().txnState[connectionId]?.statements ?? 0;
    set((st) => ({
      txnState: { ...st.txnState, [connectionId]: { open: false, statements: 0, expiresAt: null } },
    }));
    if (!res.ok) {
      get().toast(res.error ?? `Could not ${action}.`, 'error');
      return;
    }
    get().toast(
      action === 'commit'
        ? `Committed ${statements} statement${statements === 1 ? '' : 's'}.`
        : `Rolled back ${statements} statement${statements === 1 ? '' : 's'}. Nothing was changed.`,
    );
  },

  async togglePin(kind, id) {
    if (kind === 'connection') {
      const connections = get().connections.map((c) =>
        c.id === id ? { ...c, pinned: !c.pinned } : c,
      );
      set({ connections });
      await window.overdb.invoke('store:saveConnections', connections);
      return;
    }
    const envSets = get().envSets.map((e) => (e.id === id ? { ...e, pinned: !e.pinned } : e));
    set({ envSets });
    await window.overdb.invoke('store:saveEnvSets', envSets);
  },

  async saveEnvSet(draft) {
    const existing = draft.id ? get().envSets.find((e) => e.id === draft.id) : undefined;
    const envSet: EnvSet = {
      id: draft.id ?? crypto.randomUUID(),
      name: draft.name.trim(),
      memberIds: draft.memberIds,
      // The baseline is what everything else is diffed against, so it has
      // to be a member. Falling back to the first one keeps a set usable
      // rather than rejecting the save over a detail the user can fix.
      baselineId: draft.memberIds.includes(draft.baselineId)
        ? draft.baselineId
        : (draft.memberIds[0] ?? ''),
      // Only for members that are still in the set: a schema kept for a
      // connection that was removed comes back to life if that connection
      // is ever re-added, pointing at whatever it was months ago.
      memberSchemas: Object.fromEntries(
        Object.entries(draft.memberSchemas ?? existing?.memberSchemas ?? {}).filter(([id]) =>
          draft.memberIds.includes(id),
        ),
      ),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      archived: existing?.archived,
      pinnedSchema: existing?.pinnedSchema,
    };
    const envSets = existing
      ? get().envSets.map((e) => (e.id === envSet.id ? envSet : e))
      : [...get().envSets, envSet];
    set({ envSets });
    await window.overdb.invoke('store:saveEnvSets', envSets);
    get().toast(existing ? `Saved ${envSet.name}.` : `Created ${envSet.name}.`);
  },

  async removeEnvSet(id) {
    const gone = get().envSets.find((e) => e.id === id);
    const envSets = get().envSets.filter((e) => e.id !== id);
    const selection = get().selection;
    set({
      envSets,
      // Leaving a deleted set selected leaves the pane rendering nothing,
      // which reads as a crash.
      selection: selection?.kind === 'envSet' && selection.id === id ? null : selection,
    });
    await window.overdb.invoke('store:saveEnvSets', envSets);
    get().toast(`Deleted ${gone?.name ?? 'environment set'}.`);
  },

  askConfirm(confirm) {
    set({ confirm });
  },

  appendAskTurn(connectionId, turn) {
    const turns = [...(get().askThreads[connectionId] ?? []), turn];
    set((st) => ({ askThreads: { ...st.askThreads, [connectionId]: turns } }));
    void window.overdb.invoke('store:saveAskThread', { connectionId, turns });
  },

  clearAskThread(connectionId) {
    set((st) => ({ askThreads: { ...st.askThreads, [connectionId]: [] } }));
    void window.overdb.invoke('store:saveAskThread', { connectionId, turns: [] });
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
