// AWS IAM database authentication: a password that is minted, not stored.
//
// On RDS and Aurora, `rds:connect` on an IAM principal can stand in for a
// database password. The "password" is a SigV4-signed token that is valid
// for fifteen minutes and is generated fresh for each connection. There is
// nothing to store, nothing to rotate, and nothing to leak from overdb's
// disk — which makes it strictly the best of the sources here, and the one
// the `aurora-postgres` / `aurora-mysql` variants most often want.
//
// Two consequences shape the code:
//
//   1. It cannot be cached. A token minted when the connection was created
//      is expired by the time you reconnect after lunch, so this runs on
//      every connect and every test.
//   2. It REQUIRES TLS. The token is a bearer credential in the password
//      field; sending it over a plaintext socket hands anyone on the path a
//      fifteen-minute login. src/main/credentials.ts refuses to send one
//      without TLS rather than letting that be a checkbox someone gets
//      wrong.
//
// Credentials for the signing itself come from the standard AWS provider
// chain — environment, SSO, profile, instance role. overdb stores no AWS
// credential of its own, exactly as with DynamoDB.

import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

export type IamResult =
  | { ok: true; password: string; user?: string }
  | { ok: false; error: string };

export interface IamRequest {
  host: string;
  port: number;
  user?: string;
  database?: string;
  /// Normally left blank: an AWS endpoint names its own region.
  region?: string;
  profile?: string;
}

/// `mydb.cluster-cabc123.eu-west-1.rds.amazonaws.com` → `eu-west-1`.
///
/// The region is the label before the service label, for every AWS
/// endpoint shape that matters here, which is more robust than counting
/// from either end — `cluster-ro-` prefixes and custom endpoints change
/// the number of labels but never that relationship.
export function regionFromHost(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const parts = host.toLowerCase().split('.');
  for (const service of ['rds', 'redshift', 'redshift-serverless']) {
    const i = parts.indexOf(service);
    if (i > 0 && /^[a-z]{2}-[a-z]+-\d$/.test(parts[i - 1])) return parts[i - 1];
  }
  return undefined;
}

export function isRedshiftHost(host: string | undefined): boolean {
  return !!host && /\.redshift(-serverless)?\.amazonaws\.com$/i.test(host);
}

function credentials(profile?: string) {
  // A named profile when one is given; the ordinary chain otherwise. Both
  // resolve lazily, so an expired SSO session fails HERE — before the
  // network is touched — with a message about AWS rather than a database
  // timeout.
  return fromNodeProviderChain(profile ? { profile } : {});
}

export async function awsIamToken(req: IamRequest): Promise<IamResult> {
  const region = req.region?.trim() || regionFromHost(req.host);
  if (!region) {
    return {
      ok: false,
      error:
        'AWS IAM: could not tell which region this endpoint is in. Set the region explicitly — ' +
        'it is normally read from a `*.<region>.rds.amazonaws.com` hostname.',
    };
  }

  if (isRedshiftHost(req.host)) return redshiftCredentials(req, region);

  if (!req.user?.trim()) {
    return { ok: false, error: 'AWS IAM: a database user is required — the token is signed for one.' };
  }

  try {
    // Imported lazily so the SDK is not loaded for the connections that
    // never use it, which is most of them.
    const { Signer } = await import('@aws-sdk/rds-signer');
    const signer = new Signer({
      hostname: req.host,
      port: req.port,
      username: req.user.trim(),
      region,
      credentials: credentials(req.profile),
    });
    const password = await signer.getAuthToken();
    if (!password) return { ok: false, error: 'AWS IAM: the signer produced no token.' };
    return { ok: true, password };
  } catch (err) {
    return { ok: false, error: `AWS IAM: ${message(err)}` };
  }
}

/// Redshift does not take a signed token; it issues a temporary username
/// and password through the control plane. So this returns a USER as well,
/// and the caller has to use it: the identity Redshift hands back
/// (`IAM:alice`) is not the one that was typed into the form.
async function redshiftCredentials(req: IamRequest, region: string): Promise<IamResult> {
  if (/\.redshift-serverless\.amazonaws\.com$/i.test(req.host)) {
    return {
      ok: false,
      error:
        'AWS IAM: this is a Redshift Serverless endpoint, which issues credentials through a ' +
        'different API that overdb does not call yet. Use a password source for now.',
    };
  }
  const clusterIdentifier = req.host.split('.')[0];
  if (!clusterIdentifier) {
    return { ok: false, error: 'AWS IAM: could not read a cluster identifier from that endpoint.' };
  }
  if (!req.database?.trim()) {
    return { ok: false, error: 'AWS IAM: Redshift issues credentials per database — set the database name.' };
  }

  try {
    const { RedshiftClient, GetClusterCredentialsWithIAMCommand, GetClusterCredentialsCommand } =
      await import('@aws-sdk/client-redshift');
    const client = new RedshiftClient({ region, credentials: credentials(req.profile) });
    try {
      // The modern call: the database user follows from the IAM identity,
      // so nothing has to be kept in step by hand.
      const res = await client.send(
        new GetClusterCredentialsWithIAMCommand({
          ClusterIdentifier: clusterIdentifier,
          DbName: req.database.trim(),
        }),
      );
      if (res.DbPassword) return { ok: true, password: res.DbPassword, user: res.DbUser };
    } catch (err) {
      // Older clusters and restricted policies still only offer the
      // original call, which needs the user named explicitly.
      if (!req.user?.trim()) throw err;
      const res = await client.send(
        new GetClusterCredentialsCommand({
          ClusterIdentifier: clusterIdentifier,
          DbName: req.database.trim(),
          DbUser: req.user.trim(),
          AutoCreate: false,
        }),
      );
      if (res.DbPassword) return { ok: true, password: res.DbPassword, user: res.DbUser };
    }
    return { ok: false, error: 'AWS IAM: Redshift returned no credentials.' };
  } catch (err) {
    return { ok: false, error: `AWS IAM: ${message(err)}` };
  }
}

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  // The SDK's own wording for these is accurate but assumes you know which
  // of half a dozen credential sources it just tried.
  if (/Could not load credentials|CredentialsProviderError/i.test(text)) {
    return 'the AWS provider chain produced no credentials. `aws sso login`, or set a profile.';
  }
  if (/ExpiredToken|expired/i.test(text)) return 'the AWS session has expired. `aws sso login` and try again.';
  if (/AccessDenied|not authorized/i.test(text)) {
    return 'these AWS credentials are not allowed to do this. IAM auth needs `rds-db:connect` on the ' +
      'db-user resource (or `redshift:GetClusterCredentials` on Redshift).';
  }
  return text;
}
