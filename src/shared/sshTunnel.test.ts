import { describe, expect, it } from 'vitest';
import { explainSshFailure, tunnelArgv, validateTunnel } from './sshTunnel';

const fallback = { host: 'db.internal', port: 5432 };

describe('validateTunnel', () => {
  it('accepts a user@host and a config alias', () => {
    expect(validateTunnel({ target: 'ec2-user@bastion.example.com' })).toBeNull();
    expect(validateTunnel({ target: 'prod-bastion' })).toBeNull();
  });

  // The whole attack surface of spawning ssh with argv: an argument that
  // ssh itself reads as an option. `-oProxyCommand=…` is arbitrary code
  // execution, and a hostname never begins with a dash.
  it('refuses a target that would be read as an option', () => {
    expect(validateTunnel({ target: '-oProxyCommand=/bin/sh -c id' })).toMatch(/dash/i);
    expect(validateTunnel({ target: '-D' })).toMatch(/dash/i);
    expect(validateTunnel({ identityFile: '-oProxyCommand=x', target: 'host' })).toMatch(/dash/i);
    expect(validateTunnel({ target: 'host; id' })).toMatch(/does not look like/i);
    expect(validateTunnel({ target: 'host', remoteHost: '-oProxyCommand=x' })).toMatch(/hostname/i);
  });

  it('refuses a target that is missing or out of range', () => {
    expect(validateTunnel({ target: '' })).toMatch(/required/i);
    expect(validateTunnel({ target: 'h', port: 70000 })).toMatch(/1 and 65535/);
    expect(validateTunnel({ target: 'h', remotePort: 0 })).toMatch(/1 and 65535/);
  });
});

describe('tunnelArgv', () => {
  const argv = tunnelArgv({ target: 'me@bastion' }, 54321, fallback);

  it('forwards to loopback only', () => {
    // A bare `-L 54321:host:5432` binds every interface and publishes the
    // production database to whatever network this laptop is on.
    expect(argv).toContain('-L');
    expect(argv[argv.indexOf('-L') + 1]).toBe('127.0.0.1:54321:db.internal:5432');
  });

  it('never opens a shell or runs a command on the bastion', () => {
    expect(argv).toContain('-N');
    expect(argv).toContain('-T');
  });

  it('refuses to prompt, and fails instead of trusting a new host key', () => {
    expect(argv).toContain('BatchMode=yes');
  });

  it('exits rather than connecting with no forward', () => {
    expect(argv).toContain('ExitOnForwardFailure=yes');
    expect(argv).toContain('ClearAllForwardings=yes');
  });

  it('puts the destination last, and only once', () => {
    expect(argv[argv.length - 1]).toBe('me@bastion');
    expect(argv.filter((a) => a === 'me@bastion')).toHaveLength(1);
  });

  it('uses the connection’s own host and port unless told otherwise', () => {
    const explicit = tunnelArgv(
      { target: 'b', remoteHost: 'rds.internal', remotePort: 3306 },
      1234,
      fallback,
    );
    expect(explicit[explicit.indexOf('-L') + 1]).toBe('127.0.0.1:1234:rds.internal:3306');
  });

  it('pins to the named key when one is given', () => {
    const withKey = tunnelArgv({ target: 'b', identityFile: '~/.ssh/prod' }, 1, fallback);
    expect(withKey).toContain('-i');
    expect(withKey).toContain('IdentitiesOnly=yes');
  });
});

describe('explainSshFailure', () => {
  it('turns ssh diagnostics into sentences about this form', () => {
    expect(explainSshFailure('Host key verification failed.')).toMatch(/known_hosts/);
    expect(explainSshFailure('me@b: Permission denied (publickey).')).toMatch(/agent/);
    expect(explainSshFailure('ssh: Could not resolve hostname b')).toMatch(/resolve/);
    expect(explainSshFailure('something else entirely')).toBeNull();
  });
});
