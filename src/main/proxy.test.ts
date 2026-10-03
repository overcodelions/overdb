import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dropConnections, parseClients, proxyConnections, proxyRunning, setUpstream, startProxy, stopProxy } from './proxy';

// Two stand-in servers that answer every line with their own name, so a
// test can tell which one a connection reached.
function namedServer(name: string): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => s.on('data', (d) => s.write(`${name}:${d.toString()}`)));
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      resolve({ port, close: () => new Promise((r) => srv.close(() => r())) });
    });
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

function ask(opts: net.NetConnectOpts, text: string): Promise<{ reply: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(opts, () => socket.write(text));
    socket.once('data', (d) => resolve({ reply: d.toString(), socket }));
    socket.once('error', reject);
  });
}

afterEach(async () => {
  await stopProxy();
});

describe('proxy', () => {
  it('forwards byte for byte to the current upstream, over TCP and a socket', async () => {
    const a = await namedServer('a');
    const port = await freePort();
    const sock = path.join(os.tmpdir(), `overdb-proxy-test-${process.pid}.sock`);
    await startProxy({ port, socket: sock, upstream: async () => ({ host: '127.0.0.1', port: a.port }) });
    expect(proxyRunning()).toBe(true);

    const tcp = await ask({ host: '127.0.0.1', port }, 'select 1');
    expect(tcp.reply).toBe('a:select 1');
    const unix = await ask({ path: sock }, 'select 2');
    expect(unix.reply).toBe('a:select 2');
    tcp.socket.destroy();
    unix.socket.destroy();
    await a.close();
  });

  it('closes open connections when the target moves, and new ones reach the new target', async () => {
    const a = await namedServer('a');
    const b = await namedServer('b');
    const port = await freePort();
    let target = a.port;
    await startProxy({ port, socket: null, upstream: async () => ({ host: '127.0.0.1', port: target }) });

    const first = await ask({ host: '127.0.0.1', port }, 'x');
    expect(first.reply).toBe('a:x');
    expect(proxyConnections()).toBe(1);
    const closed = new Promise<void>((r) => first.socket.once('close', () => r()));

    target = b.port;
    setUpstream(async () => ({ host: '127.0.0.1', port: target }));
    expect(dropConnections()).toBe(1);
    await closed;

    const second = await ask({ host: '127.0.0.1', port }, 'y');
    expect(second.reply).toBe('b:y');
    second.socket.destroy();
    await a.close();
    await b.close();
  });

  it('says plainly when the port is taken', async () => {
    const a = await namedServer('a');
    await expect(startProxy({ port: a.port, socket: null, upstream: async () => ({ host: '127.0.0.1', port: 1 }) })).rejects.toThrow(
      /in use — most likely by your own server/,
    );
    await a.close();
  });

  it('refuses a socket a running server answers on', async () => {
    const sock = path.join(os.tmpdir(), `overdb-proxy-owned-${process.pid}.sock`);
    const owner = net.createServer().listen(sock);
    await new Promise((r) => owner.once('listening', r));
    const port = await freePort();
    await expect(startProxy({ port, socket: sock, upstream: async () => ({ host: '127.0.0.1', port: 1 }) })).rejects.toThrow(
      /belongs to a running server/,
    );
    expect(proxyRunning()).toBe(false);
    await new Promise<void>((r) => owner.close(() => r()));
  });
});

describe('parseClients', () => {
  it('names the processes at the far end of the proxy’s port, not overdb itself', () => {
    const out = [
      'p100', 'cOverdb', 'n127.0.0.1:3306->127.0.0.1:52001', 'n127.0.0.1:3306->127.0.0.1:52002',
      'p200', 'cjava', 'n127.0.0.1:52001->127.0.0.1:3306',
      'p300', 'cnode', 'n127.0.0.1:52002->127.0.0.1:3306', 'n127.0.0.1:52003->127.0.0.1:3306',
    ].join('\n');
    expect(parseClients(out, 3306, 100)).toEqual([
      { process: 'node', pid: 300, connections: 2 },
      { process: 'java', pid: 200, connections: 1 },
    ]);
  });
});
