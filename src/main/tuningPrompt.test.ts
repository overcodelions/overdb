// The tuning flow proposes; EXPLAIN adjudicates.
//
// "What would make this faster?" is the one prompt in the app that invites
// the model to recommend a change, so it is also the one most able to
// mislead: it has run nothing, timed nothing, and has no way to know whether
// its rewrite is faster. The value of the feature is that the suggestion can
// be PLANNED in one click and the two plans compared — which only holds if
// the answer is framed as a candidate rather than a verdict.
//
// These assert the two properties that make that true: the model is told the
// indexes that already exist, and it is told not to claim a speed-up.

import { describe, expect, it } from 'vitest';
import { fasterPrompt } from './aiPrompts';
import { buildSchemaContext } from './schemaContext';
import type { SchemaSnapshot } from '../shared/types';

const snapshot: SchemaSnapshot = {
  engine: 'mysql',
  serverVersion: '8.0.35',
  capturedAt: '2026-09-09T00:00:00Z',
  schemas: [
    {
      name: 'acme',
      tables: [
        {
          name: 'partner',
          kind: 'table',
          columns: [
            { name: 'partner_id', ordinal: 1, typeName: 'varchar(36)', nullable: false, defaultExpr: null },
            { name: 'client_id', ordinal: 2, typeName: 'varchar(36)', nullable: true, defaultExpr: null },
          ],
          primaryKey: ['partner_id'],
          foreignKeys: [],
          indexes: [{ name: 'idx_partner_client', columns: ['client_id'], unique: false }],
        },
      ],
    },
  ],
};

const base = {
  engine: 'mysql' as const,
  serverVersion: '8.0.35',
  question: '',
  editorText: 'select * from partner where client_id = ?',
  plan: '{"query_block":{}}',
};

describe('the tuning prompt', () => {
  it('is given the indexes that already exist', () => {
    // Without this the commonest answer by far is a CREATE INDEX for an
    // index the table already has, which reads as the feature not knowing
    // the database it is connected to.
    const context = buildSchemaContext(snapshot, 'partner client', { indexes: true });
    expect(context.text).toContain('INDEX idx_partner_client(client_id)');
    expect(fasterPrompt({ ...base, schemaContext: context.text })).toContain(
      'idx_partner_client',
    );
  });

  it('leaves indexes out of every other flow', () => {
    // They are bytes spent on something those answers do not turn on, and
    // the schema budget is the reason a needed table gets dropped.
    expect(buildSchemaContext(snapshot, 'partner client').text).not.toContain('INDEX');
  });

  it('forbids a claim about speed and asks for the plan difference instead', () => {
    const prompt = fasterPrompt({ ...base, schemaContext: 'partner(partner_id varchar(36))' });
    expect(prompt).toMatch(/Do NOT claim a candidate will be faster/);
    expect(prompt).toMatch(/Never propose one that is already there/);
    // The person, not the model, decides — by planning the suggestion.
    expect(prompt).toMatch(/press Plan on your block/);
    // And a suggestion only reaches EXPLAIN if it was WRITTEN. The first
    // real answer this flow gave described its rewrite in a sentence and
    // shipped no statement, so there was nothing to plan and the whole
    // comparison — the point of the feature — never happened.
    expect(prompt).toMatch(/MUST be a complete, runnable statement/);
  });

  it('still says it cannot run anything', () => {
    const prompt = fasterPrompt({ ...base, schemaContext: 'partner(partner_id varchar(36))' });
    expect(prompt).toContain('You CANNOT run queries.');
  });
});
