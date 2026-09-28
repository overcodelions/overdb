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
import { ENV_DOT, TAG_DOT, TAG_TEXT } from './engineTags';

/// One form for both creating and editing, so the two can't drift into
/// offering different fields — the usual way an "edit" dialog ends up
/// unable to express something the "new" dialog could.
type LocalServer = { engine: Engine; host: string; port: number; version?: string };

export function ConnectionForm({
  existing,
  found: foundFirst,
  failure,
  onDone,
}: {
  existing?: Connection;
  /// A connect attempt that failed outside the form. Shown as if Test had
  /// just returned it, so the explanation and its fix buttons are the
  /// first thing on screen.
  failure?: string;
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
  const [attempt, setAttempt] = useState<ConnectionTestResult | null>(
    failure ? { ok: false, error: failure } : null,
  );
  const [testing, setTesting] = useState(false);
  /// How long the last successful Test took, round trip. A connection that
  /// answers in 900 ms is a VPN hop or a region away, and worth knowing
  /// before it is the one every query waits on.
  const [testMs, setTestMs] = useState<number | null>(null);
  const [showPassword, setShowPassword] = useState(false);

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
    setTestMs(null);
    const started = performance.now();
    try {
      const result = await window.overdb.invoke('conn:test', {
        ...shape(),
        // Lets main fall back to the stored password when the field was
        // left blank, which is the normal case when editing.
        id: existing?.id,
        password: secretSource === 'stored' && password ? password : undefined,
      });
      setAttempt(result);
      if (result.ok) setTestMs(Math.round(performance.now() - started));
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
    setTestMs(null);
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

  /// Read once for both the panel and the fields it blames: a fix that
  /// changes the TLS mode should also mark the TLS control, so the eye goes
  /// from the explanation to the thing it is about.
  const diagnosis = attempt && !attempt.ok
    ? diagnose({
        engine,
        error: attempt.error ?? '',
        ssl,
        secretSource: isDynamo ? undefined : secretSource,
        host,
        port: Number(port) || undefined,
        user,
        database,
      })
    : null;
  const blamed = new Set(diagnosis?.fixes.flatMap((f) => Object.keys(f.set ?? {})) ?? []);
  const blame = (key: string) => (blamed.has(key) ? ' !border-bad ring-2 ring-bad/25' : '');

  const saveDisabled =
    busy || (isSqlite && !file) || (isDynamo && !region.trim()) || !!commandError || !!tunnelError;

  return (
    <div
      className="flex flex-col min-h-0"
      onKeyDown={(e) => {
        // ⌘↵ from any field, the same chord that runs a query. The sheet
        // already owns Escape, so the two ways out are both on the keyboard.
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !saveDisabled) {
          e.preventDefault();
          void save();
        }
      }}
    >
      <div className="shrink-0 flex items-start gap-3 px-6 pt-5 pb-4 border-b border-card">
        <div className="flex-1 min-w-0">
          <h2 className="text-[15px] font-semibold text-ink">
            {editing ? 'Edit connection' : 'New connection'}
          </h2>
          {editing ? (
            <p className="mt-1 flex items-center gap-2 text-xs text-ink-muted min-w-0">
              <span className={`shrink-0 text-[9.5px] font-semibold ${TAG_TEXT[variant]}`}>
                {VARIANTS[variant].tag.toUpperCase()}
              </span>
              <span className="truncate">{existing.name}</span>
              <span className="shrink-0 text-ink-faint">· Saving reconnects its open tabs</span>
            </p>
          ) : (
            <p className="mt-1 text-xs text-ink-muted">
              Nothing is saved until you add it. New connections open read-only.
            </p>
          )}
        </div>
        <CloseButton onClick={onDone} />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-5 flex flex-col gap-5">
        {found && found.length > 0 && (
          <div>
            <span className="block text-[11px] text-ink-muted mb-1.5">Running on this machine</span>
            <div className="flex flex-wrap gap-2">
              {found.map((s) => (
                <button
                  key={`${s.engine}:${s.port}`}
                  onClick={() => applyFound(s)}
                  className="h-[30px] px-3 rounded-[5px] border border-card bg-card hover:bg-wash-strong text-[12.5px] text-ink flex items-center gap-2"
                >
                  <span className={`w-[7px] h-[7px] rounded-full ${TAG_DOT[s.engine as Variant] ?? 'bg-ink-faint'}`} />
                  {/* The version the server volunteered, not the port's
                      reputation — 3306 answering does not prove MySQL. */}
                  <span>
                    {VARIANTS[s.engine as Variant]?.label ?? s.engine}
                    {s.version ? ` ${s.version.replace(/^5\.5\.5-/, '')}` : ''}
                  </span>
                  <span className="text-ink-muted font-mono text-[11.5px]">:{s.port}</span>
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-ink-faint leading-snug">
              Found by asking each port what it is. Fills in the engine, host and port.
            </p>
          </div>
        )}

        {/* Everyone already has one of these in a .env or a runbook, and
            retyping it into six boxes is where the typo comes from. */}
        {!isDynamo && (
          <div>
            <label className="block text-[11px] text-ink-muted mb-1.5" htmlFor="conn-url">
              Paste a connection URL{' '}
              <span className="text-ink-faint">— optional, fills in the fields below</span>
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <LinkIcon />
                <input
                  id="conn-url"
                  className="field pl-8 pr-2.5 h-[30px] text-xs w-full font-mono"
                  value={urlText}
                  onChange={(e) => setUrlText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && parseConnectionUrl(urlText)) {
                      e.preventDefault();
                      applyUrl();
                    }
                  }}
                  placeholder={urlPlaceholder(variant)}
                  spellCheck={false}
                />
              </div>
              <button onClick={applyUrl} disabled={!parseConnectionUrl(urlText)} className={BTN}>
                Fill in
              </button>
            </div>
            <UrlPreview text={urlText} />
          </div>
        )}

        <Section title="Connection">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <div className="relative">
                <span className={`pointer-events-none absolute left-2.5 top-[11px] w-2 h-2 rounded-full ${TAG_DOT[variant]}`} />
                <select
                  className={`${INPUT} pl-7`}
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
                    // Except on loopback, unless you chose TLS yourself: a
                    // stock local server has none configured, so the type's
                    // verify-full default made every new local connection
                    // fail on a certificate it was never going to have.
                    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
                    if (loopback && !sslTouched) setSsl('disable');
                    else if (d.ssl) setSsl(d.ssl);
                  }}
                >
                  {VARIANT_ORDER.map((v) => (
                    <option key={v} value={v}>
                      {VARIANTS[v].label}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
            <Field label="Environment">
              <div className="relative">
                <span className={`pointer-events-none absolute left-2.5 top-[11px] w-2 h-2 rounded-full ${ENV_DOT[env]}`} />
                <select className={`${INPUT} pl-7`} value={env}
                        onChange={(e) => setEnv(e.target.value as EnvKind)}>
                  <option value="local">local</option>
                  <option value="dev">dev</option>
                  <option value="sandbox">sandbox</option>
                  <option value="staging">staging</option>
                  <option value="prod">prod</option>
                  <option value="other">other</option>
                </select>
              </div>
            </Field>
          </div>

          <Field label="Name">
            <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)}
                   placeholder="orders-db local" />
          </Field>

          {isDynamo ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Region">
                  <input className={INPUT} value={region}
                         onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" />
                </Field>
                <Field label="AWS profile">
                  <input className={INPUT} value={awsProfile}
                         onChange={(e) => setAwsProfile(e.target.value)}
                         placeholder="the usual chain" />
                </Field>
              </div>
              <label className="block">
                <span className="flex items-baseline justify-between gap-3 mb-1.5">
                  <span className="text-[11px] text-ink-muted">Tables</span>
                  <span className="text-[11px] text-ink-faint">
                    DynamoDB has no schemas — names are the only namespace
                  </span>
                </span>
                <input
                  className={`${INPUT} font-mono`}
                  value={tableFilter}
                  onChange={(e) => setTableFilter(e.target.value)}
                  placeholder="all tables — try LOCAL. or !PROD."
                />
              </label>

              <FilterPreview connectionId={existing?.id} filter={tableFilter} />

              {/* A pattern language is a LOOKUP: you come back to check one row,
                  not to read a paragraph. So it is a two-column key, not prose. */}
              <div className="rounded-md border border-card px-3 py-2.5 grid grid-cols-[104px_1fr] gap-x-3 gap-y-1.5 items-baseline">
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

              <div className="flex gap-2">
                <KeyIcon />
                <p className="text-[11px] text-ink-muted leading-snug">
                  Credentials come from your AWS setup — environment variables, an SSO session, or the
                  profile above. overdb stores nothing.
                </p>
              </div>
              {/* The filter caveat and the read-only caveat were two paragraphs
                  making one point: overdb's checks run locally and IAM is the
                  boundary. Said once, it is read; said twice, neither is. */}
              <div className="flex gap-2">
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
                <input readOnly className={`${INPUT} flex-1 font-mono`} value={file}
                       placeholder="Choose a .sqlite file…" />
                <button onClick={() => void pick()} className={BTN}>
                  Browse…
                </button>
              </div>
            </Field>
          ) : (
            <>
              <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3">
                <Field label="Host">
                  <input className={INPUT} value={host} spellCheck={false}
                         onChange={(e) => applyHost(e.target.value)} />
                </Field>
                <Field label="Port">
                  <input className={`${INPUT} font-mono${blame('port')}`} value={port} inputMode="numeric"
                         onChange={(e) => setPort(e.target.value)} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Database">
                  <input className={INPUT} value={database} spellCheck={false}
                         onChange={(e) => setDatabase(e.target.value)} />
                </Field>
                <Field label="User">
                  <input className={INPUT} value={user} spellCheck={false}
                         onChange={(e) => setUser(e.target.value)} />
                </Field>
              </div>
              {/* On MySQL a schema IS a database, and credentials.ts only
                  falls back to this when Database is blank — so it is offered
                  there only to someone who already relies on it. */}
              {(engine === 'postgres' || defaultSchema) && (
                <Field label={engine === 'postgres' ? 'Search path' : 'Default schema'}>
                  <input className={INPUT} value={defaultSchema} spellCheck={false}
                         onChange={(e) => setDefaultSchema(e.target.value)} placeholder="public" />
                </Field>
              )}
            </>
          )}
        </Section>

        {isNetworkSql && (
          <Section title="Sign-in">
            <Field label="Password from">
              <select
                className={`${INPUT}${blame('secretSource')}`}
                value={secretSource}
                onChange={(e) => {
                  setSecretSource(e.target.value as SecretSource);
                  setProbe(null);
                }}
              >
                <option value="none">Nowhere — trust or socket auth</option>
                <option value="stored">Stored password, in the OS keychain</option>
                <option value="env">Environment variable</option>
                <option value="op">1Password reference</option>
                <option value="command">Command that prints it</option>
                <option value="aws-iam">AWS IAM token — RDS, Aurora, Redshift</option>
              </select>
            </Field>

            {secretSource === 'stored' && (
              <div>
                <Field label={editing ? 'New password' : 'Password'}>
                  <div className="relative">
                    <input type={showPassword ? 'text' : 'password'} className={`${INPUT} pr-9`}
                           value={password}
                           onChange={(e) => setPassword(e.target.value)}
                           placeholder={editing ? 'Leave blank to keep the current one' : ''} />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      title={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-1 top-[3px] w-6 h-6 flex items-center justify-center rounded text-ink-muted hover:text-ink"
                    >
                      <EyeIcon off={showPassword} />
                    </button>
                  </div>
                </Field>
                {enc && !enc.encrypted ? (
                  <p className="mt-1.5 text-[11px] text-warn/90 leading-snug">
                    No OS keychain is available here, so a stored password is only base64 on disk —
                    not encrypted. Use an environment variable or 1Password instead.
                  </p>
                ) : (
                  <Note>
                    Encrypted by your OS keychain. overdb can write it and never read it back
                    {editing ? ', which is why the current one isn’t shown' : ''}.
                  </Note>
                )}
              </div>
            )}

            {secretSource === 'env' && (
              <>
                <Field label="Variable name">
                  <div className="flex gap-2">
                    <input className={`${INPUT} flex-1 font-mono`} value={envVar}
                           onChange={(e) => { setEnvVar(e.target.value); setProbe(null); }}
                           placeholder="PGPASSWORD" />
                    <button onClick={() => void runProbe()} className={BTN}>
                      Check
                    </button>
                  </div>
                </Field>
                <div>
                  <Field label="Fall back to a file (optional)">
                    <div className="flex gap-2">
                      <input className={`${INPUT} flex-1 font-mono`} value={envFile}
                             onChange={(e) => { setEnvFile(e.target.value); setProbe(null); }}
                             placeholder="~/work/orders/.env" />
                      <button onClick={() => void pickPath('envfile', setEnvFile)} className={BTN}>
                        Browse…
                      </button>
                    </div>
                  </Field>
                  <Note>
                    Read when connecting, so rotating the variable rotates the credential. An app
                    launched from the Dock doesn’t inherit your shell profile — that’s what the file
                    is for. Only its path is stored.
                  </Note>
                </div>
              </>
            )}

            {secretSource === 'command' && (
              <div>
                <Field label="Command">
                  <div className="flex gap-2">
                    <input className={`${INPUT} flex-1 font-mono`} value={commandLine}
                           onChange={(e) => { setCommandLine(e.target.value); setProbe(null); }}
                           placeholder="vault kv get -field=password secret/orders/prod"
                           spellCheck={false} />
                    <button onClick={() => void runProbe()} disabled={!commandArgv} className={BTN}>
                      Check
                    </button>
                  </div>
                </Field>
                {commandError && (
                  <p className="mt-1.5 text-[11px] text-warn/90 leading-snug">{commandError}</p>
                )}
                <Note>
                  Whatever it prints on stdout is the password — Vault, Secrets Manager,
                  <span className="font-mono"> pass</span>, or your own wrapper. It runs directly,
                  never through a shell, so pipes and <span className="font-mono">$(…)</span> are
                  refused. The command is stored in plain settings: put the <em>lookup</em> here,
                  never the secret.
                </Note>
              </div>
            )}

            {secretSource === 'aws-iam' && (
              <div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Region (optional)">
                    <input className={`${INPUT} font-mono`} value={iamRegion}
                           onChange={(e) => { setIamRegion(e.target.value); setProbe(null); }}
                           placeholder="read from the endpoint" />
                  </Field>
                  <Field label="AWS profile (optional)">
                    <div className="flex gap-2">
                      <input className={`${INPUT} flex-1`} value={iamProfile}
                             onChange={(e) => { setIamProfile(e.target.value); setProbe(null); }}
                             placeholder="the usual chain" />
                      <button onClick={() => void runProbe()} className={BTN}>
                        Check
                      </button>
                    </div>
                  </Field>
                </div>
                <Note>
                  A signed token, minted on every connect and good for fifteen minutes — nothing
                  is stored. Needs <span className="font-mono">rds-db:connect</span> on your IAM
                  principal and a database user granted <span className="font-mono">rds_iam</span>.
                  Always sent over TLS, whatever is set below: the token is a bearer credential.
                </Note>
              </div>
            )}

            {secretSource === 'op' && (
              <div>
                <Field label="Reference">
                  <div className="flex gap-2">
                    <input className={`${INPUT} flex-1 font-mono`} value={opRef}
                           onChange={(e) => { setOpRef(e.target.value); setProbe(null); }}
                           placeholder="op://Private/orders-db/password" />
                    <button onClick={() => void runProbe()} className={BTN}>
                      Check
                    </button>
                  </div>
                </Field>
                <Note>
                  Resolved with <span className="font-mono">op read</span> when connecting, using
                  your existing session. Only the reference is stored — rotate the secret in
                  1Password and nothing here changes.
                </Note>
              </div>
            )}

            {probe && (
              <p className={`-mt-1 text-[11px] ${probe.ok ? 'text-good' : 'text-bad'}`}>
                {probe.detail}
              </p>
            )}
          </Section>
        )}

        {isNetworkSql && (
          <Section title="Security">
            <div>
              <span className="block text-[11px] text-ink-muted mb-1.5" id="tls-label">TLS</span>
              <div
                role="radiogroup"
                aria-labelledby="tls-label"
                className={`grid grid-cols-4 gap-0.5 p-0.5 rounded-md border border-card bg-card${blame('ssl')}`}
              >
                {SSL_MODES.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    role="radio"
                    aria-checked={ssl === m.value}
                    onClick={() => { setSsl(m.value); setSslTouched(true); setAttempt(null); }}
                    className={`h-[26px] rounded text-xs transition-colors ${
                      ssl === m.value
                        ? 'bg-surface-elevated text-ink shadow-sm ring-1 ring-card'
                        : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <Note>{SSL_MODES.find((m) => m.value === ssl)?.hint}</Note>
            </div>

            {ssl !== 'disable' && (
              <details className="rounded-md border border-card px-3 py-2" open={!!(sslRootCert || sslCert || sslKey)}>
                <summary className="text-xs text-ink-muted cursor-pointer select-none">
                  Certificates
                  {sslRootCert || sslCert ? (
                    <span className="ml-2 text-[11px] text-good/90">
                      {sslCert ? 'client certificate' : 'custom CA'}
                    </span>
                  ) : null}
                </summary>
                <div className="mt-3 flex flex-col gap-3">
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

            <div className="rounded-md border border-card">
              <label className="flex items-center gap-3 px-3 py-2.5 cursor-pointer">
                <TerminalIcon />
                <span className="flex-1 min-w-0">
                  <span className="block text-[12.5px] text-ink">Connect through SSH</span>
                  <span className="block text-[11.5px] text-ink-muted truncate">
                    {tunnelOn && tunnelTarget.trim() ? (
                      <span className="font-mono">via {tunnelTarget.trim()}</span>
                    ) : (
                      'Tunnel via a bastion, using your own ssh and ~/.ssh/config'
                    )}
                  </span>
                </span>
                <Switch
                  checked={tunnelOn}
                  label="Connect through SSH"
                  onChange={(on) => { setTunnelOn(on); setAttempt(null); }}
                />
              </label>
              {tunnelOn && (
                <div className="border-t border-card px-3 pt-3 pb-3 flex flex-col gap-3">
                  <div className="grid grid-cols-[minmax(0,1fr)_80px] gap-3">
                    <Field label="SSH host">
                      <input className={`${INPUT} font-mono`} value={tunnelTarget}
                             onChange={(e) => { setTunnelTarget(e.target.value); setAttempt(null); }}
                             placeholder="ec2-user@bastion.example.com" spellCheck={false} />
                    </Field>
                    <Field label="Port">
                      <input className={`${INPUT} font-mono`} value={tunnelPort}
                             onChange={(e) => setTunnelPort(e.target.value)} placeholder="22" />
                    </Field>
                  </div>
                  <PathField label="Key file (optional)" value={tunnelIdentity}
                             onChange={setTunnelIdentity}
                             onBrowse={() => void pickPath('identity', setTunnelIdentity)}
                             placeholder="your agent and ~/.ssh/config" />
                  <div className="grid grid-cols-[minmax(0,1fr)_80px] gap-3">
                    <Field label="Database host, from the bastion">
                      <input className={`${INPUT} font-mono`} value={tunnelRemoteHost}
                             onChange={(e) => setTunnelRemoteHost(e.target.value)}
                             placeholder={host || 'the host above'} spellCheck={false} />
                    </Field>
                    <Field label="Port">
                      <input className={`${INPUT} font-mono`} value={tunnelRemotePort}
                             onChange={(e) => setTunnelRemotePort(e.target.value)}
                             placeholder={port || ''} />
                    </Field>
                  </div>
                  {tunnelError && (
                    <p className="text-[11px] text-warn/90 leading-snug">{tunnelError}</p>
                  )}
                  <p className="text-[11px] text-ink-faint leading-snug">
                    overdb runs your own <span className="font-mono">ssh</span>, so aliases,
                    ProxyJump and your agent all apply, and no private key is handled here. It won’t
                    answer a passphrase or accept an unknown host key for you: if{' '}
                    <span className="font-mono">ssh {tunnelTarget.trim() || '<host>'}</span> works
                    in a terminal, this works. The forwarded port is bound to 127.0.0.1 only.
                  </p>
                </div>
              )}
            </div>
          </Section>
        )}
      </div>

      {/* Pinned with the buttons rather than scrolled with the fields: it is
          the answer to the button just pressed, so it appears where the eye
          already is. */}
      {attempt && !attempt.ok && diagnosis && (
        <Diagnosis
          diagnosis={diagnosis}
          error={attempt.error}
          onFix={applyFix}
          onDismiss={() => setAttempt(null)}
        />
      )}

      <div className="shrink-0 border-t border-card bg-surface-muted/60 px-6 py-3 flex items-center gap-2.5">
        {/* Test sits apart from the two decision buttons: it changes
            nothing, and pressing it should never feel like committing. */}
        <button onClick={() => void test()} disabled={testing || busy || !!commandError || !!tunnelError}
                className={BTN}>
          Test
        </button>
        <TestStatus
          testing={testing}
          busy={busy}
          attempt={attempt}
          ms={testMs}
          label={VARIANTS[attempt?.variant ?? variant].label}
        />
        <div className="flex-1" />
        {editing && (
          <button onClick={() => void duplicate()} disabled={testing || busy}
                  title="Save these settings as a new connection, leaving this one unchanged"
                  className="h-[30px] px-2.5 rounded-[5px] text-[12.5px] text-ink-muted hover:text-ink hover:bg-card disabled:opacity-40">
            Duplicate
          </button>
        )}
        <button onClick={onDone} className={BTN}>
          Cancel
        </button>
        <button onClick={() => void save()} disabled={saveDisabled} className={PRIMARY} title="⌘↵">
          {busy ? 'Connecting…' : editing ? 'Save & reconnect' : 'Add & connect'}
          {/* Only where it fits: editing adds Duplicate to the same row. */}
          {!busy && !editing && <span className="text-[11px] opacity-70">⌘↵</span>}
        </button>
      </div>
    </div>
  );
}

const INPUT = 'field px-2.5 h-[30px] text-[12.5px] w-full';
const BTN =
  'h-[30px] px-3 rounded-[5px] border border-card bg-card hover:bg-wash-strong text-[12.5px] text-ink disabled:opacity-40 inline-flex items-center gap-1.5 shrink-0';
/// accent-strong, not accent: white on the dark theme's accent is 3.9:1,
/// under the 4.5 a button label needs. The strong step clears it on both.
const PRIMARY =
  'h-[30px] px-3 rounded-[5px] bg-accent-strong hover:bg-accent-strong/90 text-white text-[12.5px] font-medium disabled:opacity-40 inline-flex items-center gap-2 shrink-0';

const SSL_MODES: { value: SslMode; label: string; hint: string }[] = [
  { value: 'disable', label: 'Off', hint: 'Unencrypted. Fine for localhost; anywhere else, traffic crosses the network in the clear.' },
  { value: 'require', label: 'Require', hint: 'Encrypted, but the server’s certificate is not checked.' },
  { value: 'verify-ca', label: 'Verify CA', hint: 'Encrypted, and the certificate chain is checked — but not the hostname.' },
  { value: 'verify-full', label: 'Verify full', hint: 'Encrypted, and the certificate must be valid for this exact host.' },
];

/// The example URL speaks the dialect of the type already chosen: a
/// postgres:// placeholder over a MySQL form reads like the form is wrong.
function urlPlaceholder(variant: Variant): string {
  const port = variantDefaults(variant).port;
  switch (variant) {
    case 'sqlite':
      return 'sqlite:///path/to/orders.db';
    case 'redshift':
      return `redshift://user:pass@cluster.redshift.amazonaws.com:${port}/dev`;
    case 'cockroach':
      return `cockroachdb://user:pass@host:${port}/orders?sslmode=verify-full`;
    case 'mariadb':
      return `mariadb://user:pass@host:${port}/orders`;
    case 'mysql':
    case 'aurora-mysql':
      return `mysql://user:pass@host:${port}/orders`;
    default:
      return `postgres://user:pass@host:${port}/orders?sslmode=require`;
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-muted">{title}</h3>
        <span className="flex-1 h-px bg-rule" />
      </div>
      {children}
    </section>
  );
}

/// What Test (or a failed Save) came back with, in a word, next to the
/// button that asked. The detail, when there is any, is in the panel above.
function TestStatus({
  testing,
  busy,
  attempt,
  ms,
  label,
}: {
  testing: boolean;
  busy: boolean;
  attempt: ConnectionTestResult | null;
  ms: number | null;
  label: string;
}): JSX.Element | null {
  if (testing) {
    return (
      <span role="status" className="flex items-center gap-1.5 text-xs text-ink-muted">
        <Spinner /> Testing…
      </span>
    );
  }
  if (busy || !attempt) return null;
  if (attempt.ok) {
    const version = attempt.serverVersion?.split(/\s+on\s+|,/)[0];
    return (
      <span role="status" className="flex items-center gap-1.5 min-w-0 text-xs text-good"
            title={attempt.serverVersion ?? label}>
        <CheckIcon />
        <span className="whitespace-nowrap">Connected</span>
        <span className="truncate font-mono text-[11.5px] text-ink-muted">
          {version ?? label}
          {ms != null ? ` · ${ms} ms` : ''}
        </span>
      </span>
    );
  }
  return (
    <span role="status" className="flex items-center gap-1.5 min-w-0 text-xs text-bad" title="Couldn’t connect — the reason is above">
      <CrossIcon /> <span className="truncate">Failed</span>
    </span>
  );
}

/// The outcome of a failed attempt, and what to do about it.
///
/// A driver error alone is a dead end for anyone who did not write the
/// driver: "no pg_hba.conf entry for host ..., SSL off" is Redshift saying
/// "turn on TLS", and says so nowhere. The message is still here — it is
/// the ground truth, and someone will paste it into a ticket — but folded
/// UNDER the sentence that explains it and the buttons that fix it.
function Diagnosis({
  diagnosis: d,
  error,
  onFix,
  onDismiss,
}: {
  diagnosis: ReturnType<typeof diagnose>;
  error?: string;
  onFix(fix: ConnectFix): void;
  onDismiss(): void;
}): JSX.Element {
  const actionable = d.fixes.filter((f) => f.set);
  const advice = d.fixes.filter((f) => !f.set);
  return (
    <div role="alert"
         className="shrink-0 mx-4 mb-3 max-h-[40%] overflow-y-auto rounded-lg border border-bad/30 bg-bad/5 px-3.5 py-3 flex flex-col gap-2.5">
      <div className="flex items-start gap-2.5">
        <AlertIcon />
        <p className="flex-1 text-[12.5px] font-semibold text-bad-strong leading-snug">{d.cause}</p>
        <button onClick={onDismiss} aria-label="Dismiss"
                className="shrink-0 -mt-0.5 w-5 h-5 flex items-center justify-center rounded text-ink-muted hover:text-ink">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor"
               strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {/* The likeliest fix first, as a button; the alternatives after it
          as a line of links. Five equal buttons for "where should the
          password come from" read as five things to do. */}
      {actionable.length > 0 && (
        <div className="pl-[26px] flex flex-col gap-1.5">
          <div className="flex flex-wrap gap-2">
            {actionable.slice(0, actionable.length > 2 ? 1 : 2).map((fix) => (
              <button key={fix.label} onClick={() => onFix(fix)} title={fix.detail}
                      className="h-7 px-2.5 rounded-[5px] border border-card bg-surface-elevated hover:bg-card text-xs text-ink">
                {fix.label}
              </button>
            ))}
          </div>
          {actionable.length > 2 && (
            <p className="text-[11.5px] text-ink-muted leading-relaxed">
              Or:{' '}
              {actionable.slice(1).map((fix, i) => (
                <span key={fix.label}>
                  {i > 0 && <span className="text-ink-faint"> · </span>}
                  <button onClick={() => onFix(fix)} title={fix.detail}
                          className="text-accent hover:underline">
                    {fix.label.charAt(0).toLowerCase() + fix.label.slice(1)}
                  </button>
                </span>
              ))}
            </p>
          )}
        </div>
      )}

      {/* No `set` means the remedy is outside this dialog — a VPN, a GRANT,
          an IAM policy. Shown, but not as a button that would do nothing. */}
      {advice.length > 0 && (
        <ul className="pl-[26px] flex flex-col gap-1.5">
          {advice.map((fix) => (
            <li key={fix.label} className="text-[11.5px] leading-snug">
              <span className="text-ink">{/[.?!]$/.test(fix.label) ? fix.label : `${fix.label}.`}</span>{' '}
              <span className="text-ink-muted">{fix.detail}</span>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <details className="pl-[26px]">
          <summary className="text-[11px] text-ink-muted cursor-pointer select-none">Driver message</summary>
          <p className="mt-1.5 font-mono text-[10.5px] text-ink-muted leading-snug break-words select-text">
            {error}
          </p>
        </details>
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
        <input className={`${INPUT} flex-1 font-mono`} value={value}
               onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
               spellCheck={false} />
        <button onClick={onBrowse} className={BTN}>
          Browse…
        </button>
        {value && (
          <button onClick={() => onChange('')} title="Clear" aria-label="Clear"
                  className={`${BTN} text-ink-muted`}>
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
      <p className="mt-1.5 text-[11px] text-ink-faint leading-snug">
        Not a connection URL yet — postgres://, mysql://, or a jdbc: one.
      </p>
    );
  }
  return (
    <p className="mt-1.5 text-[11px] text-ink-muted leading-snug">
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
    <label className="block min-w-0">
      <span className="block text-[11px] text-ink-muted mb-1.5">{label}</span>
      {children}
    </label>
  );
}

function Note({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="mt-1.5 text-[11px] text-ink-muted leading-snug">{children}</p>;
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
    <div className="rounded-md border border-card px-2.5 py-2">
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

function CloseButton({ onClick }: { onClick(): void }): JSX.Element {
  return (
    <button onClick={onClick} aria-label="Close" title="Close (Esc)"
            className="shrink-0 -mr-1.5 w-7 h-7 flex items-center justify-center rounded-[5px] text-ink-muted hover:text-ink hover:bg-card">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
           strokeWidth="1.6" strokeLinecap="round" aria-hidden>
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  );
}

/// A checkbox that looks like what it is — on or off, taking effect at
/// once — rather than a tick that reads as "include this".
function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange(on: boolean): void;
  label: string;
}): JSX.Element {
  return (
    <span className="relative shrink-0 inline-flex">
      <input type="checkbox" role="switch" aria-label={label} checked={checked}
             onChange={(e) => onChange(e.target.checked)}
             className="peer absolute inset-0 opacity-0 cursor-pointer" />
      <span className={`w-[30px] h-[18px] rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent/60 ${
        checked ? 'bg-accent-strong' : 'bg-wash-strong border border-card'
      }`} />
      <span className={`pointer-events-none absolute top-[3px] w-3 h-3 rounded-full bg-white shadow transition-transform ${
        checked ? 'translate-x-[15px]' : 'translate-x-[3px]'
      }`} />
    </span>
  );
}

function LinkIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" aria-hidden
         className="pointer-events-none absolute left-2.5 top-2 text-ink-faint">
      <path d="M6.5 9.5l3-3M7 4.5l1-1a3 3 0 014.2 4.2l-1 1M9 11.5l-1 1a3 3 0 01-4.2-4.2l1-1" />
    </svg>
  );
}

function EyeIcon({ off }: { off: boolean }): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
      {off && <path d="M2.5 13.5l11-11" />}
    </svg>
  );
}

function TerminalIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden
         className="shrink-0 text-ink-muted">
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
      <path d="M4.5 6.5l2 1.5-2 1.5M8.5 10h3" />
    </svg>
  );
}

function CheckIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

function CrossIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" aria-hidden className="shrink-0">
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </svg>
  );
}

function AlertIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.6" strokeLinecap="round" aria-hidden className="shrink-0 mt-px text-bad">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.8v3.8M8 11.2v.01" />
    </svg>
  );
}

function Spinner(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden className="animate-spin">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
