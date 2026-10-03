// overdb's side of the background helper: the Runtime interface, carried
// over the helper's local socket. See src/helper/index.ts.

import net from 'node:net';
import type { HelperRequest, HelperResponse } from '../helper/index';
import type { Runtime } from './runtime';

const TIMEOUT_MS = 120_000;

export class HelperClient implements Runtime {
  private seq = 0;

  constructor(private readonly socket: string) {}

  /// One request on its own connection: the helper is local, connections
  /// are cheap, and nothing has to be matched up across a shared stream.
  call<T>(op: HelperRequest['op'], ...args: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const conn = net.connect({ path: this.socket });
      let buf = '';
      const timer = setTimeout(() => {
        conn.destroy();
        reject(new Error('The background helper did not answer.'));
      }, op === 'ping' ? 2_000 : TIMEOUT_MS);
      conn.once('connect', () => conn.write(`${JSON.stringify({ id, op, args } satisfies HelperRequest)}\n`));
      conn.on('data', (d) => {
        buf += d.toString('utf-8');
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        clearTimeout(timer);
        conn.end();
        const res = JSON.parse(buf.slice(0, nl)) as HelperResponse;
        if (res.ok) resolve(res.value as T);
        else reject(new Error(res.error ?? 'The background helper refused.'));
      });
      conn.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`The background helper is not answering (${(err as NodeJS.ErrnoException).code ?? err.message}).`));
      });
    });
  }

  ping(): Promise<{ pid: number }> {
    return this.call('ping');
  }

  tickets() { return this.call<Awaited<ReturnType<Runtime['tickets']>>>('tickets'); }
  startTicket(id: string) { return this.call<Awaited<ReturnType<Runtime['startTicket']>>>('startTicket', id); }
  stopTicket(id: string) { return this.call<void>('stopTicket', id); }
  deleteTicket(id: string) { return this.call<Awaited<ReturnType<Runtime['deleteTicket']>>>('deleteTicket', id); }
  proxyState() { return this.call<Awaited<ReturnType<Runtime['proxyState']>>>('proxyState'); }
  configureProxy(next: Parameters<Runtime['configureProxy']>[0]) { return this.call<Awaited<ReturnType<Runtime['configureProxy']>>>('configureProxy', next); }
  routeProxy(target: Parameters<Runtime['routeProxy']>[0]) { return this.call<Awaited<ReturnType<Runtime['routeProxy']>>>('routeProxy', target); }
  proxyClients() { return this.call<Awaited<ReturnType<Runtime['proxyClients']>>>('proxyClients'); }
  inUse() { return this.call<Awaited<ReturnType<Runtime['inUse']>>>('inUse'); }
  resume() { return this.call<void>('resume'); }
  shutdown() { return this.call<void>('shutdown'); }
}
