// TLS options, from the four controls the connection form owns.
//
// Shared by the Postgres and MySQL adapters. node-postgres hands this
// object straight to `tls.connect`; mysql2 reads part of it and substitutes
// its own hostname check, which is exactly the kind of difference that two
// copies of this logic would get wrong in one of them — see `verifyIdentity`
// below.
//
// The four modes, and what each actually promises:
//
//   disable      No TLS. The password crosses the wire in the clear.
//   require      Encrypted, and NOTHING is verified. This is the mode
//                everyone reaches for, and it stops eavesdropping while
//                doing nothing at all about an active attacker: any
//                certificate is accepted, including one minted five
//                seconds ago by whoever is in the middle.
//   verify-ca    The chain is verified; the hostname is not. The right
//                answer when the endpoint is an IP, a CNAME, or a tunnel's
//                local port, and the certificate names something else.
//   verify-full  Chain and hostname. The only mode that is proof against
//                an active attacker, and the reason `sslRootCert` exists:
//                against a private CA, verify-full without a root to trust
//                cannot succeed, which is how people end up on `require`
//                permanently.
//
// The tunnel case is the one worth being careful about. When a connection
// goes through an SSH bastion, the adapter dials 127.0.0.1 — so hostname
// verification would compare the certificate against "127.0.0.1" and fail,
// and the user would downgrade to `require` to get moving. `tlsServerName`
// carries the REAL hostname for verification while the socket goes to the
// forwarded port, which keeps verify-full available through a tunnel.

import fs from 'node:fs';
import os from 'node:os';
import { expandHome } from '../shared/argv';
import type { ConnectSpec } from './adapter';

export interface TlsOptions {
  rejectUnauthorized: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  /// Read by node-postgres, which passes this object to `tls.connect`.
  servername?: string;
  checkServerIdentity?: () => undefined;
  /// mysql2's own flag, and the reason this function has to know which
  /// engine it is configuring. mysql2 does NOT pass `checkServerIdentity`
  /// through: it installs its own, checking the hostname only when
  /// `verifyIdentity` is set. Omitting it means chain-only verification —
  /// correct for verify-ca, and a silent downgrade for verify-full.
  verifyIdentity?: boolean;
}

/// Read a file the user pointed at, failing with a sentence that names the
/// path. Never includes any of the CONTENT in the error: a mangled key file
/// must not put key material into a message bound for the window.
function readPem(raw: string, what: string): string {
  // `~/certs/ca.pem` is what people type, and nothing here is a shell, so
  // the expansion has to happen somewhere. Better here than as an ENOENT
  // naming a path that plainly exists.
  const path = expandHome(raw.trim(), os.homedir());
  try {
    return fs.readFileSync(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      code === 'ENOENT'
        ? `TLS: the ${what} file was not found at ${path}.`
        : code === 'EACCES'
          ? `TLS: overdb is not allowed to read the ${what} file at ${path}.`
          : `TLS: could not read the ${what} file at ${path}.`,
    );
  }
}

/// `undefined` means "no TLS", which is what both drivers expect for off.
export function tlsOptions(spec: ConnectSpec): TlsOptions | undefined {
  if (!spec.ssl || spec.ssl === 'disable') {
    // A client certificate with TLS off is a contradiction, and silently
    // ignoring it would leave someone believing they were authenticating
    // with it.
    if (spec.sslCert || spec.sslKey) {
      throw new Error(
        'TLS: a client certificate was configured but SSL is set to Disable. A certificate can ' +
          'only be presented over TLS — set SSL to Require or higher.',
      );
    }
    return undefined;
  }

  const verify = spec.ssl === 'verify-ca' || spec.ssl === 'verify-full';
  const options: TlsOptions = { rejectUnauthorized: verify };

  if (spec.sslRootCert) options.ca = readPem(spec.sslRootCert, 'CA certificate');
  if (spec.sslCert) options.cert = readPem(spec.sslCert, 'client certificate');
  if (spec.sslKey) options.key = readPem(spec.sslKey, 'client key');
  if (spec.sslCert && !spec.sslKey) {
    throw new Error('TLS: a client certificate was given without its private key.');
  }
  if (spec.sslKey && !spec.sslCert) {
    throw new Error('TLS: a client key was given without its certificate.');
  }

  if (verify) {
    // Verify against the name the user typed, not the address the socket
    // happens to reach — see the tunnel note in this file's header.
    const name = spec.tlsServerName ?? spec.host;
    if (name) options.servername = name;
    if (spec.ssl === 'verify-ca') {
      // Node has no flag for "chain yes, hostname no". Returning undefined
      // from checkServerIdentity is how you say the identity is acceptable;
      // chain verification has already happened by then and is unaffected.
      options.checkServerIdentity = () => undefined;
    }
  }

  if (spec.engine === 'mysql') {
    options.verifyIdentity = spec.ssl === 'verify-full';
    // mysql2 verifies the hostname against the address it dialled and gives
    // no way to say otherwise, so through a tunnel it would compare the
    // certificate to 127.0.0.1 — and, because it skips the check entirely
    // for an IP, it would not fail. It would quietly not verify. A silent
    // downgrade from the mode the user chose is the one outcome worth
    // refusing outright.
    if (spec.ssl === 'verify-full' && spec.tlsServerName && spec.tlsServerName !== spec.host) {
      throw new Error(
        'TLS: MySQL cannot do Verify full through an SSH tunnel — its driver checks the ' +
          'certificate against the address it connects to, which is the local end of the tunnel. ' +
          'Use Verify CA, which still checks the chain, or connect without the tunnel.',
      );
    }
  }

  return options;
}
