import { describe, expect, it } from 'vitest';
import {
  bindFor,
  blankBinding,
  bufferPlaceholders,
  defaultType,
  forgetConnection,
  previewBound,
  bindParams,
  coerceParam,
  clearValue,
  nameFor,
  paramSlots,
  resolveBinding,
  resolveParams,
  scanPlaceholders,
  slotKey,
  unfilledParams,
  withValue,
  type ParamBinding,
} from './params';

describe('scanPlaceholders', () => {
  it('finds a positional hole and names it from the column beside it', () => {
    const sql = 'SELECT * FROM client c WHERE c.client_name = ?';
    const [p] = scanPlaceholders(sql, 'mysql');
    expect(p.style).toBe('positional');
    expect(p.label).toBe('client_name');
    expect(p.inferred).toBe(true);
    expect(sql.slice(p.from, p.to)).toBe('?');
  });

  it('reads the named spellings ORMs actually emit', () => {
    expect(scanPlaceholders('WHERE a = :clientName', 'postgres')[0]).toMatchObject({
      style: 'named', label: 'clientName', key: 'clientname', inferred: false,
    });
    expect(scanPlaceholders('WHERE a = #{clientName}', 'mysql')[0]).toMatchObject({
      style: 'named', label: 'clientName',
    });
    expect(scanPlaceholders('WHERE a = ${clientName}', 'mysql')[0]).toMatchObject({
      style: 'named', label: 'clientName',
    });
  });

  it('lands `?` and `:clientName` on the same slot', () => {
    const positional = scanPlaceholders('WHERE c.client_name = ?', 'mysql')[0];
    const named = scanPlaceholders('WHERE c.x = :clientName', 'mysql')[0];
    expect(positional.key).toBe(named.key);
  });

  it('ignores holes inside strings, comments and quoted identifiers', () => {
    expect(scanPlaceholders("SELECT '?' , ':x' -- :y\nFROM t", 'postgres')).toHaveLength(0);
    expect(scanPlaceholders('SELECT /* ? :x */ 1', 'postgres')).toHaveLength(0);
    expect(scanPlaceholders('SELECT "a?b" FROM t', 'postgres')).toHaveLength(0);
    expect(scanPlaceholders('SELECT `a?b` FROM t', 'mysql')).toHaveLength(0);
  });

  it('leaves a Postgres cast alone', () => {
    expect(scanPlaceholders('SELECT id::text FROM t', 'postgres')).toHaveLength(0);
  });

  it('leaves a dollar-quoted body alone', () => {
    expect(scanPlaceholders("DO $$ BEGIN RAISE NOTICE '?'; END $$", 'postgres')).toHaveLength(0);
  });

  it('leaves MySQL user variables alone', () => {
    expect(scanPlaceholders('SET @start := NOW()', 'mysql')).toHaveLength(0);
    expect(scanPlaceholders('SELECT @start', 'sqlite')).toHaveLength(1);
  });

  it('leaves the Postgres jsonb key operators alone', () => {
    expect(scanPlaceholders("SELECT data ?| array['a'] FROM t", 'postgres')).toHaveLength(0);
    expect(scanPlaceholders("SELECT data ?& array['a'] FROM t", 'postgres')).toHaveLength(0);
  });

  it('reads Postgres $1 as a hole', () => {
    const [p] = scanPlaceholders('SELECT * FROM t WHERE id = $1', 'postgres');
    expect(p).toMatchObject({ style: 'positional', raw: '$1', label: 'id' });
  });

  it('gives two positional holes on one column separate slots', () => {
    const slots = paramSlots('WHERE created_at BETWEEN ? AND ?', 'mysql');
    expect(slots).toHaveLength(2);
    expect(slots[0].label).toBe('created_at');
    expect(slots[1].label).toBe('created_at #2');
  });

  it('collapses a repeated named hole into one slot', () => {
    const slots = paramSlots('WHERE a = :name OR b = :name', 'postgres');
    expect(slots).toHaveLength(1);
    expect(slots[0].count).toBe(2);
  });

  it('falls back to an ordinal when nothing nearby names it', () => {
    expect(nameFor('SELECT ', 7, 1)).toBe('param1');
  });
});

describe('bindParams', () => {
  const sql = `SELECT DISTINCT p.*
FROM partner p
    INNER JOIN panel_widget pw ON p.partner_id = pw.partner_id
    INNER JOIN client c ON pw.client_id = c.client_id
WHERE c.client_name = ?`;

  it('rewrites the ORM statement for MySQL and carries the value beside it', () => {
    const bound = bindParams(sql, 'mysql', { clientname: 'hp' });
    expect(bound.sql).toContain('c.client_name = ?');
    expect(bound.params).toEqual(['hp']);
  });

  it('renumbers into $n for Postgres', () => {
    const bound = bindParams('WHERE a = ? AND b = ?', 'postgres', {});
    expect(bound.sql).toBe('WHERE a = $1 AND b = $2');
  });

  it('points a repeated named hole at one $n on Postgres', () => {
    const bound = bindParams('WHERE a = :name OR b = :name', 'postgres', { name: 'hp' });
    expect(bound.sql).toBe('WHERE a = $1 OR b = $1');
    expect(bound.params).toEqual(['hp']);
  });

  it('repeats the value where the driver has no way to name it', () => {
    const bound = bindParams('WHERE a = :name OR b = :name', 'mysql', { name: 'hp' });
    expect(bound.sql).toBe('WHERE a = ? OR b = ?');
    expect(bound.params).toEqual(['hp', 'hp']);
  });

  it('never substitutes the value into the SQL text', () => {
    const bound = bindParams('WHERE name = ?', 'mysql', { name: "hp'; DROP TABLE client; --" });
    expect(bound.sql).toBe('WHERE name = ?');
    expect(bound.params).toEqual(["hp'; DROP TABLE client; --"]);
  });

  it('expands one hole into a list for IN', () => {
    const bound = bindParams('WHERE id IN (?)', 'mysql', { id: [1, 2, 3] });
    expect(bound.sql).toBe('WHERE id IN (?, ?, ?)');
    expect(bound.params).toEqual([1, 2, 3]);
  });

  it('binds an empty list as a value nothing matches', () => {
    const bound = bindParams('WHERE id IN (?)', 'mysql', { id: [] });
    expect(bound.sql).toBe('WHERE id IN (?)');
    expect(bound.params).toEqual([null]);
  });

  it('leaves a statement with no holes untouched', () => {
    expect(bindParams('SELECT 1', 'postgres', {})).toEqual({ sql: 'SELECT 1', params: [] });
  });
});

describe('coerceParam', () => {
  it('reads the obvious types on auto', () => {
    expect(coerceParam('42', 'auto')).toBe(42);
    expect(coerceParam('-1.5', 'auto')).toBe(-1.5);
    expect(coerceParam('true', 'auto')).toBe(true);
    expect(coerceParam('NULL', 'auto')).toBe(null);
    expect(coerceParam('hp', 'auto')).toBe('hp');
  });

  it('keeps a leading zero as text', () => {
    expect(coerceParam('007', 'auto')).toBe('007');
  });

  it('honours an explicit type over the guess', () => {
    expect(coerceParam('42', 'text')).toBe('42');
    expect(coerceParam('anything', 'null')).toBe(null);
    expect(coerceParam('yes', 'boolean')).toBe(true);
    expect(() => coerceParam('hp', 'number')).toThrow(/not a number/);
  });

  it('splits a list, honouring quotes', () => {
    expect(coerceParam('hp, ibm, 3', 'list')).toEqual(['hp', 'ibm', 3]);
    expect(coerceParam("'hp, inc', ibm", 'list')).toEqual(['hp, inc', 'ibm']);
  });
});

describe('layered values', () => {
  const binding: ParamBinding = {
    key: 'clientname',
    label: 'client_name',
    type: 'auto',
    value: 'hp',
    byEnv: { prod: 'HP Inc' },
    byConnection: { 'conn-9': 'hp-local' },
  };

  it('prefers the connection, then the environment, then the default', () => {
    expect(resolveBinding(binding, { connectionId: 'conn-9', env: 'prod' })).toEqual({
      text: 'hp-local', scope: 'connection',
    });
    expect(resolveBinding(binding, { connectionId: 'conn-1', env: 'prod' })).toEqual({
      text: 'HP Inc', scope: 'env',
    });
    expect(resolveBinding(binding, { connectionId: 'conn-1', env: 'dev' })).toEqual({
      text: 'hp', scope: 'default',
    });
  });

  it('binds the same statement differently per environment', () => {
    const sql = 'SELECT * FROM client WHERE client_name = ?';
    expect(bindFor(sql, 'mysql', [binding], { env: 'dev' }).params).toEqual(['hp']);
    expect(bindFor(sql, 'mysql', [binding], { env: 'prod' }).params).toEqual(['HP Inc']);
    expect(bindFor(sql, 'mysql', [binding], { env: 'prod', connectionId: 'conn-9' }).params).toEqual(
      ['hp-local'],
    );
  });

  it('writes into the layer it was told to and leaves the rest alone', () => {
    const next = withValue(binding, 'HP GmbH', 'env', { env: 'staging', connectionId: 'conn-9' });
    expect(next.byEnv).toEqual({ prod: 'HP Inc', staging: 'HP GmbH' });
    expect(next.value).toBe('hp');
    expect(next.byConnection).toEqual({ 'conn-9': 'hp-local' });
  });

  it('falls back to the layer beneath when an override is cleared', () => {
    const next = clearValue(binding, 'connection', { connectionId: 'conn-9', env: 'prod' });
    expect(resolveBinding(next, { connectionId: 'conn-9', env: 'prod' })).toEqual({
      text: 'HP Inc', scope: 'env',
    });
  });

  it('reports a slot with nothing behind it rather than binding NULL', () => {
    const slots = paramSlots('WHERE client_name = ?', 'mysql');
    const resolved = resolveParams(slots, [], { env: 'dev' });
    expect(resolved[0].missing).toBe(true);
    expect(unfilledParams(resolved)).toHaveLength(1);
  });

  it('does not call an explicit NULL unfilled', () => {
    const slots = paramSlots('WHERE deleted_at = :deletedAt', 'postgres');
    const resolved = resolveParams(
      slots,
      [{ key: 'deletedat', label: 'deletedAt', type: 'null', value: '' }],
      {},
    );
    expect(unfilledParams(resolved)).toHaveLength(0);
  });
});

describe('previewBound', () => {
  it('writes the values back in for the log, quoting text', () => {
    expect(previewBound('WHERE name = ? AND n = ?', ['hp', 3], 'mysql')).toBe(
      "WHERE name = 'hp' AND n = 3",
    );
  });

  it('shows one Postgres value at both of its holes', () => {
    expect(previewBound('WHERE a = $1 OR b = $1', ['hp'], 'postgres')).toBe(
      "WHERE a = 'hp' OR b = 'hp'",
    );
  });

  it('leaves a question mark inside a string alone', () => {
    expect(previewBound("WHERE q = 'why?' AND n = ?", [1], 'mysql')).toBe(
      "WHERE q = 'why?' AND n = 1",
    );
  });

  it('escapes a quote in the displayed value rather than breaking the line', () => {
    expect(previewBound('WHERE name = ?', ["o'brien"], 'mysql')).toBe(
      "WHERE name = 'o''brien'",
    );
  });
});

describe('slotKey', () => {
  it('ignores case and word separators', () => {
    expect(slotKey('clientName')).toBe(slotKey('client_name'));
    expect(slotKey('CLIENT_NAME')).toBe('clientname');
  });
});

describe('bufferPlaceholders', () => {
  const buffer = [
    'SELECT * FROM client WHERE client_name = ?;',
    '',
    'SELECT * FROM partner p',
    'WHERE p.client_id = ? AND p.name = :partnerName;',
  ].join('\n');

  it('finds every hole in the buffer, not just the one statement', () => {
    const holes = bufferPlaceholders(buffer, 'mysql');
    expect(holes.map((h) => h.label)).toEqual(['client_name', 'client_id', 'partnerName']);
  });

  it('reports offsets into the buffer, so the editor can decorate them', () => {
    for (const hole of bufferPlaceholders(buffer, 'mysql')) {
      expect(buffer.slice(hole.from, hole.to)).toBe(hole.raw);
    }
  });

  it('keys a positional hole by where it sits in ITS statement', () => {
    // Both statements' first `?` is that statement's first value — the one
    // above must not push the one below into a second slot.
    const holes = bufferPlaceholders('WHERE a = ?;\nWHERE a = ?;', 'mysql');
    expect(holes[0].key).toBe(holes[1].key);
  });
});

describe('forgetConnection', () => {
  const list: ParamBinding[] = [
    {
      key: 'clientname', label: 'client_name', type: 'auto', value: 'hp',
      byEnv: { prod: 'HP Inc' }, byConnection: { 'conn-9': 'hp-local', 'conn-1': 'x' },
    },
    { key: 'status', label: 'status', type: 'auto', value: 'active' },
  ];

  it('drops that connection and leaves every other layer alone', () => {
    const [first] = forgetConnection(list, 'conn-9');
    expect(first.byConnection).toEqual({ 'conn-1': 'x' });
    expect(first.byEnv).toEqual({ prod: 'HP Inc' });
    expect(first.value).toBe('hp');
  });

  it('returns the same objects when there is nothing to drop', () => {
    expect(forgetConnection(list, 'never-existed')).toEqual(list);
  });
});

describe('IN (?)', () => {
  it('reads a lone hole inside IN as a list', () => {
    const [slot] = paramSlots('WHERE c.client_id IN (?)', 'mysql');
    expect(slot.inList).toBe(true);
    expect(defaultType(slot)).toBe('list');
    expect(blankBinding(slot).type).toBe('list');
  });

  it('leaves an already-expanded IN alone', () => {
    // Three holes an ORM expanded itself are three values, not three lists.
    const slots = paramSlots('WHERE id IN (?, ?, ?)', 'mysql');
    expect(slots).toHaveLength(3);
    expect(slots.every((s) => !s.inList)).toBe(true);
  });

  it('handles NOT IN and named holes the same way', () => {
    expect(paramSlots('WHERE id NOT IN (?)', 'mysql')[0].inList).toBe(true);
    expect(paramSlots('WHERE id IN (:ids)', 'postgres')[0].inList).toBe(true);
    expect(paramSlots('WHERE id IN(?)', 'mysql')[0].inList).toBe(true);
  });

  it('is not fooled by a hole that merely sits in parentheses', () => {
    expect(paramSlots('WHERE (client_name = ?)', 'mysql')[0].inList).toBe(false);
    // A function whose name merely ENDS in "in" is not an IN clause.
    expect(paramSlots('WHERE min(?) > 0', 'mysql')[0].inList).toBe(false);
    expect(paramSlots('WHERE fn_in(?) > 0', 'mysql')[0].inList).toBe(false);
    expect(paramSlots('WHERE coalesce(?, 1) > 0', 'mysql')[0].inList).toBe(false);
    expect(paramSlots("WHERE thing = 'in' AND id = (?)", 'mysql')[0].inList).toBe(false);
  });

  it('binds one hole to as many values as were typed', () => {
    const slot = paramSlots('WHERE id IN (?)', 'mysql')[0];
    const bound = bindFor(
      'SELECT * FROM client WHERE id IN (?)',
      'mysql',
      [{ ...blankBinding(slot), value: 'hp, ibm, dell' }],
      {},
    );
    expect(bound.sql).toBe('SELECT * FROM client WHERE id IN (?, ?, ?)');
    expect(bound.params).toEqual(['hp', 'ibm', 'dell']);
  });

  it('numbers an expanded list correctly on Postgres', () => {
    const slot = paramSlots('WHERE id IN (:ids)', 'postgres')[0];
    const bound = bindFor(
      'SELECT * FROM client WHERE id IN (:ids) AND active = :active',
      'postgres',
      [
        { ...blankBinding(slot), value: '1, 2, 3' },
        { key: 'active', label: 'active', type: 'auto', value: 'true' },
      ],
      {},
    );
    expect(bound.sql).toBe(
      'SELECT * FROM client WHERE id IN ($1, $2, $3) AND active = $4',
    );
    expect(bound.params).toEqual([1, 2, 3, true]);
  });
});
