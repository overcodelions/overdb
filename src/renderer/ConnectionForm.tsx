import { useState } from 'react';
import type { Connection, Engine, EnvKind, SecretSource, SslMode } from '@shared/types';
import { useStore } from './store';

const DEFAULT_PORT: Record<Engine, number> = { postgres: 5432, mysql: 3306, sqlite: 0 };

/// One form for both creating and editing, so the two can't drift into
/// offering different fields — the usual way an "edit" dialog ends up
/// unable to express something the "new" dialog could.
export function ConnectionForm({
  existing,
  onDone,
}: {
  existing?: Connection;
  onDone(): void;
}): JSX.Element {
  const addConnection = useStore((s) => s.addConnection);
  const updateConnection = useStore((s) => s.updateConnection);
  const toast = useStore((s) => s.toast);

  const [engine, setEngine] = useState<Engine>(existing?.engine ?? 'postgres');
  const [name, setName] = useState(existing?.name ?? '');
  const [env, setEnv] = useState<EnvKind>(existing?.env ?? 'local');
  const [host, setHost] = useState(existing?.host ?? 'localhost');
  const [port, setPort] = useState(String(existing?.port ?? DEFAULT_PORT.postgres));
  const [database, setDatabase] = useState(existing?.database ?? '');
  const [user, setUser] = useState(existing?.user ?? '');
  const [file, setFile] = useState(existing?.file ?? '');
  const [ssl, setSsl] = useState<SslMode>(existing?.ssl ?? 'disable');
  const [defaultSchema, setDefaultSchema] = useState(existing?.defaultSchema ?? '');

  const [secretSource, setSecretSource] = useState<SecretSource>(
    existing?.secretSource ?? (existing?.secretRef ? 'stored' : 'none'),
  );
  // Blank means "leave the stored password alone" when editing. Prefilling
  // it would require reading the secret back into the window, which is
  // exactly the thing the design forbids.
  const [password, setPassword] = useState('');
  const [envVar, setEnvVar] = useState(existing?.secretEnvVar ?? '');
  const [opRef, setOpRef] = useState(existing?.secretCommand ?? '');
  const [probe, setProbe] = useState<{ ok: boolean; detail: string } | null>(null);

  const [busy, setBusy] = useState(false);
  const isSqlite = engine === 'sqlite';
  const editing = !!existing;

  const pick = async () => {
    const chosen = await window.overdb.invoke('app:pickSqliteFile');
    if (chosen) {
      setFile(chosen);
      if (!name) setName(chosen.split('/').pop() ?? chosen);
    }
  };

  const runProbe = async () => {
    setProbe(await window.overdb.invoke('conn:probeSecret', {
      source: secretSource, envVar, reference: opRef,
    }));
  };

  const save = async () => {
    setBusy(true);
    try {
      const shape = {
        name: name || (isSqlite ? 'SQLite' : database || 'Connection'),
        engine, env,
        host: isSqlite ? undefined : host,
        port: isSqlite ? undefined : Number(port) || undefined,
        database: isSqlite ? undefined : database,
        user: isSqlite ? undefined : user,
        file: isSqlite ? file : undefined,
        ssl: isSqlite ? undefined : ssl,
        defaultSchema: defaultSchema || undefined,
        secretSource,
        secretEnvVar: secretSource === 'env' ? envVar : undefined,
        secretCommand: secretSource === 'op' ? opRef : undefined,
      };

      const result = editing
        ? await updateConnection(
            existing.id,
            {
              ...shape,
              secretRef: secretSource === 'stored' ? existing.id : undefined,
            },
            secretSource === 'stored'
              ? password
                ? { source: 'stored' as const, value: password }
                : null
              : { source: 'clear' as const },
          )
        : await addConnection(shape, secretSource === 'stored' ? password : null);

      if (result.ok) {
        onDone();
        toast(editing ? `Reconnected to ${shape.name}.` : `Connected to ${result.serverVersion ?? 'the database'}.`);
      } else {
        toast(result.error ?? 'Could not connect.', 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-5">
      <h2 className="text-sm font-semibold text-ink mb-4">
        {editing ? `Edit ${existing.name}` : 'New connection'}
      </h2>

      <Field label="Engine">
        <select
          className="field px-2 py-1 text-xs w-full"
          value={engine}
          onChange={(e) => {
            const next = e.target.value as Engine;
            setEngine(next);
            if (next !== 'sqlite') setPort(String(DEFAULT_PORT[next]));
          }}
        >
          <option value="postgres">Postgres</option>
          <option value="mysql">MySQL / MariaDB</option>
          <option value="sqlite">SQLite</option>
        </select>
      </Field>

      <div className="flex gap-2">
        <div className="flex-1">
          <Field label="Name">
            <input className="field px-2 py-1 text-xs w-full" value={name}
                   onChange={(e) => setName(e.target.value)} placeholder="orders-db local" />
          </Field>
        </div>
        <div className="w-32">
          <Field label="Environment">
            <select className="field px-2 py-1 text-xs w-full" value={env}
                    onChange={(e) => setEnv(e.target.value as EnvKind)}>
              <option value="local">local</option>
              <option value="dev">dev</option>
              <option value="staging">staging</option>
              <option value="prod">prod</option>
              <option value="other">other</option>
            </select>
          </Field>
        </div>
      </div>

      {isSqlite ? (
        <Field label="File">
          <div className="flex gap-2">
            <input readOnly className="field px-2 py-1 text-xs flex-1" value={file}
                   placeholder="Choose a .sqlite file…" />
            <button onClick={() => void pick()}
                    className="text-xs px-2 py-1 rounded border border-card hover:bg-card">
              Browse…
            </button>
          </div>
        </Field>
      ) : (
        <>
          <div className="flex gap-2">
            <div className="flex-1">
              <Field label="Host">
                <input className="field px-2 py-1 text-xs w-full" value={host}
                       onChange={(e) => setHost(e.target.value)} />
              </Field>
            </div>
            <div className="w-24">
              <Field label="Port">
                <input className="field px-2 py-1 text-xs w-full" value={port}
                       onChange={(e) => setPort(e.target.value)} />
              </Field>
            </div>
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <Field label="Database">
                <input className="field px-2 py-1 text-xs w-full" value={database}
                       onChange={(e) => setDatabase(e.target.value)} />
              </Field>
            </div>
            <div className="flex-1">
              <Field label="User">
                <input className="field px-2 py-1 text-xs w-full" value={user}
                       onChange={(e) => setUser(e.target.value)} />
              </Field>
            </div>
          </div>

          <Field label="Authentication">
            <select
              className="field px-2 py-1 text-xs w-full"
              value={secretSource}
              onChange={(e) => {
                setSecretSource(e.target.value as SecretSource);
                setProbe(null);
              }}
            >
              <option value="none">No password (trust / socket auth)</option>
              <option value="stored">Password, stored in the OS keychain</option>
              <option value="env">Environment variable</option>
              <option value="op">1Password reference</option>
            </select>
          </Field>

          {secretSource === 'stored' && (
            <>
              <Field label={editing ? 'New password' : 'Password'}>
                <input type="password" className="field px-2 py-1 text-xs w-full" value={password}
                       onChange={(e) => setPassword(e.target.value)}
                       placeholder={editing ? 'Leave blank to keep the current one' : ''} />
              </Field>
              <Note>
                Encrypted with your OS keychain and stored apart from everything else.
                This window can write it and can never read it back — which is why
                editing can&#39;t show you the current one.
              </Note>
            </>
          )}

          {secretSource === 'env' && (
            <>
              <Field label="Variable name">
                <div className="flex gap-2">
                  <input className="field px-2 py-1 text-xs flex-1 font-mono" value={envVar}
                         onChange={(e) => { setEnvVar(e.target.value); setProbe(null); }}
                         placeholder="PGPASSWORD" />
                  <button onClick={() => void runProbe()}
                          className="text-xs px-2 py-1 rounded border border-card hover:bg-card">
                    Check
                  </button>
                </div>
              </Field>
              <Note>
                Read from overdb&#39;s own environment when connecting, so rotating the
                variable rotates the credential. Note that a GUI app launched from the
                Dock does not inherit your shell profile.
              </Note>
            </>
          )}

          {secretSource === 'op' && (
            <>
              <Field label="Reference">
                <div className="flex gap-2">
                  <input className="field px-2 py-1 text-xs flex-1 font-mono" value={opRef}
                         onChange={(e) => { setOpRef(e.target.value); setProbe(null); }}
                         placeholder="op://Private/orders-db/password" />
                  <button onClick={() => void runProbe()}
                          className="text-xs px-2 py-1 rounded border border-card hover:bg-card">
                    Check
                  </button>
                </div>
              </Field>
              <Note>
                Resolved by running <span className="font-mono">op read</span> at connect
                time using your existing session. The reference is stored, never the
                secret — rotate it in 1Password and nothing here needs changing.
              </Note>
            </>
          )}

          {probe && (
            <p className={`text-[11px] mb-3 ${probe.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {probe.detail}
            </p>
          )}

          <div className="flex gap-2">
            <div className="flex-1">
              <Field label="SSL">
                <select className="field px-2 py-1 text-xs w-full" value={ssl}
                        onChange={(e) => setSsl(e.target.value as SslMode)}>
                  <option value="disable">Disable</option>
                  <option value="require">Require (no cert check)</option>
                  <option value="verify-full">Verify full</option>
                </select>
              </Field>
            </div>
            <div className="flex-1">
              <Field label={engine === 'postgres' ? 'Search path' : 'Default schema'}>
                <input className="field px-2 py-1 text-xs w-full" value={defaultSchema}
                       onChange={(e) => setDefaultSchema(e.target.value)} placeholder="public" />
              </Field>
            </div>
          </div>
        </>
      )}

      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onDone}
                className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card">
          Cancel
        </button>
        <button onClick={() => void save()} disabled={busy || (isSqlite && !file)}
                className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-40">
          {busy ? 'Connecting…' : editing ? 'Save & reconnect' : 'Add & connect'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block mb-3">
      <span className="block text-[10px] uppercase tracking-wider text-ink-faint mb-1">{label}</span>
      {children}
    </label>
  );
}

function Note({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="text-[11px] text-ink-faint leading-snug mb-3 -mt-1">{children}</p>;
}
