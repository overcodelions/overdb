import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scanRepoSchemas, scanTableMentions } from './repoScan';
import { suggestSchemas } from '../shared/repoLinks';

const root = path.join(os.tmpdir(), `overdb-reposcan-${process.pid}`);
const write = async (rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text);
};

afterAll(() => fs.rm(root, { recursive: true, force: true }));

describe('scanning a repo for the schemas its code uses', () => {
  it('finds the datasource and schema-qualified SQL, and never reads secrets or dependencies', async () => {
    await write('src/main/resources/application.yml', 'spring:\n  datasource:\n    url: jdbc:mysql://localhost:3306/orders?useSSL=false\n');
    await write('src/repo/OrderRepo.java', 'String q = "select * from orders.line_item join orders.header";\n');
    await write('db/report.sql', 'select * from billing.invoice;\n');
    await write('.env', 'DB_NAME=secretdb\n');
    await write('config/secrets.yml', 'database: secretdb\n');
    await write('node_modules/lib/index.js', 'const a = "inventory.item"; const b = "inventory.stock";');
    const ev = await scanRepoSchemas(root, ['orders', 'billing', 'secretdb', 'inventory']);
    expect(ev.orders).toEqual({ config: 1, code: 2 });
    expect(ev.billing).toEqual({ config: 0, code: 1 });
    expect(ev.secretdb).toEqual({ config: 0, code: 0 });
    expect(ev.inventory).toEqual({ config: 0, code: 0 });
    expect(suggestSchemas(ev, root)).toEqual(['orders']);
  });
});

describe('finding which files name each table', () => {
  it('matches SQL names and ORM class names, and never reads secrets, config or dependencies', async () => {
    const at = path.join(root, 'mentions');
    const put = async (rel: string, text: string) => {
      await fs.mkdir(path.dirname(path.join(at, rel)), { recursive: true });
      await fs.writeFile(path.join(at, rel), text);
    };
    await put('src/orders/OrderLineRepository.java', 'interface OrderLineRepository extends Repo<OrderLine> {}');
    await put('db/V1__init.sql', 'create table order_line (id int); create table invoice (id int);');
    await put('src/billing/invoices.ts', 'const invoices = await db.invoices.findMany();');
    await put('.env', 'TABLE=audit_log');
    await put('config/app.yml', 'audit_log: true');
    await put('node_modules/x/index.js', 'audit_log');
    const m = await scanTableMentions(at, ['shop.order_line', 'shop.invoice', 'shop.audit_log']);
    expect(m.get('shop.order_line')).toEqual(['db/V1__init.sql', 'src/orders/OrderLineRepository.java']);
    expect(m.get('shop.invoice')).toEqual(['db/V1__init.sql', 'src/billing/invoices.ts']);
    expect(m.get('shop.audit_log')).toEqual([]);
  });
});
