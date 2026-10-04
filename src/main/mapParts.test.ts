import { describe, expect, it } from 'vitest';
import { planMapParts } from './mapParts';

const mentions = (o: Record<string, string[]>) => new Map(Object.entries(o));

describe('planning the passes of a map', () => {
  it('leaves out tables nothing names and hands each pass its files', () => {
    const plan = planMapParts({
      tables: ['app.order', 'app.order_line', 'app.scratch'],
      mentions: mentions({ 'app.order': ['src/orders/Order.java'], 'app.order_line': ['src/orders/OrderLine.java', 'src/orders/Order.java'] }),
    });
    expect(plan.leftOut).toEqual(['app.scratch']);
    expect(plan.parts).toHaveLength(1);
    expect(plan.parts[0].tables).toEqual(['app.order', 'app.order_line']);
    expect(plan.parts[0].files[0]).toBe('src/orders/Order.java');
  });

  it('keeps an area of the code together and splits when a pass is full', () => {
    const tables: string[] = [];
    const m: Record<string, string[]> = {};
    for (let i = 0; i < 6; i++) {
      tables.push(`app.b${i}`, `app.a${i}`);
      m[`app.a${i}`] = [`src/alpha/A${i}.java`];
      m[`app.b${i}`] = [`src/beta/B${i}.java`];
    }
    const plan = planMapParts({ tables, mentions: mentions(m), maxTables: 6 });
    expect(plan.parts.map((p) => p.tables.every((t) => t.startsWith('app.a')) || p.tables.every((t) => t.startsWith('app.b')))).toEqual([true, true]);
  });

  it('puts the first schema in passes of its own, ahead of the rest', () => {
    const plan = planMapParts({
      tables: ['dw.fact', 'app.user', 'dw.dim'],
      mentions: mentions({ 'dw.fact': ['etl/Fact.py'], 'app.user': ['etl/Fact.py'], 'dw.dim': ['etl/Dim.py'] }),
      first: ['app'],
    });
    expect(plan.parts.map((p) => [p.first, p.tables])).toEqual([
      [true, ['app.user']],
      [false, ['dw.dim', 'dw.fact']],
    ]);
  });

  it('caps what a table named everywhere adds to its pass', () => {
    const files = Array.from({ length: 500 }, (_, i) => `src/f${i}.ts`);
    const plan = planMapParts({ tables: ['app.users'], mentions: mentions({ 'app.users': files }), maxFiles: 40 });
    expect(plan.parts[0].files).toHaveLength(10);
    expect(plan.parts[0].moreFiles).toBe(490);
  });
});
