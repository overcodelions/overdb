import { describe, expect, it } from 'vitest';
import { parseCodeReading } from './baselineCode';

const known = {
  links: new Set(['app.content_form(form_id)→forms.form(form_id)']),
  tables: new Set(['app.app_settings', 'app.feature_flag']),
};

describe('parseCodeReading', () => {
  it('keeps suggestions that name a link or table the catalog has', () => {
    const raw = 'Here is what I found.\n```json\n' + JSON.stringify({
      findings: [{ text: 'z123_user reaches a client through rel_z123_user_to_client', ref: 'src/Login.java:88' }],
      links: [
        { link: 'app.content_form(form_id)→forms.form(form_id)', verdict: 'off', why: 'forms come from app_field_definition' },
        { link: 'app.nope(x)→app.y(x)', verdict: 'off', why: 'invented' },
      ],
      tables: [
        { table: 'APP.feature_flag', action: 'whole', why: 'read at startup' },
        { table: 'app.invented', action: 'whole', why: 'nope' },
        { table: 'app.app_settings', action: 'drop', why: 'not an action' },
      ],
    }) + '\n```';
    expect(parseCodeReading(raw, known)).toEqual({
      findings: [{ text: 'z123_user reaches a client through rel_z123_user_to_client', ref: 'src/Login.java:88' }],
      links: [{ link: 'app.content_form(form_id)→forms.form(form_id)', verdict: 'off', why: 'forms come from app_field_definition' }],
      tables: [{ table: 'app.feature_flag', action: 'whole', why: 'read at startup' }],
    });
  });

  it('says so when there is no JSON to read', () => {
    expect(parseCodeReading('I could not tell.', known)).toHaveProperty('error');
    expect(parseCodeReading('```json\n{ nope\n```', known)).toHaveProperty('error');
  });
});
