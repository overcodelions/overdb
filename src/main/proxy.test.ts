import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ByteProxy, parseClients } from './proxy';

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

let px = new ByteProxy();
afterEach(async () => {
  await px.stop();
  px = new ByteProxy();
});

describe('proxy', () => {
  // A socket path is the macOS and Linux take-over; Windows has none.
  it.skipIf(process.platform === 'win32')('forwards byte for byte to the current upstream, over TCP and a socket', async () => {
    const a = await namedServer('a');
    const port = await freePort();
    const sock = path.join(os.tmpdir(), `overdb-proxy-test-${process.pid}.sock`);
    await px.start({ port, socket: sock, upstream: async () => ({ host: '127.0.0.1', port: a.port }) });
    expect(px.running).toBe(true);

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
    await px.start({ port, socket: null, upstream: async () => ({ host: '127.0.0.1', port: target }) });

    const first = await ask({ host: '127.0.0.1', port }, 'x');
    expect(first.reply).toBe('a:x');
    expect(px.connections).toBe(1);
    const closed = new Promise<void>((r) => first.socket.once('close', () => r()));

    target = b.port;
    expect(px.drop()).toBe(1);
    await closed;

    const second = await ask({ host: '127.0.0.1', port }, 'y');
    expect(second.reply).toBe('b:y');
    second.socket.destroy();
    await a.close();
    await b.close();
  });

  it('says plainly when the port is taken', async () => {
    const a = await namedServer('a');
    await expect(px.start({ port: a.port, socket: null, upstream: async () => ({ host: '127.0.0.1', port: 1 }) })).rejects.toThrow(
      /in use — most likely by your own server/,
    );
    await a.close();
  });

  it.skipIf(process.platform === 'win32')('refuses a socket a running server answers on', async () => {
    const sock = path.join(os.tmpdir(), `overdb-proxy-owned-${process.pid}.sock`);
    const owner = net.createServer().listen(sock);
    await new Promise((r) => owner.once('listening', r));
    const port = await freePort();
    await expect(px.start({ port, socket: sock, upstream: async () => ({ host: '127.0.0.1', port: 1 }) })).rejects.toThrow(
      /belongs to a running server/,
    );
    expect(px.running).toBe(false);
    await new Promise<void>((r) => owner.close(() => r()));
  });
});

describe('before forwarding', () => {
  it('waits for the hook, with the upstream it resolved, before a byte reaches it', async () => {
    const a = await namedServer('a');
    const port = await freePort();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const before = vi.fn(async (to: { host: string; port: number }) => {
      order.push(`hook ${to.port}`);
      await gate;
      order.push('hook done');
    });
    await px.start({ port, socket: null, upstream: async () => ({ host: '127.0.0.1', port: a.port }), beforeForward: before });
    const pending = ask({ host: '127.0.0.1', port }, 'x').then((r) => {
      order.push('reply');
      return r;
    });
    await vi.waitFor(() => expect(before).toHaveBeenCalledTimes(1));
    // Held: nothing reaches the server while the hook runs.
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual([`hook ${a.port}`]);
    expect(px.connections).toBe(0);
    release();
    const r = await pending;
    expect(r.reply).toBe('a:x');
    expect(order).toEqual([`hook ${a.port}`, 'hook done', 'reply']);
    r.socket.destroy();
    await a.close();
  });

  it('forwards anyway when the hook fails, rejecting or throwing', async () => {
    const a = await namedServer('a');
    const port = await freePort();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let n = 0;
    await px.start({
      port,
      socket: null,
      upstream: async () => ({ host: '127.0.0.1', port: a.port }),
      beforeForward: (() => {
        if (n++ === 0) return Promise.reject(new Error('warming failed'));
        throw new Error('thrown outright');
      }) as (to: { host: string; port: number }) => Promise<void>,
    });
    const one = await ask({ host: '127.0.0.1', port }, '1');
    const two = await ask({ host: '127.0.0.1', port }, '2');
    expect([one.reply, two.reply]).toEqual(['a:1', 'a:2']);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/warming failed[\s\S]*thrown outright/);
    warn.mockRestore();
    one.socket.destroy();
    two.socket.destroy();
    await a.close();
  });

  it('closes a client still waiting on the hook when the target moves', async () => {
    const a = await namedServer('a');
    const port = await freePort();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let called = false;
    await px.start({
      port,
      socket: null,
      upstream: async () => ({ host: '127.0.0.1', port: a.port }),
      beforeForward: async () => {
        called = true;
        await gate;
      },
    });
    const socket = net.connect({ host: '127.0.0.1', port });
    const closed = new Promise<void>((r) => socket.once('close', () => r()));
    socket.on('error', () => undefined);
    await vi.waitFor(() => expect(called).toBe(true));
    px.drop();
    await closed;
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(px.connections).toBe(0);
    await a.close();
  });
});

describe('two proxies at once', () => {
  it('each forwards to its own upstream, and stopping one leaves the other', async () => {
    const a = await namedServer('a');
    const b = await namedServer('b');
    const other = new ByteProxy();
    const [pa, pb] = [await freePort(), await freePort()];
    await px.start({ port: pa, socket: null, upstream: async () => ({ host: '127.0.0.1', port: a.port }) });
    await other.start({ port: pb, socket: null, upstream: async () => ({ host: '127.0.0.1', port: b.port }) });
    const x = await ask({ host: '127.0.0.1', port: pa }, '1');
    const y = await ask({ host: '127.0.0.1', port: pb }, '2');
    expect([x.reply, y.reply]).toEqual(['a:1', 'b:2']);
    x.socket.destroy();
    y.socket.destroy();
    await px.stop();
    expect(other.running).toBe(true);
    const z = await ask({ host: '127.0.0.1', port: pb }, '3');
    expect(z.reply).toBe('b:3');
    z.socket.destroy();
    await other.stop();
    await a.close();
    await b.close();
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
