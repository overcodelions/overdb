// A connection as a hosted overdb MCP server holds it — the file overgo
// keeps, and `node dist/mcp/headless.js --connections FILE` reads.
//
// It carries where the database is and how to sign in, never a secret.
// The credential is a reference the SERVER resolves: its own AWS role
// (IAM auth), or the name of an environment variable an admin sets there.
// Everything that only means something on the laptop it was made on —
// the keychain entry, a 1Password path, a credential command, an SSH
// tunnel, certificate paths, an AWS profile — is not carried, because on a
// shared server it would be either meaningless or dangerous: a saved
// credential command would run there, as the server.
//
// `toHosted` builds the record field by field from an allowlist rather
// than copying a connection and deleting keys. A field added to
// `Connection` later is therefore left behind until someone decides it
// belongs here, which is the right default for a file that leaves the
// machine.

import type { Connection, EnvKind, SslMode } from './types';
import type { Engine, Variant } from './engines';
import { isLoopback } from './seedGate';
import { cleanCaveats, resolveAgentContext, type AgentContext, type TenancyCaveats, type TenantRef } from './agentContext';
import type { DbMap, MapLink, MapTable } from './dbMap';

export const HOSTED_FILE_VERSION = 1;

export type HostedEngine = Extract<Engine, 'postgres' | 'mysql' | 'dynamodb'>;
const HOSTED_ENGINES: readonly HostedEngine[] = ['postgres', 'mysql', 'dynamodb'];
const ENV_KINDS: readonly EnvKind[] = ['local', 'dev', 'sandbox', 'staging', 'prod', 'other'];
const SSL_MODES: readonly SslMode[] = ['disable', 'require', 'verify-ca', 'verify-full'];
const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*$/;

export type HostedCredential =
  /// No password: DynamoDB (the server's AWS role), or a trust/peer setup.
  | { source: 'none' }
  /// An RDS or Redshift IAM token, signed with the server's own AWS role.
  | { source: 'aws-iam' }
  /// A password in this environment variable on the server.
  | { source: 'secret'; env: string };

export interface HostedConnection {
  id: string;
  name: string;
  env: EnvKind;
  engine: HostedEngine;
  variant?: Variant;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  ssl?: SslMode;
  /// A CA bundle path ON THE SERVER. Never copied from a laptop.
  sslRootCert?: string;
  defaultSchema?: string;
  tableFilter?: string;
  region?: string;
  credential: HostedCredential;
  /// What agents are told about this database (src/shared/agentContext.ts),
  /// as it stood when published.
  context?: HostedContext;
}

/// The map as a server needs it: what the code says, with nothing about
/// the machine it was made on — repo paths become repo names.
export interface HostedMap {
  builtAt: string;
  schemas: Record<string, string>;
  tables: Record<string, MapTable>;
  links: MapLink[];
}

export interface HostedContext {
  /// `via`: the columns queries filter on, worked out where the catalog was.
  tenant?: TenantRef & { via: string[]; caveats?: TenancyCaveats };
  noTenant?: true;
  notes?: string;
  map?: HostedMap;
}

export interface HostedFile {
  version: typeof HOSTED_FILE_VERSION;
  connections: HostedConnection[];
}

/// The variable a connection's password is expected in, when it has to be
/// one: `shop-staging` → `OVERDB_SHOP_STAGING_PASSWORD`.
export function secretEnvName(name: string): string {
  const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `OVERDB_${slug || 'CONNECTION'}_PASSWORD`;
}

/// Who besides you can read this connection, for the agent mark: agents on
/// this machine (`overdb serve --mcp`), the org's server, both, or nobody.
export function agentReach(conn: { mcpExposed?: boolean; orgPublishedAt?: string }): string | null {
  const parts = [
    conn.mcpExposed ? 'agents on this machine can read it (overdb serve --mcp)' : null,
    conn.orgPublishedAt ? `sent to your org’s server for hosted agents on ${conn.orgPublishedAt.slice(0, 10)}` : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  const text = parts.join('; and ');
  return `Read-only for agents: ${text}.`;
}

/// What agents are told, ready to travel: only what a person decided (a
/// setting or a base recipe) — never a mere suggestion — and the map only
/// when it is included.
export function hostedContext(ctx: AgentContext, map: DbMap | null): HostedContext | undefined {
  const out: HostedContext = {};
  if (ctx.tenant) {
    const caveats = cleanCaveats(ctx.tenant.caveats);
    out.tenant = { schema: ctx.tenant.schema, table: ctx.tenant.table, column: ctx.tenant.column, via: ctx.tenant.via, ...(caveats ? { caveats } : {}) };
  }
  else if (ctx.noTenant) out.noTenant = true;
  if (ctx.notes) out.notes = ctx.notes;
  if (map && ctx.map.included) {
    out.map = {
      builtAt: map.builtAt,
      schemas: map.schemas,
      tables: Object.fromEntries(
        Object.entries(map.tables).map(([k, t]) => [k, { ...t, ...(t.repo ? { repo: t.repo.split(/[\\/]/).filter(Boolean).pop() } : {}) }]),
      ),
      links: map.links,
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/// The context a hosted server tells its agents, from the published record.
/// `changed`: schemas the server's own catalog shows have moved on.
export function hostedAgentContext(hc: HostedContext | undefined, changed: string[] = []): { ctx: AgentContext; map: DbMap | null } {
  const map: DbMap | null = hc?.map
    ? {
        version: 1,
        owner: { kind: 'connection', id: 'hosted', name: 'hosted' },
        builtAt: hc.map.builtAt,
        updatedAt: hc.map.builtAt,
        repos: [],
        schemas: hc.map.schemas,
        tables: hc.map.tables,
        links: hc.map.links,
      }
    : null;
  const ctx = resolveAgentContext({
    setting: {
      ...(hc?.tenant ? { tenant: { schema: hc.tenant.schema, table: hc.tenant.table, column: hc.tenant.column } } : hc?.noTenant ? { tenant: 'none' as const } : {}),
      ...(hc?.tenant?.caveats ? { caveats: hc.tenant.caveats } : {}),
      ...(hc?.notes ? { notes: hc.notes } : {}),
    },
    map,
    changed,
    via: () => hc?.tenant?.via ?? [],
  });
  return { ctx, map };
}

const MAX_MAP_TABLES = 5000;
const MAX_MAP_LINKS = 20000;
const text = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length <= max;
const ref = (o: Record<string, unknown>) => (text(o.ref, 500) ? { ref: o.ref } : {});

/// A context read back from a file or a push, rebuilt from what checks out:
/// a malformed part is dropped rather than refusing the connection.
export function parseHostedContext(raw: unknown): HostedContext | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: HostedContext = {};
  const t = r.tenant as Record<string, unknown> | undefined;
  if (t && text(t.schema, 200) && text(t.table, 200) && text(t.column, 200)) {
    const via = Array.isArray(t.via) ? t.via.filter((v): v is string => text(v, 200)).slice(0, 5) : [];
    const caveats = cleanCaveats(t.caveats);
    out.tenant = { schema: t.schema, table: t.table, column: t.column, via, ...(caveats ? { caveats } : {}) };
  } else if (r.noTenant === true) out.noTenant = true;
  if (text(r.notes, 4000) && r.notes.trim()) out.notes = r.notes;
  const m = r.map as Record<string, unknown> | undefined;
  if (m && text(m.builtAt, 100) && m.tables && typeof m.tables === 'object') {
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
    const tables: Record<string, MapTable> = {};
    for (const [k, v] of Object.entries(m.tables as Record<string, unknown>).slice(0, MAX_MAP_TABLES)) {
      const o = v as Record<string, unknown>;
      if (!o || typeof o !== 'object' || !text(o.purpose)) continue;
      tables[k] = {
        purpose: o.purpose,
        ...(text(o.repo, 200) ? { repo: o.repo } : {}),
        ...(text(o.module, 200) ? { module: o.module } : {}),
        values: arr(o.values).filter((x) => text(x.column, 200) && Array.isArray(x.values)).map((x) => ({ column: x.column as string, values: (x.values as unknown[]).filter((v): v is string => text(v, 200)).slice(0, 100), ...ref(x) })),
        json: arr(o.json).filter((x) => text(x.column, 200) && text(x.shape)).map((x) => ({ column: x.column as string, shape: x.shape as string, ...ref(x) })),
        rules: arr(o.rules).filter((x) => text(x.text)).map((x) => ({ text: x.text as string, ...ref(x) })),
      };
    }
    const schemas = Object.fromEntries(Object.entries((m.schemas as Record<string, unknown>) ?? {}).filter((e): e is [string, string] => text(e[1], 200)));
    const links = arr(m.links).filter((x) => text(x.from, 300) && text(x.to, 300) && text(x.why)).slice(0, MAX_MAP_LINKS).map((x) => ({ from: x.from as string, to: x.to as string, why: x.why as string, ...ref(x) }));
    out.map = { builtAt: m.builtAt, schemas, tables, links };
  }
  return Object.keys(out).length ? out : undefined;
}

export type ToHostedResult = { ok: true; value: HostedConnection } | { ok: false; error: string };

/// A connection made on this machine, as a server could use it — or why it
/// cannot be. `user` replaces the connection's own login: a shared server
/// should sign in as a read-only user made for it, not as you. `host` is
/// where the SERVER reaches the database, when that is not where this
/// machine does: `host.docker.internal` for a container on this Mac, the
/// real endpoint for a database this machine reaches by a VPN-only name.
export function toHosted(conn: Connection, opts: { user?: string; host?: string } = {}): ToHostedResult {
  const host = opts.host?.trim() || conn.host;
  if (!(HOSTED_ENGINES as readonly string[]).includes(conn.engine)) {
    return { ok: false, error: `${conn.name} is a ${conn.engine} database on this machine; a server can't reach it.` };
  }
  if (conn.branchOf) {
    return { ok: false, error: `${conn.name} is a branch on this machine; a server can't reach it.` };
  }
  if (conn.engine !== 'dynamodb' && isLoopback(host)) {
    return {
      ok: false,
      error: `${host || conn.name} is this machine, which a server elsewhere can't reach. Say where the server reaches it: for a container on this Mac, host.docker.internal.`,
    };
  }
  // A tunnel is this machine's route. Naming where the server reaches the
  // database directly is what makes the connection publishable.
  if (conn.tunnel?.target?.trim() && !opts.host?.trim()) {
    return {
      ok: false,
      error: `${conn.name} reaches its database through an SSH tunnel from this machine. The server needs its own route to ${conn.host}.`,
    };
  }

  const credential: HostedCredential =
    conn.engine === 'dynamodb' || conn.secretSource === 'none' || (!conn.secretSource && !conn.secretRef)
      ? { source: 'none' }
      : conn.secretSource === 'aws-iam'
        ? { source: 'aws-iam' }
        : { source: 'secret', env: secretEnvName(conn.name) };

  // DynamoDB is a region and the server's role; a host, port or login
  // carried over from the form would only mislead whoever reads the file.
  if (conn.engine === 'dynamodb') {
    return {
      ok: true,
      value: {
        id: conn.id,
        name: conn.name,
        env: conn.env,
        engine: 'dynamodb',
        ...(conn.region ? { region: conn.region } : {}),
        ...(conn.tableFilter ? { tableFilter: conn.tableFilter } : {}),
        credential,
      },
    };
  }

  const value: HostedConnection = {
    id: conn.id,
    name: conn.name,
    env: conn.env,
    engine: conn.engine as HostedEngine,
    ...(conn.variant ? { variant: conn.variant } : {}),
    ...(host ? { host } : {}),
    ...(conn.port ? { port: conn.port } : {}),
    ...(conn.database ? { database: conn.database } : {}),
    ...(opts.user?.trim() || conn.user ? { user: opts.user?.trim() || conn.user } : {}),
    ...(conn.ssl ? { ssl: conn.ssl } : {}),
    ...(conn.defaultSchema ? { defaultSchema: conn.defaultSchema } : {}),
    ...(conn.tableFilter ? { tableFilter: conn.tableFilter } : {}),
    ...(conn.region ? { region: conn.region } : {}),
    credential,
  };
  return { ok: true, value };
}

/// The connection a hosted record stands for. Being in the file IS being
/// exposed: who may use it is the hosting server's policy, not a flag.
export function fromHosted(h: HostedConnection): Connection {
  return {
    id: h.id,
    name: h.name,
    env: h.env,
    engine: h.engine,
    variant: h.variant,
    host: h.host,
    port: h.port,
    database: h.database,
    user: h.user,
    ssl: h.ssl,
    sslRootCert: h.sslRootCert,
    defaultSchema: h.defaultSchema,
    tableFilter: h.tableFilter,
    region: h.region,
    secretSource: h.credential.source === 'secret' ? 'env' : h.credential.source,
    ...(h.credential.source === 'secret' ? { secretEnvVar: h.credential.env } : {}),
    mcpExposed: true,
  } as Connection;
}

const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const optStr = (v: unknown) => v === undefined || typeof v === 'string';

function parseOne(raw: unknown, at: number): HostedConnection | string {
  if (!raw || typeof raw !== 'object') return `connection ${at + 1} is not an object`;
  const r = raw as Record<string, unknown>;
  const label = str(r.name) ? r.name : `connection ${at + 1}`;
  if (!str(r.id) || !str(r.name)) return `${label} needs an id and a name`;
  if (!(HOSTED_ENGINES as readonly unknown[]).includes(r.engine)) {
    return `${label}: engine must be one of ${HOSTED_ENGINES.join(', ')}`;
  }
  if (!(ENV_KINDS as readonly unknown[]).includes(r.env)) return `${label}: env must be one of ${ENV_KINDS.join(', ')}`;
  if (r.engine !== 'dynamodb' && !str(r.host)) return `${label} needs a host`;
  if (r.engine === 'dynamodb' && !str(r.region)) return `${label} needs a region`;
  if (r.port !== undefined && !(Number.isInteger(r.port) && (r.port as number) > 0 && (r.port as number) < 65536)) {
    return `${label}: port must be a number from 1 to 65535`;
  }
  if (r.ssl !== undefined && !(SSL_MODES as readonly unknown[]).includes(r.ssl)) {
    return `${label}: ssl must be one of ${SSL_MODES.join(', ')}`;
  }
  for (const key of ['variant', 'host', 'database', 'user', 'sslRootCert', 'defaultSchema', 'tableFilter', 'region']) {
    if (!optStr(r[key])) return `${label}: ${key} must be text`;
  }
  const c = r.credential as Record<string, unknown> | undefined;
  let credential: HostedCredential;
  if (c?.source === 'none' || c?.source === 'aws-iam') credential = { source: c.source };
  else if (c?.source === 'secret' && typeof c.env === 'string' && ENV_VAR_RE.test(c.env)) {
    credential = { source: 'secret', env: c.env };
  } else {
    return `${label}: credential must be {"source":"none"}, {"source":"aws-iam"} or {"source":"secret","env":"AN_ENV_VAR"}`;
  }
  if (credential.source === 'aws-iam' && r.engine === 'dynamodb') {
    return `${label}: DynamoDB signs in with the server's AWS role; use {"source":"none"}`;
  }
  const context = parseHostedContext(r.context);
  return { ...(r as unknown as HostedConnection), credential, context };
}

/// The connections in a hosted file, and what was wrong with the rest. A
/// bad entry is skipped and reported rather than failing the file: one
/// typo should not take every other database away from the agents.
export function parseHostedFile(raw: unknown): { connections: Connection[]; contexts: Record<string, HostedContext>; problems: string[] } {
  const file = raw as Partial<HostedFile> | null;
  if (!file || typeof file !== 'object' || !Array.isArray(file.connections)) {
    return { connections: [], contexts: {}, problems: ['the file needs a "connections" list'] };
  }
  if (file.version !== HOSTED_FILE_VERSION) {
    return { connections: [], contexts: {}, problems: [`the file is version ${String(file.version)}; this overdb reads version ${HOSTED_FILE_VERSION}`] };
  }
  const problems: string[] = [];
  const connections: Connection[] = [];
  const contexts: Record<string, HostedContext> = {};
  const seen = new Set<string>();
  file.connections.forEach((raw, at) => {
    const parsed = parseOne(raw, at);
    if (typeof parsed === 'string') return void problems.push(parsed);
    const key = parsed.name.toLowerCase();
    if (seen.has(key) || seen.has(parsed.id)) return void problems.push(`${parsed.name} appears twice; the first is used`);
    seen.add(key);
    seen.add(parsed.id);
    connections.push(fromHosted(parsed));
    if (parsed.context) contexts[parsed.id] = parsed.context;
  });
  return { connections, contexts, problems };
}

/// A connection on its way to an org's server, as overdb hands it to
/// overcli: a hosted record in an envelope saying what it is and when it
/// was made. It goes to `~/.overcli/inbox/connections/` — a folder of its
/// own, because overcli's handoff inbox rejects any kind it does not know,
/// and an older overcli must not file a connection under "rejected". The
/// folder exists only once an overcli that reads it has made it.
export const CONNECTION_PUSH_KIND = 'overdb-connection';

export interface ConnectionPush {
  version: typeof HOSTED_FILE_VERSION;
  kind: typeof CONNECTION_PUSH_KIND;
  id: string;
  createdAt: string;
  connection: HostedConnection;
}

export function buildConnectionPush(connection: HostedConnection, opts: { id: string; now: number }): ConnectionPush {
  return {
    version: HOSTED_FILE_VERSION,
    kind: CONNECTION_PUSH_KIND,
    id: opts.id,
    createdAt: new Date(opts.now).toISOString(),
    connection,
  };
}

/// Sorts by arrival, like a handoff's name.
export function connectionPushFileName(push: Pick<ConnectionPush, 'id' | 'createdAt'>): string {
  return `${push.createdAt.replace(/[:.]/g, '-')}-${push.id}.json`;
}

/// What the person has to arrange on the server for this connection to
/// sign in, in a sentence — shown before publishing and after.
export function hostedCredentialNote(h: HostedConnection): string {
  switch (h.credential.source) {
    case 'aws-iam':
      return `The server signs in as ${h.user ?? 'this user'} with an IAM token from its own AWS role, so that role needs rds-db:connect for ${h.user ?? 'the user'}.`;
    case 'secret':
      return `An admin sets the password in ${h.credential.env} on the server. Nothing from this machine is sent.`;
    case 'none':
      return h.engine === 'dynamodb'
        ? "The server reads DynamoDB with its own AWS role, so that role needs read access to these tables."
        : 'The server signs in with no password.';
  }
}
