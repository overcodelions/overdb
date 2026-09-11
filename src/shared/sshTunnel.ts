// The SSH tunnel: what it is, and the exact argv that opens it.
//
// Most prod databases are only reachable through a bastion, and overdb
// diagnoses that today ("a tunnel/port-forward that is not running") while
// being unable to do anything about it. This closes that.
//
// The implementation choice worth defending is that overdb drives the
// SYSTEM `ssh` binary rather than embedding an SSH library. Three reasons,
// and the third is the important one:
//
//   1. `~/.ssh/config` already works — Host aliases, ProxyJump, IdentityFile,
//      certificates, hardware keys. A library reimplements a fraction of
//      that and gets the corner cases wrong.
//   2. The agent, and therefore Touch ID / YubiKey confirmation, already
//      works.
//   3. **overdb never handles the private key.** No passphrase to prompt
//      for, no key material in our process, nothing new to store. The
//      strongest credential on the machine stays where ssh keeps it.
//
// This module is pure so the argv can be asserted in a test without
// spawning anything; src/main/tunnel.ts owns the process.

export interface SshTunnel {
  /// `user@bastion`, or a Host alias out of ~/.ssh/config.
  target: string;
  /// The bastion's SSH port, when it is not 22.
  port?: number;
  /// An explicit key file. Usually unnecessary — ~/.ssh/config and the
  /// agent normally answer this — and offered because "usually" is not
  /// "always".
  identityFile?: string;
  /// Where the database is reachable FROM THE BASTION. Defaults to the
  /// connection's own host and port, which is right whenever the bastion
  /// resolves the same name you do.
  remoteHost?: string;
  remotePort?: number;
}

/// Everything ssh accepts as a destination, and nothing that could be read
/// as an option. The leading-dash check is the one that matters: `ssh` is
/// spawned as argv with no shell, so the only injection left is an
/// argument that ssh itself treats as a flag — and `-oProxyCommand=…` is
/// arbitrary code execution. A hostname never starts with a dash.
const SAFE_TARGET = /^[A-Za-z0-9_](?:[A-Za-z0-9._%+-]*)?(?:@[A-Za-z0-9_][A-Za-z0-9._:-]*)?$/;
const SAFE_HOST = /^[A-Za-z0-9_][A-Za-z0-9._:-]*$/;

export function validateTunnel(t: SshTunnel): string | null {
  const target = t.target?.trim() ?? '';
  if (!target) return 'An SSH host is required — user@bastion, or a Host alias from ~/.ssh/config.';
  if (target.startsWith('-')) return 'An SSH host cannot start with a dash.';
  if (!SAFE_TARGET.test(target)) {
    return 'That does not look like user@host or a Host alias. Only letters, digits and . _ - % + @ are accepted.';
  }
  if (t.port !== undefined && (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535)) {
    return 'The SSH port must be between 1 and 65535.';
  }
  if (t.remoteHost && (t.remoteHost.startsWith('-') || !SAFE_HOST.test(t.remoteHost))) {
    return 'The database host as seen from the bastion is not a valid hostname.';
  }
  if (t.remotePort !== undefined && (!Number.isInteger(t.remotePort) || t.remotePort < 1 || t.remotePort > 65535)) {
    return 'The database port must be between 1 and 65535.';
  }
  if (t.identityFile && t.identityFile.trim().startsWith('-')) {
    return 'A key file path cannot start with a dash.';
  }
  return null;
}

/// The forward, as argv.
///
/// Every option here is load-bearing:
///   -N -T            no shell, no command — a forward and nothing else.
///   BatchMode=yes    never prompt. A prompt in a GUI app is an invisible
///                    hang; a failure is a message the form can explain.
///                    This also makes an unknown host key an ERROR rather
///                    than a silent trust-on-first-use, which is the right
///                    answer for a machine you are about to send a
///                    production password through.
///   ExitOnForwardFailure  without it, ssh connects happily with no
///                    forward and the database connection fails with a
///                    misleading ECONNREFUSED on localhost.
///   ClearAllForwardings   drops any LocalForward the user's ssh_config
///                    attaches to this host, so the only forward open is
///                    the one asked for here.
///   127.0.0.1 bind   the forwarded port is reachable from this machine
///                    only. A bare `-L port:` binds every interface and
///                    quietly publishes the production database to the
///                    coffee shop wifi.
export function tunnelArgv(
  t: SshTunnel,
  localPort: number,
  fallback: { host: string; port: number },
): string[] {
  const remoteHost = t.remoteHost?.trim() || fallback.host;
  const remotePort = t.remotePort ?? fallback.port;
  const argv = [
    '-N',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ConnectTimeout=15',
    // A dead bastion should end the tunnel rather than leave a local port
    // open onto nothing, which reads as a database that stopped answering.
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-L', `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`,
  ];
  if (t.port) argv.push('-p', String(t.port));
  if (t.identityFile?.trim()) argv.push('-i', t.identityFile.trim(), '-o', 'IdentitiesOnly=yes');
  // `--` is not accepted by ssh, so the destination's validity is enforced
  // by validateTunnel above rather than by a separator.
  argv.push(t.target.trim());
  return argv;
}

/// ssh's own diagnostics, turned into the sentence for this form. The raw
/// stderr is still shown underneath — see ConnectionForm's Attempt panel.
export function explainSshFailure(stderr: string): string | null {
  const e = stderr;
  if (/Host key verification failed/i.test(e)) {
    return (
      'The bastion is not in your known_hosts, and overdb will not accept a new host key on your ' +
      "behalf. Run `ssh " + '<host>' + '` once in a terminal, check the fingerprint, then try again.'
    );
  }
  if (/Permission denied|no such identity|Too many authentication failures/i.test(e)) {
    return (
      'The bastion refused your key. overdb never prompts for a passphrase — it uses your agent — ' +
      'so an unloaded key looks exactly like this. `ssh-add` it and try again.'
    );
  }
  if (/Could not resolve hostname/i.test(e)) return 'That bastion hostname does not resolve from this machine.';
  if (/Operation timed out|Connection timed out/i.test(e)) return 'The bastion did not answer before the timeout.';
  if (/Connection refused/i.test(e)) return 'Nothing is listening for SSH on the bastion.';
  if (/remote port forwarding failed|channel .*open failed|administratively prohibited/i.test(e)) {
    return 'The bastion accepted the login but refused the forward — it may not permit port forwarding.';
  }
  return null;
}
