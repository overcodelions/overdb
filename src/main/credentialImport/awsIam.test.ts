import { describe, expect, it } from 'vitest';
import { isRedshiftHost, regionFromHost } from './awsIam';

describe('regionFromHost', () => {
  // Getting this wrong means signing a token for the wrong region, which
  // the server rejects as an authentication failure — sending the user
  // looking at their password.
  it('reads the region out of an AWS endpoint', () => {
    expect(regionFromHost('orders.abc123.eu-west-1.rds.amazonaws.com')).toBe('eu-west-1');
    expect(regionFromHost('orders.cluster-abc.ap-southeast-2.rds.amazonaws.com')).toBe('ap-southeast-2');
    expect(regionFromHost('orders.cluster-ro-abc.us-east-1.rds.amazonaws.com')).toBe('us-east-1');
    expect(regionFromHost('wh.abc.us-west-2.redshift.amazonaws.com')).toBe('us-west-2');
  });

  it('says nothing rather than guessing', () => {
    expect(regionFromHost('db.internal')).toBeUndefined();
    expect(regionFromHost(undefined)).toBeUndefined();
    // A proxy or CNAME that merely mentions rds is not an endpoint.
    expect(regionFromHost('rds.example.com')).toBeUndefined();
  });
});

describe('isRedshiftHost', () => {
  it('separates Redshift from RDS, which need different APIs entirely', () => {
    expect(isRedshiftHost('wh.abc.us-west-2.redshift.amazonaws.com')).toBe(true);
    expect(isRedshiftHost('wg.123.us-west-2.redshift-serverless.amazonaws.com')).toBe(true);
    expect(isRedshiftHost('orders.abc.us-west-2.rds.amazonaws.com')).toBe(false);
  });
});
