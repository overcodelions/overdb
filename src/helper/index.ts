// The background helper: the proxy and the ticket copies, kept running
// while overdb is closed. Installed only when a person asks for it, as a
// macOS LaunchAgent (src/main/helperInstall.ts), and run by overdb's own
// binary as plain node. See docs/design/baselines.md.
//
// It is the same runtime overdb uses in-process (src/main/runtime.ts),
// behind a local control socket that only this user can reach. overdb
// drives it through src/main/helperClient.ts; nothing else talks to it.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { LocalRuntime, type Runtime } from '../main/runtime';

export interface HelperRequest {
  id: number;
  op: keyof Runtime | 'ping';
  args: unknown[];
}

export interface HelperResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export function helperSocket(root: string): string {
  return path.join(root, 'helper.sock');
}

const OPS: ReadonlySet<string> = new Set([
  'tickets', 'startTicket', 'stopTicket', 'deleteTicket', 'resetTicket', 'proxyStates', 'configureProxy', 'routeProxy',
  'proxyClients', 'inUse', 'resume', 'shutdown',
]);

async function main(): Promise<void> {
  const root = process.env.OVERDB_INSTANCES;
  if (!root) {
    console.error('OVERDB_INSTANCES is not set; nothing to run.');
    process.exit(2);
  }
  fs.mkdirSync(root, { recursive: true });
  const runtime = new LocalRuntime(root);
  const sock = helperSocket(root);
  fs.rmSync(sock, { force: true });

  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString('utf-8');
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        void answer(line).then((res) => conn.write(`${JSON.stringify(res)}\n`));
      }
    });
    conn.on('error', () => undefined);
  });

  async function answer(line: string): Promise<HelperResponse> {
    let req: HelperRequest;
    try {
      req = JSON.parse(line) as HelperRequest;
    } catch {
      return { id: -1, ok: false, error: 'Not a request.' };
    }
    if (req.op === 'ping') return { id: req.id, ok: true, value: { pid: process.pid } };
    if (!OPS.has(req.op)) return { id: req.id, ok: false, error: `Unknown operation ${String(req.op)}.` };
    try {
      const fn = runtime[req.op as keyof Runtime] as (...a: unknown[]) => Promise<unknown>;
      return { id: req.id, ok: true, value: await fn.apply(runtime, req.args ?? []) };
    } catch (err) {
      return { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Private from the moment it exists, not only after the chmod below.
  const umask = process.umask(0o077);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, () => resolve());
  }).finally(() => process.umask(umask));
  // This user only: the socket can start databases and move the proxy.
  fs.chmodSync(sock, 0o600);
  await runtime.resume().catch((err) => console.error('resume failed', err));
  console.log(`overdb helper ${process.pid} listening on ${sock}`);

  const stop = async () => {
    server.close();
    fs.rmSync(sock, { force: true });
    await runtime.shutdown().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

if (require.main === module) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
