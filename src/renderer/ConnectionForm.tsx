import { useEffect, useState } from 'react';
import type {
  Connection,
  ConnectionTestResult,
  Engine,
  EnvKind,
  SecretSource,
  SslMode,
  Variant,
} from '@shared/types';
import { VARIANTS, VARIANT_ORDER, engineOf, variantDefaults } from '@shared/engines';
import { diagnose, type ConnectFix } from '@shared/connectDiagnosis';
import { parseConnectionUrl } from '@shared/connectionUrl';
import { formatArgv, parseArgv } from '@shared/argv';
import { validateTunnel } from '@shared/sshTunnel';
import { useStore } from './store';

/// One form for both creating and editing, so the two can't drift into
/// offering different fields — the usual way an "edit" dialog ends up
/// unable to express something the "new" dialog could.
type LocalServer = { engine: Engine; host: string; port: number; version?: string };

export function ConnectionForm({
  existing,
  found: foundFirst,
  onDone,
}: {
  existing?: Connection;
  /// A server the welcome screen already found. Applied once, on open,
  /// exactly as clicking its chip below would.
  found?: LocalServer;
  onDone(): void;
}): JSX.Element {
  const addConnection = useStore((s) => s.addConnection);
  const updateConnection = useStore((s) => s.updateConnection);
  const duplicateConnection = useStore((s) => s.duplicateConnection);
  const setSheet = useStore((s) => s.setSheet);
  const toast = useStore((s) => s.toast);

  /// The picker selects a FLAVOUR, not a driver. Redshift and Aurora both
  /// arrive through the Postgres driver but need different defaults and a
  /// different dialect, and asking the user for "Postgres" when they have a
  /// Redshift endpoint in their hand is how they end up with a connection
  /// that fails on TLS and reports as something it is not.
  const [variant, setVariant] = useState<Variant>(
    existing?.variant ?? (existing?.engine as Variant | undefined) ?? 'postgres',
  );
  const engine: Engine = engineOf(variant);
  const [name, setName] = useState(existing?.name ?? '');
  const [env, setEnv] = useState<EnvKind>(existing?.env ?? 'local');
  const [host, setHost] = useState(existing?.host ?? 'localhost');
  const [port, setPort] = useState(
    () => String(existing?.port ?? variantDefaults(existing?.variant ?? 'postgres').port ?? 5432),
  );
  const [database, setDatabase] = useState(existing?.database ?? '');
  const [user, setUser] = useState(existing?.user ?? '');
  const [file, setFile] = useState(existing?.file ?? '');
  const [region, setRegion] = useState(existing?.region ?? 'us-east-1');
  const [awsProfile, setAwsProfile] = useState(existing?.awsProfile ?? '');
  const [tableFilter, setTableFilter] = useState(existing?.tableFilter ?? '');
  const [ssl, setSsl] = useState<SslMode>(() => {
    if (existing?.ssl) return existing.ssl;
    // Same loopback exemption as credentialImport/index.ts: verify-full
    // against a stock local server with no TLS configured is a guaranteed
    // failure, not a safer default. This is a one-shot initializer, though —
    // see sslTouched/applyHost below for what keeps it honest once the user
    // starts typing a host.
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    return loopback ? 'disable' : variantDefaults(existing?.variant ?? 'postgres').ssl ?? 'verify-full';
  });
  // Whether the user has touched the SSL dropdown directly. Once they have,
  // typing a new host must not silently override their choice — but until
  // then, a host that stops (or starts) looking like loopback should update
  // the same untouched default the mount-time initializer above computed,
  // or `verify-full` becomes the default for every new connection typed
  // against a real host, including ones typed right after the box opened
  // pointed at `localhost`.
  const [sslTouched, setSslTouched] = useState(false);
  const [defaultSchema, setDefaultSchema] = useState(existing?.defaultSchema ?? '');

  const [secretSource, setSecretSource] = useState<SecretSource>(
    existing?.secretSource ?? (existing?.secretRef ? 'stored' : 'none'),
  );
  const [enc, setEnc] = useState<{ encrypted: boolean; backend: string } | null>(null);
  useEffect(() => { void window.overdb.invoke('conn:secretsEncrypted').then(setEnc); }, []);
  // Blank means "leave the stored password alone" when editing. Prefilling
  // it would require reading the secret back into the window, which is
  // exactly the thing the design forbids.
  const [password, setPassword] = useState('');
  const [envVar, setEnvVar] = useState(existing?.secretEnvVar ?? '');
  const [envFile, setEnvFile] = useState(existing?.secretEnvFile ?? '');
  const [opRef, setOpRef] = useState(existing?.secretCommand ?? '');
  /// The command as a person writes it. argv is what gets stored — see
  /// commandArgv below — and the two are kept apart deliberately: the
  /// string is for editing, the argv is the thing that runs.
  const [commandLine, setCommandLine] = useState(
    existing?.secretArgv ? formatArgv(existing.secretArgv) : '',
  );
  const [iamRegion, setIamRegion] = useState(
    existing?.secretSource === 'aws-iam' ? existing.region ?? '' : '',
  );
  const [iamProfile, setIamProfile] = useState(
    existing?.secretSource === 'aws-iam' ? existing.awsProfile ?? '' : '',
  );
  const [sslRootCert, setSslRootCert] = useState(existing?.sslRootCert ?? '');
  const [sslCert, setSslCert] = useState(existing?.sslCert ?? '');
  const [sslKey, setSslKey] = useState(existing?.sslKey ?? '');
  const [tunnelOn, setTunnelOn] = useState(!!existing?.tunnel?.target);
  const [tunnelTarget, setTunnelTarget] = useState(existing?.tunnel?.target ?? '');
  const [tunnelPort, setTunnelPort] = useState(
    existing?.tunnel?.port ? String(existing.tunnel.port) : '',
  );
  const [tunnelIdentity, setTunnelIdentity] = useState(existing?.tunnel?.identityFile ?? '');
  const [tunnelRemoteHost, setTunnelRemoteHost] = useState(existing?.tunnel?.remoteHost ?? '');
  const [tunnelRemotePort, setTunnelRemotePort] = useState(
    existing?.tunnel?.remotePort ? String(existing.tunnel.remotePort) : '',
  );
  const [urlText, setUrlText] = useState('');
  const [probe, setProbe] = useState<{ ok: boolean; detail: string } | null>(null);
  /// The last connection attempt, from either button. Save reports through
  /// the same panel as Test: a failed save IS a failed connection, and
  /// sending one to a toast and the other to a panel would mean the useful
  /// half — what to change — only ever appeared for one of them.
  const [attempt, setAttempt] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  // Only offered on a NEW connection: an existing one already points
  // somewhere, and rewriting its host from under it would be a surprise.
  const [found, setFound] = useState<LocalServer[] | null>(null);
  useEffect(() => {
    if (existing) return;
    void window.overdb.invoke('conn:discoverLocal').then(setFound).catch(() => setFound([]));
  }, [existing]);

  const applyFound = (s: LocalServer) => {
    setVariant(s.engine as Variant);
    applyHost(s.host);
    setPort(String(s.port));
    if (!name) setName(`${s.version?.replace(/^5\.5\.5-/, '') ?? s.engine} local`);
    setEnv('local');
  };
  useEffect(() => {
    if (foundFirst && !existing) applyFound(foundFirst);
    // Once, on open: afterwards the fields are the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [busy, setBusy] = useState(false);
  const isSqlite = engine === 'sqlite';
  const isDynamo = engine === 'dynamodb';
  /// Everything host/port/user/password is meaningless for both of these:
  /// one is a file, the other an HTTPS API authenticated by AWS.
  const isNetworkSql = !isSqlite && !isDynamo;
  const editing = !!existing;

  const pick = async () => {
    const chosen = await window.overdb.invoke('app:pickSqliteFile');
    if (chosen) {
      setFile(chosen);
      if (!name) setName(chosen.split('/').pop() ?? chosen);
    }
  };

  /// The command, split the way it will be stored and run. A parse error
  /// is shown next to the field rather than at connect time, because the
  /// answer ("that is shell syntax and nothing here runs a shell") is only
  /// useful while you are still looking at what you typed.
  const parsedCommand = commandLine.trim() ? parseArgv(commandLine) : null;
  const commandArgv = parsedCommand?.ok ? parsedCommand.argv : undefined;
  const commandError = parsedCommand && !parsedCommand.ok ? parsedCommand.error : null;

  const tunnelDraft = tunnelOn && tunnelTarget.trim()
    ? {
        target: tunnelTarget.trim(),
        port: tunnelPort.trim() ? Number(tunnelPort) : undefined,
        identityFile: tunnelIdentity.trim() || undefined,
        remoteHost: tunnelRemoteHost.trim() || undefined,
        remotePort: tunnelRemotePort.trim() ? Number(tunnelRemotePort) : undefined,
      }
    : undefined;
  const tunnelError = tunnelDraft ? validateTunnel(tunnelDraft) : null;

  const runProbe = async () => {
    setProbe(await window.overdb.invoke('conn:probeSecret', {
      source: secretSource,
      envVar,
      envFile: envFile || undefined,
      reference: opRef,
      argv: commandArgv,
      host,
      port: Number(port) || undefined,
      user,
      region: iamRegion || undefined,
      profile: iamProfile || undefined,
    }));
  };

  const pickPath = async (
    kind: 'ca' | 'cert' | 'key' | 'identity' | 'envfile',
    set: (v: string) => void,
  ) => {
    const chosen = await window.overdb.invoke('app:pickKeyFile', kind);
    if (chosen) set(chosen);
  };

  /// Fill the form from a pasted connection URL.
  ///
  /// The password, if the URL carried one, goes straight into the keychain
  /// field and the URL box is cleared — a window holding a plaintext
  /// credential in a text input, on screen, is the thing this app is
  /// otherwise careful never to do.
  const applyUrl = () => {
    const parsed = parseConnectionUrl(urlText);
    if (!parsed) return;
    if (parsed.variant) setVariant(parsed.variant);
    else if (parsed.engine !== engine) setVariant(parsed.engine as Variant);
    if (parsed.engine === 'sqlite' && parsed.database) setFile(parsed.database);
    // applyHost, not setHost: a pasted URL usually carries no sslmode, and
    // this form opens on `localhost` — so leaving the SSL default alone here
    // means pasting a prod URL silently keeps `disable` and connects in
    // cleartext. `variant` is read one render stale by applyHost, which only
    // ever errs stricter (postgres' verify-full over redshift's require),
    // and the `parsed.ssl` line below still lets an explicit sslmode win.
    if (parsed.host) applyHost(parsed.host);
    if (parsed.port) setPort(String(parsed.port));
    if (parsed.database) setDatabase(parsed.database);
    if (parsed.user) setUser(parsed.user);
    if (parsed.ssl) setSsl(parsed.ssl);
    if (parsed.defaultSchema) setDefaultSchema(parsed.defaultSchema);
    if (parsed.password) {
      setSecretSource('stored');
      setPassword(parsed.password);
    }
    if (!name && parsed.database) setName(parsed.database);
    setUrlText('');
    setProbe(null);
    setAttempt(null);
  };

  /// The connection as the form currently describes it. One function, used
  /// by both Save and Test — a Test that built its own slightly different
  /// shape would be testing something other than what Save writes, which is
  /// the one thing a test button must never do.
  const shape = () => ({
    name:
      name || (isSqlite ? 'SQLite' : isDynamo ? `DynamoDB ${region}` : database || 'Connection'),
    engine,
    variant,
    env,
    host: isNetworkSql ? host : undefined,
    port: isNetworkSql ? Number(port) || undefined : undefined,
    database: isNetworkSql ? database : undefined,
    user: isNetworkSql ? user : undefined,
    file: isSqlite ? file : undefined,
    tableFilter: isDynamo ? tableFilter.trim() || undefined : undefined,
    ssl: isNetworkSql ? ssl : undefined,
    sslRootCert: isNetworkSql && ssl !== 'disable' ? sslRootCert || undefined : undefined,
    sslCert: isNetworkSql && ssl !== 'disable' ? sslCert || undefined : undefined,
    sslKey: isNetworkSql && ssl !== 'disable' ? sslKey || undefined : undefined,
    defaultSchema: isNetworkSql ? defaultSchema || undefined : undefined,
    tunnel: isNetworkSql ? tunnelDraft : undefined,
    // DynamoDB authenticates through the AWS provider chain, so overdb
    // holds no secret for it at all.
    secretSource: (isDynamo ? 'none' : secretSource) as SecretSource,
    secretEnvVar: !isDynamo && secretSource === 'env' ? envVar : undefined,
    secretEnvFile: !isDynamo && secretSource === 'env' ? envFile || undefined : undefined,
    secretCommand: !isDynamo && secretSource === 'op' ? opRef : undefined,
    secretArgv: !isDynamo && secretSource === 'command' ? commandArgv : undefined,
    // IAM reuses the two AWS fields DynamoDB already has, because they mean
    // the same thing: which account answers, and in which region.
    region: isDynamo ? region : secretSource === 'aws-iam' ? iamRegion.trim() || undefined : undefined,
    awsProfile: isDynamo
      ? awsProfile || undefined
      : secretSource === 'aws-iam'
        ? iamProfile.trim() || undefined
        : undefined,
  });

  const test = async () => {
    setTesting(true);
    setAttempt(null);
    try {
      const result = await window.overdb.invoke('conn:test', {
        ...shape(),
        // Lets main fall back to the stored password when the field was
        // left blank, which is the normal case when editing.
        id: existing?.id,
        password: secretSource === 'stored' && password ? password : undefined,
      });
      setAttempt(result);
      // The server is the authority on what it is. If it says Redshift and
      // the picker says Postgres, the picker was wrong — adopt it, so what
      // gets saved matches what answered.
      if (result.ok && result.variant && result.variant !== variant) setVariant(result.variant);
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setAttempt(null);
    try {
      const draft = shape();
      const result = editing
        ? await updateConnection(
            existing.id,
            {
              ...draft,
              secretRef: secretSource === 'stored' ? existing.id : undefined,
            },
            secretSource === 'stored'
              ? password
                ? { source: 'stored' as const, value: password }
                : null
              : { source: 'clear' as const },
          )
        : await addConnection(draft, secretSource === 'stored' ? password : null);

      if (result.ok) {
        onDone();
        toast(editing ? `Reconnected to ${draft.name}.` : `Connected to ${result.serverVersion ?? 'the database'}.`);
      } else {
        // Kept in the dialog rather than sent to a toast: the diagnosis is
        // about fields that are still on screen, and the fixes act on them.
        setAttempt({ ok: false, error: result.error ?? 'Could not connect.' });
      }
    } finally {
      setBusy(false);
    }
  };

  /// Save what is on screen as a NEW connection, leaving this one exactly
  /// as it was. The usual reason to be in this dialog editing a host you
  /// already have is that you want a second one almost like it — one
  /// database over, one environment along — and the way that goes wrong is
  /// saving the edit onto the connection you still needed.
  ///
  /// Nothing connects: the copy opens in this same dialog, on its own
  /// record, ready to be named.
  const duplicate = async () => {
    if (!existing) return;
    setBusy(true);
    try {
      const copied = await duplicateConnection(
        existing.id,
        shape(),
        secretSource === 'stored' ? password || null : null,
      );
      if (copied) {
        setSheet({ kind: 'editConnection', id: copied });
        toast('Copied. Nothing is connected yet — save when it points where you want.');
      }
    } finally {
      setBusy(false);
    }
  };

  /// Apply a suggested fix to the form. Nothing is saved and nothing
  /// reconnects — the user still presses Test or Save.
  const applyFix = (fix: ConnectFix) => {
    if (!fix.set) return;
    if (fix.set.ssl) setSsl(fix.set.ssl);
    if (fix.set.port) setPort(String(fix.set.port));
    if (fix.set.secretSource) {
      setSecretSource(fix.set.secretSource);
      setProbe(null);
    }
    setAttempt(null);
  };

  /// Keep the loopback exemption honest as the user types, without ever
  /// overriding a choice they made themselves in the SSL dropdown. Typing
  /// `db.prod.example.com` over a form that opened on `localhost` must not
  /// leave `ssl: 'disable'` sitting there uncontested — that is the same
  /// silent-cleartext failure step 15 fixed for the mount-time default.
  const applyHost = (h: string) => {
    setHost(h);
    if (sslTouched || existing?.ssl) return;
    const loopback = h === 'localhost' || h === '127.0.0.1' || h === '::1';
    setSsl(loopback ? 'disable' : variantDefaults(variant).ssl ?? 'verify-full');
  };

  return (
    <div className="p-5">
      <h2 className="text-sm font-semibold text-ink mb-4">
        {editing ? `Edit ${existing.name}` : 'New connection'}
      </h2>

      {found && found.length > 0 && (
        <div className="mb-3">
          <span className="block text-[11px] text-ink-muted mb-1.5">Running on this machine</span>
          <div className="flex flex-wrap gap-1.5">
            {found.map((s) => (
              <button
                key={`${s.engine}:${s.port}`}
                onClick={() => applyFound(s)}
                className="text-[11px] px-2 py-1 rounded border border-card hover:bg-card text-ink flex items-center gap-1.5"
              >
                {/* The version the server volunteered, not the port's
                    reputation — 3306 answering does not prove MySQL. */}
                <span>{s.version?.replace(/^5\.5\.5-/, '') ?? s.engine}</span>
                <span className="text-ink-faint font-mono">:{s.port}</span>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] text-ink-faint leading-snug">
            Found by asking each port what it is. Fills in the engine, host and port — the database
            and password are still yours to supply.
          </p>
        </div>
      )}

      {/* Everyone already has one of these in a .env or a runbook, and
          retyping it into six boxes is where the typo comes from. */}
      <Field label="Paste a connection URL">
        <div className="flex gap-2">
          <input
            className="field px-2 py-1 text-xs flex-1 font-mono"
            value={urlText}
            onChange={(e) => setUrlText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && parseConnectionUrl(urlText)) {
                e.preventDefault();
                applyUrl();
              }
            }}
            placeholder="postgres://user:pass@host:5432/orders?sslmode=require"
            spellCheck={false}
          />
          <button
            onClick={applyUrl}
            disabled={!parseConnectionUrl(urlText)}
            className="text-xs px-2 py-1 rounded border border-card hover:bg-card disabled:opacity-40"
          >
            Fill in
          </button>
        </div>
      </Field>
      <UrlPreview text={urlText} />

      <Field label="Type">
        <select
          className="field px-2 py-1 text-xs w-full"
          value={variant}
          onChange={(e) => {
            const next = e.target.value as Variant;
            setVariant(next);
            setAttempt(null);
            // Picking a type is an explicit statement about what is at the
            // other end, so its defaults apply — including to a connection
            // being edited, which is exactly the case where you are fixing
            // one that was set up as plain Postgres by mistake.
            const d = variantDefaults(next);
            if (d.port) setPort(String(d.port));
            if (d.ssl) setSsl(d.ssl);
          }}
        >
          {VARIANT_ORDER.map((v) => (
            <option key={v} value={v}>
              {VARIANTS[v].label}
            </option>
          ))}
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
              <option value="sandbox">sandbox</option>
              <option value="staging">staging</option>
              <option value="prod">prod</option>
              <option value="other">other</option>
            </select>
          </Field>
        </div>
      </div>

      {isDynamo ? (
        <>
          <div className="flex gap-2">
            <div className="flex-1">
              <Field label="Region">
                <input className="field px-2 py-1 text-xs w-full" value={region}
                       onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" />
              </Field>
            </div>
            <div className="flex-1">
              <Field label="AWS profile">
                <input className="field px-2 py-1 text-xs w-full" value={awsProfile}
                       onChange={(e) => setAwsProfile(e.target.value)}
                       placeholder="default — or leave blank for the usual chain" />
              </Field>
            </div>
          </div>
          <label className="block mb-2.5">
            <span className="flex items-baseline justify-between gap-3 mb-1">
              <span className="text-[10px] uppercase tracking-wider text-ink-faint">Tables</span>
              <span className="text-[10px] text-ink-faint">
                DynamoDB has no schemas — names are the only namespace
              </span>
            </span>
            <input
              className="field px-2 py-1 text-xs w-full font-mono"
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
              placeholder="all tables — try LOCAL. or !PROD."
            />
          </label>

          <FilterPreview connectionId={existing?.id} filter={tableFilter} />

          {/* A pattern language is a LOOKUP: you come back to check one row,
              not to read a paragraph. So it is a two-column key, not prose. */}
          <div className="mb-3 rounded border border-card px-3 py-2.5 grid grid-cols-[104px_1fr] gap-x-3 gap-y-1.5 items-baseline">
            <code className="font-mono text-[11px] text-ink">LOCAL.</code>
            <span className="text-[11px] text-ink-muted leading-snug">
              Prefix. Everything whose name starts with it.
            </span>
            <code className="font-mono text-[11px] text-ink">*evt* log?</code>
            <span className="text-[11px] text-ink-muted leading-snug">
              Wildcards, anywhere — any run, any single character.
            </span>
            <code className="font-mono text-[11px] text-ink">!PROD.</code>
            <span className="text-[11px] text-ink-muted leading-snug">
              Exclude. Keeps everything else.
            </span>
            <code className="font-mono text-[11px] text-ink">a, b</code>
            <span className="text-[11px] text-ink-muted leading-snug">
              Several at once. Case is ignored. Blank shows all.
            </span>
          </div>

          <div className="flex gap-2 mb-2">
            <KeyIcon />
            <p className="text-[11px] text-ink-muted leading-snug">
              Credentials come from your AWS setup — environment variables, an SSO session, or the
              profile above. overdb stores nothing.
            </p>
          </div>
          {/* The filter caveat and the read-only caveat were two paragraphs
              making one point: overdb's checks run locally and IAM is the
              boundary. Said once, it is read; said twice, neither is. */}
          <div className="flex gap-2 mb-3">
            <WarnIcon />
            <p className="text-[11px] text-warn/90 leading-snug">
              <span className="font-semibold">Both limits above are local.</span> This filter and
              overdb&#39;s refusal to write both run here, not at AWS — a hidden table is still
              queryable by name, and the durable boundary is the IAM policy on these credentials.
            </p>
          </div>
        </>
      ) : isSqlite ? (
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
                       onChange={(e) => applyHost(e.target.value)} />
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
              <option value="command">Command that prints the password</option>
              <option value="aws-iam">AWS IAM token (RDS, Aurora, Redshift)</option>
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
                {enc && !enc.encrypted
                  ? 'No OS keychain is available here, so a stored password is only base64 on disk — not encrypted. Use the env or 1Password secret source instead.'
                  : 'Encrypted with your OS keychain and stored apart from everything else.'}{' '}
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
              <Field label="Fall back to a file (optional)">
                <div className="flex gap-2">
                  <input className="field px-2 py-1 text-xs flex-1 font-mono" value={envFile}
                         onChange={(e) => { setEnvFile(e.target.value); setProbe(null); }}
                         placeholder="~/work/orders/.env" />
                  <button onClick={() => void pickPath('envfile', setEnvFile)}
                          className="text-xs px-2 py-1 rounded border border-card hover:bg-card">
                    Browse…
                  </button>
                </div>
              </Field>
              <Note>
                Read from overdb&#39;s own environment when connecting, so rotating the
                variable rotates the credential. A GUI app launched from the Dock does not
                inherit your shell profile — which is what the file is for: only its path is
                stored, and the variable is read out of it at connect time.
              </Note>
            </>
          )}

          {secretSource === 'command' && (
            <>
              <Field label="Command">
                <div className="flex gap-2">
                  <input className="field px-2 py-1 text-xs flex-1 font-mono" value={commandLine}
                         onChange={(e) => { setCommandLine(e.target.value); setProbe(null); }}
                         placeholder="vault kv get -field=password secret/orders/prod"
                         spellCheck={false} />
                  <button onClick={() => void runProbe()} disabled={!commandArgv}
                          className="text-xs px-2 py-1 rounded border border-card hover:bg-card disabled:opacity-40">
                    Check
                  </button>
                </div>
              </Field>
              {commandError && (
                <p className="text-[11px] text-warn/90 leading-snug mb-3 -mt-1">{commandError}</p>
              )}
              <Note>
                Whatever it prints on stdout is the password — Vault, Secrets Manager,
                <span className="font-mono"> pass</span>, or your own wrapper. It is run
                directly, never through a shell, so pipes and{' '}
                <span className="font-mono">$(…)</span> are refused rather than quietly passed
                along as arguments. Only the command is stored — and it is stored in plain
                settings, so put the <em>lookup</em> here, never the secret itself.
              </Note>
            </>
          )}

          {secretSource === 'aws-iam' && (
            <>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Field label="Region (optional)">
                    <input className="field px-2 py-1 text-xs w-full font-mono" value={iamRegion}
                           onChange={(e) => { setIamRegion(e.target.value); setProbe(null); }}
                           placeholder="read from the endpoint" />
                  </Field>
                </div>
                <div className="flex-1">
                  <Field label="AWS profile (optional)">
                    <div className="flex gap-2">
                      <input className="field px-2 py-1 text-xs flex-1" value={iamProfile}
                             onChange={(e) => { setIamProfile(e.target.value); setProbe(null); }}
                             placeholder="the usual chain" />
                      <button onClick={() => void runProbe()}
                              className="text-xs px-2 py-1 rounded border border-card hover:bg-card">
                        Check
                      </button>
                    </div>
                  </Field>
                </div>
              </div>
              <Note>
                A signed token, minted fresh on every connect and good for fifteen minutes —
                there is no stored secret at all. Needs{' '}
                <span className="font-mono">rds-db:connect</span> on your IAM principal and a
                database user granted{' '}
                <span className="font-mono">rds_iam</span>. The connection is encrypted whether
                or not SSL is set below: the token is a bearer credential and overdb will not
                put one on a plaintext socket.
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
            <p className={`text-[11px] mb-3 ${probe.ok ? 'text-good' : 'text-bad'}`}>
              {probe.detail}
            </p>
          )}

          <div className="flex gap-2">
            <div className="flex-1">
              <Field label="SSL">
                <select className="field px-2 py-1 text-xs w-full" value={ssl}
                        onChange={(e) => { setSsl(e.target.value as SslMode); setSslTouched(true); }}>
                  <option value="disable">Disable</option>
                  <option value="require">Require (no cert check)</option>
                  <option value="verify-ca">Verify CA (chain, not hostname)</option>
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

          {ssl !== 'disable' && (
            <details className="mb-3 rounded border border-card px-3 py-2" open={!!(sslRootCert || sslCert || sslKey)}>
              <summary className="text-[11px] text-ink-muted cursor-pointer select-none">
                Certificates
                {sslRootCert || sslCert ? (
                  <span className="ml-2 text-[10px] text-good/90">
                    {sslCert ? 'client certificate' : 'custom CA'}
                  </span>
                ) : null}
              </summary>
              <div className="mt-2">
                <PathField label="CA certificate" value={sslRootCert}
                           onChange={setSslRootCert}
                           onBrowse={() => void pickPath('ca', setSslRootCert)}
                           placeholder="the system trust store" />
                <PathField label="Client certificate" value={sslCert}
                           onChange={setSslCert}
                           onBrowse={() => void pickPath('cert', setSslCert)}
                           placeholder="none" />
                <PathField label="Client key" value={sslKey}
                           onChange={setSslKey}
                           onBrowse={() => void pickPath('key', setSslKey)}
                           placeholder="none" />
                <p className="text-[11px] text-ink-faint leading-snug">
                  {ssl === 'require'
                    ? 'On Require these are still sent, but nothing about the server is checked. Verify CA or Verify full is what makes a CA mean anything.'
                    : 'A CA is what lets Verify full succeed against a private root instead of being switched off. A client certificate and key are how CockroachDB and mutual-TLS Postgres identify you — often instead of a password.'}
                  {' '}Paths only: the files are read when connecting and never stored here.
                </p>
              </div>
            </details>
          )}

          <details className="mb-3 rounded border border-card px-3 py-2" open={tunnelOn}>
            <summary className="text-[11px] text-ink-muted cursor-pointer select-none">
              SSH tunnel
              {tunnelOn && tunnelTarget.trim() ? (
                <span className="ml-2 text-[10px] font-mono text-good/90">{tunnelTarget.trim()}</span>
              ) : null}
            </summary>
            <div className="mt-2">
              <label className="flex items-center gap-2 mb-2.5 text-[11px] text-ink">
                <input type="checkbox" checked={tunnelOn}
                       onChange={(e) => { setTunnelOn(e.target.checked); setAttempt(null); }} />
                Reach this database through a bastion
              </label>
              {tunnelOn && (
                <>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <Field label="SSH host">
                        <input className="field px-2 py-1 text-xs w-full font-mono" value={tunnelTarget}
                               onChange={(e) => { setTunnelTarget(e.target.value); setAttempt(null); }}
                               placeholder="ec2-user@bastion.example.com" spellCheck={false} />
                      </Field>
                    </div>
                    <div className="w-20">
                      <Field label="Port">
                        <input className="field px-2 py-1 text-xs w-full" value={tunnelPort}
                               onChange={(e) => setTunnelPort(e.target.value)} placeholder="22" />
                      </Field>
                    </div>
                  </div>
                  <PathField label="Key file (optional)" value={tunnelIdentity}
                             onChange={setTunnelIdentity}
                             onBrowse={() => void pickPath('identity', setTunnelIdentity)}
                             placeholder="your agent and ~/.ssh/config" />
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <Field label="Database host, from the bastion">
                        <input className="field px-2 py-1 text-xs w-full font-mono" value={tunnelRemoteHost}
                               onChange={(e) => setTunnelRemoteHost(e.target.value)}
                               placeholder={host || 'the host above'} spellCheck={false} />
                      </Field>
                    </div>
                    <div className="w-20">
                      <Field label="Port">
                        <input className="field px-2 py-1 text-xs w-full" value={tunnelRemotePort}
                               onChange={(e) => setTunnelRemotePort(e.target.value)}
                               placeholder={port || ''} />
                      </Field>
                    </div>
                  </div>
                  {tunnelError && (
                    <p className="text-[11px] text-warn/90 leading-snug mb-2">{tunnelError}</p>
                  )}
                  <p className="text-[11px] text-ink-faint leading-snug">
                    overdb runs your own <span className="font-mono">ssh</span>, so{' '}
                    <span className="font-mono">~/.ssh/config</span> aliases, ProxyJump and your
                    agent all apply — and no private key is ever handled here. It will not answer
                    a passphrase or accept an unknown host key on your behalf: if{' '}
                    <span className="font-mono">ssh {tunnelTarget.trim() || '<host>'}</span> works
                    in a terminal, this works. The forwarded port is bound to 127.0.0.1 only.
                  </p>
                </>
              )}
            </div>
          </details>
        </>
      )}

      <Attempt
        result={attempt}
        engine={engine}
        variant={variant}
        ssl={ssl}
        secretSource={isDynamo ? undefined : secretSource}
        host={host}
        port={Number(port) || undefined}
        user={user}
        database={database}
        onFix={applyFix}
      />

      <div className="flex items-center gap-2 mt-4">
        {/* Test sits apart from the two decision buttons: it changes
            nothing, and pressing it should never feel like committing. */}
        <button onClick={() => void test()} disabled={testing || busy || !!commandError || !!tunnelError}
                className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card disabled:opacity-40">
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {editing && (
          <button onClick={() => void duplicate()} disabled={testing || busy}
                  title="Save these settings as a new connection, leaving this one unchanged"
                  className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card disabled:opacity-40">
            Duplicate
          </button>
        )}
        <div className="flex-1" />
        <button onClick={onDone}
                className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card">
          Cancel
        </button>
        <button onClick={() => void save()}
                disabled={
                  busy ||
                  (isSqlite && !file) ||
                  (isDynamo && !region.trim()) ||
                  !!commandError ||
                  !!tunnelError
                }
                className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-40">
          {busy ? 'Connecting…' : editing ? 'Save & reconnect' : 'Add & connect'}
        </button>
      </div>
    </div>
  );
}

/// The outcome of a connection attempt, and what to do about it.
///
/// A driver error alone is a dead end for anyone who did not write the
/// driver: "no pg_hba.conf entry for host ..., SSL off" is Redshift saying
/// "turn on TLS", and says so nowhere. The message is still shown — it is
/// the ground truth, and someone will paste it into a ticket — but it is
/// shown UNDER the sentence that explains it and the buttons that fix it.
function Attempt({
  result,
  engine,
  variant,
  ssl,
  secretSource,
  host,
  port,
  user,
  database,
  onFix,
}: {
  result: ConnectionTestResult | null;
  engine: Engine;
  variant: Variant;
  ssl?: SslMode;
  secretSource?: SecretSource;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  onFix(fix: ConnectFix): void;
}): JSX.Element | null {
  if (!result) return null;

  if (result.ok) {
    return (
      <div className="mt-3 rounded border border-good/30 bg-good/5 px-3 py-2.5">
        <p className="text-[11px] text-good font-semibold">
          Connected to {VARIANTS[result.variant ?? variant].label}.
        </p>
        {result.serverVersion && (
          // What the server volunteered, verbatim. It is the only proof on
          // screen that this is the database you meant.
          <p className="mt-1 font-mono text-[10.5px] text-ink-muted leading-snug break-words">
            {result.serverVersion}
          </p>
        )}
      </div>
    );
  }

  const d = diagnose({
    engine,
    error: result.error ?? '',
    ssl,
    secretSource,
    host,
    port,
    user,
    database,
  });

  return (
    <div className="mt-3 rounded border border-bad/30 bg-bad/5 px-3 py-2.5">
      <p className="text-[11px] text-bad-strong font-semibold leading-snug">{d.cause}</p>

      {d.fixes.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {d.fixes.map((fix) => (
            <li key={fix.label}>
              {fix.set ? (
                <button
                  onClick={() => onFix(fix)}
                  className="w-full text-left rounded border border-card hover:bg-card px-2 py-1.5"
                >
                  <span className="block text-[11px] text-ink font-medium">{fix.label}</span>
                  <span className="block text-[10.5px] text-ink-faint leading-snug">{fix.detail}</span>
                </button>
              ) : (
                // No `set` means the remedy is outside this dialog — a VPN,
                // a GRANT, an IAM policy. Shown, but not as a button that
                // would do nothing.
                <div className="px-2 py-1.5">
                  <span className="block text-[11px] text-ink-muted font-medium">{fix.label}</span>
                  <span className="block text-[10.5px] text-ink-faint leading-snug">{fix.detail}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {result.error && (
        <p className="mt-2 font-mono text-[10.5px] text-ink-faint leading-snug break-words">
          {result.error}
        </p>
      )}
    </div>
  );
}

/// A path, typed or picked. The renderer cannot browse the disk itself, so
/// Browse goes through main — and what comes back, here and everywhere
/// else in this form, is a path and never a file's contents.
function PathField({
  label,
  value,
  onChange,
  onBrowse,
  placeholder,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  onBrowse(): void;
  placeholder?: string;
}): JSX.Element {
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <input className="field px-2 py-1 text-xs flex-1 font-mono" value={value}
               onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
               spellCheck={false} />
        <button onClick={onBrowse}
                className="text-xs px-2 py-1 rounded border border-card hover:bg-card">
          Browse…
        </button>
        {value && (
          <button onClick={() => onChange('')} title="Clear"
                  className="text-xs px-2 py-1 rounded border border-card hover:bg-card text-ink-faint">
            ×
          </button>
        )}
      </div>
    </Field>
  );
}

/// What a pasted URL was understood to say, before anything is applied.
///
/// Pasting a credential into a form and pressing a button you cannot see
/// the effect of is how people end up connected to the wrong environment.
/// The password is acknowledged and never echoed.
function UrlPreview({ text }: { text: string }): JSX.Element | null {
  if (!text.trim()) return null;
  const parsed = parseConnectionUrl(text);
  if (!parsed) {
    return (
      <p className="text-[11px] text-ink-faint leading-snug mb-3 -mt-1">
        Not a connection URL yet — postgres://, mysql://, or a jdbc: one.
      </p>
    );
  }
  return (
    <p className="text-[11px] text-ink-muted leading-snug mb-3 -mt-1">
      {VARIANTS[parsed.variant ?? (parsed.engine as Variant)].label}
      {parsed.host ? ` · ${parsed.host}${parsed.port ? `:${parsed.port}` : ''}` : ''}
      {parsed.database ? ` · ${parsed.database}` : ''}
      {parsed.user ? ` · ${parsed.user}` : ''}
      {parsed.ssl ? ` · SSL ${parsed.ssl}` : ''}
      {parsed.password ? ' · password → your OS keychain' : ''}
      {parsed.ignored.length > 0 ? ` · ignoring ${parsed.ignored.join(', ')}` : ''}
    </p>
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

/// What the filter you are typing would actually select.
///
/// A pattern language explained in prose stays a guess until you try it, and
/// "12 of 228" answers "did I type that right" in a way no sentence about
/// wildcards can. Only available while EDITING — a connection being added
/// has no session to ask, and the field still works without this.
function FilterPreview({
  connectionId,
  filter,
}: {
  connectionId: string | undefined;
  filter: string;
}): JSX.Element | null {
  const [result, setResult] = useState<{
    total: number;
    matched: number;
    sample: string[];
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (!connectionId) return;
    let live = true;
    // Debounced: this pages the whole account's table list, and running it
    // per keystroke would make typing a prefix hit AWS six times.
    const t = setTimeout(() => {
      window.overdb
        .invoke('conn:previewTableFilter', { connectionId, filter })
        .then((r) => {
          if (live) setResult(r);
        })
        .catch(() => {
          if (live) setResult(null);
        });
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [connectionId, filter]);

  if (!connectionId || !result || result.error) return null;

  const all = result.matched === result.total;
  return (
    <div className="mb-3 rounded border border-card px-2.5 py-2">
      <div className="flex items-baseline gap-1.5 text-[11px]">
        <span className={all ? 'text-ink-muted' : 'text-good/90'}>
          {result.matched.toLocaleString()} of {result.total.toLocaleString()} tables
        </span>
        <span className="text-ink-muted">
          {all ? '— no filter, everything in this region' : 'match'}
        </span>
      </div>
      {!all && result.sample.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {result.sample.map((name) => (
            <li key={name} className="font-mono text-[11px] text-ink truncate">
              {name}
            </li>
          ))}
          {result.matched > result.sample.length && (
            <li className="text-[11px] text-ink-faint">
              and {(result.matched - result.sample.length).toLocaleString()} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function KeyIcon(): JSX.Element {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      className="shrink-0 mt-px text-ink-faint" aria-hidden
    >
      <circle cx="7.5" cy="15.5" r="4" />
      <path d="M10.5 12.5 20 3" />
      <path d="M16.5 6.5 19 9" />
    </svg>
  );
}

function WarnIcon(): JSX.Element {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      className="shrink-0 mt-px text-warn/90" aria-hidden
    >
      <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}
