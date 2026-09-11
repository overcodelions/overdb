// What a failed connection attempt actually means, and what to change.
//
// A driver error is written for the person who wrote the driver: "no
// pg_hba.conf entry for host ... no encryption" is precise and tells you
// nothing about which control in front of you is wrong. This turns that
// string into a sentence about THIS form plus, where the remedy is a field
// we own, a fix the form can apply.
//
// Pure and engine-agnostic on purpose: it takes the message and the draft's
// own settings, so it can be tested against real driver strings without a
// database (src/shared/connectDiagnosis.test.ts) and reused by the CLI.

import type { Engine, SecretSource, SslMode } from './types';

/// A change to the form the user can accept with one click. `set` is a
/// patch over the fields this dialog owns; a fix with no `set` is advice
/// about something outside overdb (a VPN, an IAM policy, a GRANT).
export interface ConnectFix {
  label: string;
  detail: string;
  set?: { ssl?: SslMode; secretSource?: SecretSource; port?: number };
}

export interface ConnectDiagnosis {
  /// One sentence, in the user's terms, about what went wrong.
  cause: string;
  fixes: ConnectFix[];
}

export interface DiagnosisInput {
  engine: Engine;
  /// The driver's own message, verbatim.
  error: string;
  ssl?: SslMode;
  secretSource?: SecretSource;
  user?: string;
  host?: string;
  port?: number;
  database?: string;
}

const DEFAULT_PORT: Partial<Record<Engine, number>> = { postgres: 5432, mysql: 3306 };

const REQUIRE_SSL: ConnectFix = {
  label: 'Set SSL to Require',
  detail: 'Encrypts the connection without checking the server certificate.',
  set: { ssl: 'require' },
};

const RELAX_SSL: ConnectFix = {
  label: 'Set SSL to Require',
  detail:
    'Still encrypted, but stops verifying the certificate — the usual answer for a ' +
    'self-signed or internal CA you have no root for.',
  set: { ssl: 'require' },
};

/// The honest fix for a private CA, as opposed to the convenient one.
/// Offered above RELAX_SSL wherever the failure is a chain that did not
/// verify: `require` is one click and gives up authentication of the
/// server, and a great many connections stay there forever because it was
/// the only button on offer.
const TRUST_CA: ConnectFix = {
  label: 'Point at the CA that signed it',
  detail:
    'Set the CA certificate under SSL. Verification then succeeds against your own root instead ' +
    'of being switched off — the difference between encrypted and encrypted-to-the-right-server.',
};

const VERIFY_CA: ConnectFix = {
  label: 'Set SSL to Verify CA',
  detail:
    'Checks the certificate chain but not the hostname — the answer when the endpoint is an IP, ' +
    'a CNAME, or a tunnel, and the certificate names the server itself.',
  set: { ssl: 'verify-ca' },
};

const DISABLE_SSL: ConnectFix = {
  label: 'Set SSL to Disable',
  detail: 'This server is not offering TLS at all.',
  set: { ssl: 'disable' },
};

/// The places a password can come from, minus the one already chosen.
/// Offered whenever the server said the credential was wrong or missing:
/// at that point the question is not "is the password right" but "is this
/// where the password is coming from".
function otherSources(current: SecretSource | undefined): ConnectFix[] {
  const all: Array<{ source: SecretSource; label: string; detail: string }> = [
    {
      source: 'stored',
      label: 'Use a password stored in the OS keychain',
      detail: 'Type it once; it is encrypted by the keychain and never read back into this window.',
    },
    {
      source: 'env',
      label: 'Read it from an environment variable',
      detail:
        "Rotating the variable rotates the credential. A GUI app launched from the Dock does " +
        'not inherit your shell profile, so check the variable is set for overdb itself.',
    },
    {
      source: 'op',
      label: 'Resolve it from a 1Password reference',
      detail: 'Run `op read` at connect time using your existing session. Only the reference is stored.',
    },
    {
      source: 'command',
      label: 'Run a command that prints it',
      detail:
        'Vault, Secrets Manager, `pass`, or your own wrapper — anything that writes the password to ' +
        'stdout. Only the command is stored, and it is run directly rather than through a shell.',
    },
    {
      source: 'aws-iam',
      label: 'Mint an AWS IAM token',
      detail:
        'RDS, Aurora and Redshift can accept a signed 15-minute token instead of a password. ' +
        'Nothing is stored at all, and the connection is encrypted whether or not you asked.',
    },
    {
      source: 'none',
      label: 'Send no password at all',
      detail: 'For trust or socket authentication, where the server identifies you some other way.',
    },
  ];
  return all
    .filter((s) => s.source !== (current ?? 'none'))
    .map((s) => ({ label: s.label, detail: s.detail, set: { secretSource: s.source } }));
}

export function diagnose(input: DiagnosisInput): ConnectDiagnosis {
  const e = input.error ?? '';
  const where = `${input.host ?? 'the host'}:${input.port ?? '?'}`;

  // --- Reaching the server at all -------------------------------------
  if (/ENOTFOUND|getaddrinfo/i.test(e)) {
    return {
      cause: `${input.host ?? 'That hostname'} does not resolve from this machine.`,
      fixes: [
        { label: 'Check the host name', detail: 'A typo, or a name that only resolves inside a VPN or private zone you are not on.' },
      ],
    };
  }
  if (/ECONNREFUSED/i.test(e)) {
    const fixes: ConnectFix[] = [
      { label: 'Check the host and port', detail: `Nothing accepted a connection on ${where}.` },
    ];
    const standard = DEFAULT_PORT[input.engine];
    if (standard && input.port !== standard) {
      fixes.unshift({
        label: `Try port ${standard}`,
        detail: `The standard ${input.engine === 'mysql' ? 'MySQL' : 'Postgres'} port.`,
        set: { port: standard },
      });
    }
    fixes.push({
      label: 'Is it reachable from here?',
      detail: 'A local server that is stopped, or a tunnel/port-forward that is not running.',
    });
    return { cause: `Nothing is listening on ${where}.`, fixes };
  }
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timeout|timed out/i.test(e)) {
    return {
      cause: `${where} accepted nothing before the timeout — the packets are being dropped, not refused.`,
      fixes: [
        { label: 'Check the network path', detail: 'Typically a firewall or security group that does not allow this address, or a VPN that is not connected.' },
      ],
    };
  }

  // --- TLS -------------------------------------------------------------
  // Order matters: these all also LOOK like connection failures.
  if (/no pg_hba\.conf entry/i.test(e) && /no encryption/i.test(e)) {
    return {
      cause: 'The server refuses unencrypted connections from this address.',
      fixes: [REQUIRE_SSL],
    };
  }
  if (/SSL connection is required|Connections using insecure transport are prohibited|server does not allow.*non-SSL/i.test(e)) {
    return { cause: 'This server requires TLS.', fixes: [REQUIRE_SSL] };
  }
  if (/server does not support SSL|does not support SSL connections|SSL is not enabled/i.test(e)) {
    return { cause: 'The server does not offer TLS, and this connection is set to demand it.', fixes: [DISABLE_SSL] };
  }
  if (/self.signed certificate|unable to verify the first certificate|unable to get local issuer|CERT_|certificate has expired|Hostname\/IP does not match|altnames/i.test(e)) {
    return {
      cause:
        input.ssl === 'verify-full'
          ? "The server's certificate did not verify against this machine's trust store."
          : "The server's certificate was rejected.",
      fixes: /Hostname\/IP does not match|altnames/i.test(e)
        ? // The chain is fine; the NAME is wrong. Dropping to `require`
          // would throw away the verification that just worked.
          [VERIFY_CA, RELAX_SSL]
        : [TRUST_CA, VERIFY_CA, RELAX_SSL],
    };
  }

  // --- Who you are -----------------------------------------------------
  if (/password authentication failed|Access denied for user|ER_ACCESS_DENIED_ERROR|authentication failed for user/i.test(e)) {
    const sentNothing = /using password: NO/i.test(e) || (input.secretSource ?? 'none') === 'none';
    return {
      cause: sentNothing
        ? `The server wants a password for ${input.user ?? 'this user'} and none was sent.`
        : `The server rejected the password for ${input.user ?? 'this user'}.`,
      fixes: [
        ...(sentNothing
          ? []
          : [
              {
                label: 'Check the user name',
                detail: 'Both halves are rejected the same way — a wrong user reads exactly like a wrong password.',
              },
            ]),
        ...otherSources(input.secretSource),
      ],
    };
  }
  if (/SASL.*password must be a string|client password must be a string|no password supplied/i.test(e)) {
    return {
      cause: 'The chosen source produced no password, so nothing was sent.',
      fixes: [
        {
          label: 'Check the source resolves',
          detail:
            input.secretSource === 'env'
              ? 'Use Check next to the variable name. A GUI app launched from the Dock does not inherit your shell profile.'
              : input.secretSource === 'op'
                ? 'Use Check next to the reference — an expired `op` session fails here.'
                : 'This connection has no password set for the source it names.',
        },
        ...otherSources(input.secretSource),
      ],
    };
  }
  if (/ER_NOT_SUPPORTED_AUTH_MODE|Client does not support authentication protocol/i.test(e)) {
    return {
      cause: "This account uses MySQL's caching_sha2_password, which needs an encrypted connection before it will send the password.",
      fixes: [
        REQUIRE_SSL,
        { label: 'Or change the account', detail: 'ALTER USER … IDENTIFIED WITH mysql_native_password, if TLS is not available.' },
      ],
    };
  }
  if (/no pg_hba\.conf entry/i.test(e)) {
    return {
      cause: 'The server has no rule permitting this user, from this address, to this database.',
      fixes: [
        REQUIRE_SSL,
        { label: 'Ask for a pg_hba rule', detail: 'The address you connect from must be listed server-side; nothing in this form can grant that.' },
        ...otherSources(input.secretSource),
      ],
    };
  }
  if (/ER_HOST_NOT_PRIVILEGED|is not allowed to connect to this/i.test(e)) {
    return {
      cause: 'The server does not accept connections from this address for this account.',
      fixes: [{ label: 'Needs a server-side grant', detail: "MySQL scopes accounts by host — 'user'@'%' or your address must exist." }],
    };
  }

  // --- Wrong thing, right server ---------------------------------------
  if (/role "?([^"\s]+)"? does not exist/i.test(e)) {
    return {
      cause: `The server has no role named ${input.user ?? 'that'}.`,
      fixes: [{ label: 'Check the user name', detail: 'Postgres roles are case-sensitive when they were created quoted.' }],
    };
  }
  if (/database "?([^"\s]+)"? does not exist|ER_BAD_DB_ERROR|Unknown database/i.test(e)) {
    return {
      cause: `${input.database ? `There is no database named ${input.database}` : 'That database does not exist'} on this server.`,
      fixes: [{ label: 'Check the database name', detail: 'Authentication succeeded — this is the right server, with the wrong database.' }],
    };
  }

  // --- Engines that authenticate elsewhere -----------------------------
  if (input.engine === 'dynamodb') {
    if (/Could not load credentials|CredentialsProviderError|credential/i.test(e)) {
      return {
        cause: 'The AWS provider chain produced no credentials for this profile.',
        fixes: [
          { label: 'Sign in to AWS', detail: 'aws sso login --profile <name>, or set the usual environment variables — overdb stores no AWS credential of its own.' },
          { label: 'Check the profile name', detail: 'It must exist in ~/.aws/config or ~/.aws/credentials. Blank uses the default chain.' },
        ],
      };
    }
    if (/ExpiredToken|token.*expired|InvalidClientTokenId|UnrecognizedClientException|security token/i.test(e)) {
      return {
        cause: 'The AWS session for this profile has expired.',
        fixes: [{ label: 'Refresh the session', detail: 'aws sso login --profile <name>, then test again.' }],
      };
    }
    if (/AccessDenied|not authorized to perform/i.test(e)) {
      return {
        cause: 'These credentials are valid but not allowed to list tables in this region.',
        fixes: [{ label: 'Needs an IAM policy', detail: 'dynamodb:ListTables and DescribeTable on this account and region.' }],
      };
    }
    if (/UnknownEndpoint|Inaccessible host|region/i.test(e)) {
      return {
        cause: 'That region name did not resolve to a DynamoDB endpoint.',
        fixes: [{ label: 'Check the region', detail: 'It is an id like us-east-1, not a display name.' }],
      };
    }
  }
  if (input.engine === 'sqlite' && /SQLITE_CANTOPEN|unable to open database|no such file/i.test(e)) {
    return {
      cause: 'The file could not be opened.',
      fixes: [{ label: 'Choose the file again', detail: 'It may have moved, or live somewhere this app is not permitted to read.' }],
    };
  }
  if (/^SSH tunnel:/i.test(e)) {
    return {
      cause: 'The SSH tunnel did not come up, so the database was never reached.',
      fixes: [
        {
          label: 'Try the same hop by hand',
          detail:
            'overdb runs your own ssh with BatchMode on: if `ssh <host>` works in a terminal and this ' +
            'does not, the difference is a passphrase prompt or an unknown host key — neither of which ' +
            'overdb will answer for you.',
        },
        {
          label: 'Check what the bastion can reach',
          detail:
            'The database host and port in the tunnel section are resolved ON the bastion, not here. ' +
            'Blank means "the same host this connection names".',
        },
      ],
    };
  }
  if (/^Command:/i.test(e)) {
    return {
      cause: 'The command that produces the password did not.',
      fixes: [
        {
          label: 'Check it runs from a GUI app',
          detail:
            'Use Check next to the command. A Dock launch inherits neither your shell PATH nor a ' +
            'session your login shell established — an unauthenticated `vault` or an expired `aws` ' +
            'session fails exactly here.',
        },
        ...otherSources(input.secretSource),
      ],
    };
  }
  if (/^Environment:/i.test(e)) {
    return {
      cause: 'The environment variable did not resolve.',
      fixes: [
        {
          label: 'Check the variable and the file',
          detail:
            "It is read from overdb's own environment first, then from the file if you named one. A " +
            'GUI app launched from the Dock does not inherit your shell profile.',
        },
        ...otherSources(input.secretSource),
      ],
    };
  }
  if (/^AWS IAM:/i.test(e)) {
    return {
      cause: 'No IAM token could be minted for this endpoint.',
      fixes: [
        { label: 'Check the AWS session', detail: '`aws sso login`, or name a profile. overdb stores no AWS credential of its own.' },
        {
          label: 'Check the IAM policy and the grant',
          detail:
            'Needs `rds-db:connect` on `db-user:<resource-id>/<db user>` — and, inside the database, ' +
            'a user GRANTed rds_iam (Postgres) or IDENTIFIED WITH AWSAuthenticationPlugin (MySQL).',
        },
        ...otherSources(input.secretSource),
      ],
    };
  }
  if (/^TLS:/i.test(e)) {
    return {
      cause: 'A certificate or key file could not be used.',
      fixes: [
        { label: 'Check the paths', detail: 'The message below names the file. These are read at connect time, so a moved or unreadable file fails here rather than when you saved.' },
      ],
    };
  }
  if (/^1Password:/i.test(e)) {
    return {
      cause: 'The 1Password reference did not resolve.',
      fixes: [
        { label: 'Check the reference', detail: 'op://vault/item/field, and an unlocked `op` session — use Check to confirm.' },
        ...otherSources(input.secretSource),
      ],
    };
  }

  // --- Nothing matched --------------------------------------------------
  // Still worth listing the auth options: an unrecognized message from a
  // proxy or a managed service is most often one of these anyway.
  const networkSql = input.engine === 'postgres' || input.engine === 'mysql';
  return {
    cause: 'The server refused the connection, and the message below is the driver’s own.',
    fixes: networkSql
      ? [
          ...(input.ssl === 'disable'
            ? [REQUIRE_SSL]
            : input.ssl === 'verify-full' || input.ssl === 'verify-ca'
              ? [RELAX_SSL]
              : []),
          ...otherSources(input.secretSource),
        ]
      : [],
  };
}
