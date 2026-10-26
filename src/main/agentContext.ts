// What agents are told about a connection's database, worked out from what
// overdb already has — see src/shared/agentContext.ts for the rules.
//
// Shared by the app (the "What agents are told" panel) and `overdb serve
// --mcp` (the server instructions and describe_database), so both read the
// same setting, recipe and map.

import fs from 'node:fs/promises';

import { Store } from './store';
import { loadMap } from './mapper';
import { mapFileFor, recipePath } from './connectionFiles';
import { parseRecipe } from '../shared/baseline';
import { repoLinkOwner } from '../shared/overcliHandoff';
import {
  changedSince,
  detectTenant,
  tenantVia,
  resolveAgentContext,
  type AgentContext,
  type AgentContextSetting,
  type TenantRef,
} from '../shared/agentContext';
import type { DbMap } from '../shared/dbMap';
import type { SchemaSnapshot } from '../shared/types';

/// Where the setting lives for this connection, and what it says.
export function agentSettingFor(connectionId: string): {
  owner: { kind: 'envSet' | 'connection'; id: string; name: string } | null;
  setting: AgentContextSetting | undefined;
} {
  const st = Store.load();
  const owner = repoLinkOwner(connectionId, st.connections, st.envSets);
  if (!owner) return { owner: null, setting: undefined };
  const setting =
    owner.kind === 'envSet'
      ? st.envSets.find((e) => e.id === owner.id)?.agentContext
      : st.connections.find((c) => c.id === owner.id)?.agentContext;
  return { owner, setting };
}

/// The base recipe's tenant: undefined with no recipe, null for a recipe
/// made without one.
async function recipeTenant(connectionId: string): Promise<TenantRef | null | undefined> {
  const raw = await fs.readFile(await recipePath(connectionId), 'utf-8').catch(() => null);
  if (raw === null) return undefined;
  const parsed = parseRecipe(raw);
  return 'error' in parsed ? undefined : parsed.tenant;
}

/// `snapshot`, when there is one to hand, lets a tenant be detected and the
/// map be checked against the live catalog. Without it, only what is on
/// disk is used — no connection is opened here.
export async function agentContextFor(
  connectionId: string,
  snapshot?: SchemaSnapshot,
): Promise<{ ctx: AgentContext; map: DbMap | null }> {
  const { setting } = agentSettingFor(connectionId);
  const fromRecipe = await recipeTenant(connectionId);
  const where = await mapFileFor(connectionId);
  const map = where ? await loadMap(where.file) : null;
  const detected = !setting?.tenant && fromRecipe === undefined && snapshot ? detectTenant(snapshot) : null;
  const ctx = resolveAgentContext({
    setting,
    recipeTenant: fromRecipe,
    detected,
    map,
    changed: map && snapshot ? changedSince(map, snapshot) : [],
    ...(snapshot ? { via: (t: TenantRef) => tenantVia(snapshot, t) } : {}),
  });
  return { ctx, map };
}

function clean(setting: AgentContextSetting): AgentContextSetting | undefined {
  const out: AgentContextSetting = {};
  const t = setting.tenant;
  if (t === 'none') out.tenant = 'none';
  else if (t && t.schema?.trim() && t.table?.trim() && t.column?.trim()) {
    out.tenant = { schema: t.schema.trim(), table: t.table.trim(), column: t.column.trim() };
  }
  if (setting.notes?.trim()) out.notes = setting.notes.trim().slice(0, 4000);
  if (setting.map === false) out.map = false;
  return Object.keys(out).length ? out : undefined;
}

/// Saved where repo links are: the env set when the connection is in one.
/// An empty setting is removed, which puts everything back to automatic.
export function saveAgentSetting(connectionId: string, setting: AgentContextSetting): { ok: true } | { ok: false; error: string } {
  const st = Store.load();
  const owner = repoLinkOwner(connectionId, st.connections, st.envSets);
  if (!owner) return { ok: false, error: 'No such connection.' };
  const value = clean(setting);
  if (owner.kind === 'envSet') {
    Store.saveEnvSets(st.envSets.map((e) => (e.id === owner.id ? { ...e, agentContext: value } : e)));
  } else {
    Store.saveConnections(st.connections.map((c) => (c.id === owner.id ? { ...c, agentContext: value } : c)));
  }
  return { ok: true };
}
