import { describe, expect, it } from 'vitest';
import { splitCondition } from './planCondition';

describe('splitCondition', () => {
  it('splits a MySQL attached_condition into its AND-ed parts', () => {
    const parts = splitCondition(
      '((`acme`.`partner0_`.`pending_customer_approval` = 0) and (`acme`.`partner0_`.`exclude_reports` = 0) and (`acme`.`partner0_`.`partner_source` <> 26))',
    );
    expect(parts.map((p) => p.text)).toEqual([
      'partner0_.pending_customer_approval = 0',
      'partner0_.exclude_reports = 0',
      'partner0_.partner_source <> 26',
    ]);
    expect(parts.every((p) => p.kind === 'compare')).toBe(true);
  });

  it('does not lose the parentheses that separate two groups', () => {
    // `(a) and (b)` is two parts. An unwrapper that strips the outermost
    // pair whenever the string starts and ends with one would turn this
    // into `a) and (b`.
    const parts = splitCondition('(a = 1) and (b = 2)');
    expect(parts.map((p) => p.text)).toEqual(['a = 1', 'b = 2']);
  });

  it('keeps a nested AND inside a subquery out of the top-level split', () => {
    const parts = splitCondition(
      "(`p`.`id` = 1) and (<in_optimizer>(`p`.`id`,`p`.`id` in ( <materialize> (select `x`.`id` from `x` where ((`x`.`a` = 1) and (`x`.`b` = 2))))))",
    );
    expect(parts).toHaveLength(2);
    expect(parts[1].kind).toBe('subquery');
  });

  it('marks an OR group as something no index can cover', () => {
    const parts = splitCondition('(a = 1) and ((b = 2) or (c = 3) or (d = 4))');
    expect(parts[1].kind).toBe('alternatives');
    expect(parts[1].branches).toBe(3);
  });

  it('does not split on and or or inside a quoted string', () => {
    const parts = splitCondition("(`p`.`name` = 'salt and pepper') and (`p`.`id` = 1)");
    expect(parts.map((p) => p.text)).toEqual(["p.name = 'salt and pepper'", 'p.id = 1']);
  });

  it('does not split on a keyword that is part of a longer word', () => {
    expect(splitCondition('(brand = 1)').map((p) => p.text)).toEqual(['brand = 1']);
    expect(splitCondition('(x = 1) and (android = 2)')).toHaveLength(2);
  });

  it('recognises a null check', () => {
    expect(splitCondition('(`m`.`email_template_id` is not null)')[0].kind).toBe('null');
  });

  it('has nothing to say about an absent condition', () => {
    expect(splitCondition(undefined)).toEqual([]);
    expect(splitCondition('   ')).toEqual([]);
  });
});
