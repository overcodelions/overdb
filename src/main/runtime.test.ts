import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalRuntime, readRecords } from './runtime';

function namedServer(name: string): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => s.on('data', (d) => s.write(`${name}:${d.toString()}`)));
    srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as net.AddressInfo).port, close: () => new Promise((r) => srv.close(() => r())) }));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function ask(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(text));
    socket.once('data', (d) => {
      resolve(d.toString());
      socket.destroy();
    });
    socket.once('error', reject);
  });
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

async function rootWith(records: object): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overdb-rt-'));
  await fs.writeFile(path.join(root, 'records.json'), JSON.stringify(records));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

describe('a proxy per base', () => {
  it('moves the one proxy of older records onto the first base', async () => {
    const root = await rootWith({ baselines: [{ id: 'b', sourceConnectionId: 'local-1' }], tickets: [], proxy: { port: 3310, enabled: true, configured: true } });
    const r = await readRecords(root);
    expect(Object.keys(r.proxies)).toEqual(['local-1']);
    expect(r.proxies['local-1']).toMatchObject({ port: 3310, enabled: true });
  });

  it('runs two at once, each to its own server, and keeps a branch to its own base', async () => {
    const a = await namedServer('a');
    const b = await namedServer('b');
    cleanup.push(a.close, b.close);
    const root = await rootWith({
      baselines: [{ id: 'ba', sourceConnectionId: 'A' }, { id: 'bb', sourceConnectionId: 'B' }],
      tickets: [{ id: 't1', name: 'PROJ-1', sourceConnectionId: 'A', baselineId: 'ba', datadir: '/nowhere', port: 0, connectionId: 'c1', note: '', createdAt: '' }],
    });
    const rt = new LocalRuntime(root);
    cleanup.push(() => rt.shutdown());
    const [pa, pb] = [await freePort(), await freePort()];
    await rt.configureProxy('A', { enabled: true, port: pa, socket: null, server: { host: '127.0.0.1', port: a.port } });
    await rt.configureProxy('B', { enabled: true, port: pb, socket: null, server: { host: '127.0.0.1', port: b.port } });
    expect(await ask(pa, 'x')).toBe('a:x');
    expect(await ask(pb, 'y')).toBe('b:y');
    const states = await rt.proxyStates();
    expect(states.map((s) => [s.source, s.running])).toEqual([['A', true], ['B', true]]);
    await expect(rt.routeProxy('B', { kind: 'ticket', id: 't1' })).rejects.toThrow(/another base/);
  });

  it('refuses a port another base’s proxy already has', async () => {
    const root = await rootWith({ baselines: [{ id: 'ba', sourceConnectionId: 'A' }, { id: 'bb', sourceConnectionId: 'B' }], tickets: [] });
    const rt = new LocalRuntime(root);
    cleanup.push(() => rt.shutdown());
    const port = await freePort();
    await rt.configureProxy('A', { enabled: true, port, socket: null, server: { host: '127.0.0.1', port: 1 } });
    const b = await rt.configureProxy('B', { enabled: true, port, socket: null, server: { host: '127.0.0.1', port: 1 } });
    expect(b.running).toBe(false);
    expect(b.error).toMatch(/already another base's proxy/);
  });
});
