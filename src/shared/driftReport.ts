import type { SchemaSnapshot, TableInfo } from './types';
import type { DriftConsequence, DriftFinding, SchemaDrift } from './schemaDiff';
import {
  CONSEQUENCE_ORDER,
  CONSEQUENCE_TEXT,
  gridEntries,
  tableGrid,
  tally,
  wordDiff,
  type GridEntry,
  type GridRow,
} from './driftDdl';

/// A drift comparison, as something to hand to someone who was not there.
///
/// Two forms of one report: a single HTML file for anyone to open, and
/// Markdown for pasting into a PR, a ticket or a chat. Both are built from
/// the same rows and the same words as the drift view (driftDdl.ts), so a
/// report never says something the screen did not — including its shape:
/// one column per member beside the baseline's, "same" where one agrees.
///
/// What goes in is what the view showed and nothing more: schema, table and
/// column names, the servers by their overdb names, and when each catalog
/// was read. Never a host, a user or anything else from a connection. The
/// HTML carries no script and loads nothing — it opens the same offline,
/// in a mail client's preview, and in a year.

export interface ReportSide {
  /// The server's name in overdb.
  name: string;
  schema: string;
  /// When its catalog was read.
  readAt: string;
  /// True when that was not live: an unreachable member compared through
  /// the catalog overdb kept from it.
  kept: boolean;
}

export interface ReportMember {
  side: ReportSide;
  drift: SchemaDrift;
  /// Its catalog, narrowed to the compared schema.
  snapshot: SchemaSnapshot;
  /// The proposed SQL for it, whole, or empty for none.
  sql: string;
}

export interface ReportInput {
  setName: string;
  baseline: ReportSide;
  /// The baseline's catalog, narrowed to the compared schema.
  baselineSnapshot: SchemaSnapshot;
  members: ReportMember[];
  showQuiet: boolean;
  baselineOnly: 'pending' | 'drift' | 'hide';
  ignorePatterns: string[];
  version: string;
  generatedAt: Date;
}

export interface DriftReport {
  html: string;
  markdown: string;
  fileName: string;
}

interface Section {
  entry: GridEntry;
  rows: GridRow[];
  whole: GridRow[];
  summary: string;
}

export function driftReport(input: ReportInput): DriftReport {
  const b = input.baseline.name;
  const names = input.members.map((m) => m.side.name);
  const one = input.members.length === 1;
  const h = names.join(', ');
  const visible = (d: SchemaDrift) => d.findings.filter((f) => input.showQuiet || f.severity !== 'quiet');
  const pendingOf = (d: SchemaDrift) => (input.baselineOnly === 'hide' ? [] : d.pending);

  const tableIn = (snap: SchemaSnapshot, table: string): TableInfo | undefined =>
    snap.schemas[0]?.tables.find((t) => t.name === table);
  const { tables, pending } = gridEntries(
    input.members.map((m) => ({ findings: visible(m.drift), pending: pendingOf(m.drift) })),
  );
  const section = (entry: GridEntry): Section => {
    const grid = (expand: boolean) =>
      tableGrid(
        tableIn(input.baselineSnapshot, entry.table),
        input.members.map((m, i) => ({ findings: entry.byMember[i], table: tableIn(m.snapshot, entry.table) })),
        { expand },
      );
    return {
      entry,
      rows: grid(false),
      whole: grid(true),
      summary: entry.pending
        ? `only on ${b}, not counted as drift`
        : tally(entry.byMember.flat())
            .map(([c, n]) => `${n} ${CONSEQUENCE_TEXT[c].title.toLowerCase()}`)
            .join(' · '),
    };
  };
  const sections = tables.map(section);

  const allFindings = input.members.flatMap((m) => visible(m.drift));
  const counts = new Map<DriftConsequence | 'pending', number>(tally(allFindings));
  if (pending.length > 0) counts.set('pending', pending.length);
  const cards = CONSEQUENCE_ORDER.filter((c) => c === 'breaks' || (counts.get(c) ?? 0) > 0);

  const verdictOf = (findings: DriftFinding[], pend: number, name: string) => {
    const counted = tally(findings);
    if (counted.length === 0) {
      return `${name} matches ${b}${pend ? ` — ${pend} table${pend === 1 ? '' : 's'} not deployed yet` : ''}.`;
    }
    const parts = counted.map(([c, n]) => `${n} ${CONSEQUENCE_TEXT[c].title.toLowerCase()}`);
    if (counted[0][0] !== 'breaks') parts.unshift('Nothing breaks');
    if (pend) parts.push(`${pend} not deployed yet`);
    return `${one ? '' : `${name}: `}${parts.join(' · ')}`;
  };
  const verdicts = input.members.map((m) =>
    verdictOf(visible(m.drift), pendingOf(m.drift).length, m.side.name),
  );

  const at = stamp(input.generatedAt);
  const read = (s: ReportSide) =>
    s.kept ? `catalog as kept ${stamp(new Date(s.readAt))} — not live` : `read live ${stamp(new Date(s.readAt))}`;
  const title = one ? `Schema drift: ${h} against ${b}` : `Schema drift against ${b}`;
  const kept = [input.baseline, ...input.members.map((m) => m.side)].filter((s) => s.kept);
  const ignored = input.members.flatMap((m) => m.drift.ignored.map((t) => ({ ...t, member: m.side.name })));
  const ignoredTables = [...new Set(ignored.map((t) => t.table))];
  const sqls = input.members.filter((m) => m.sql.trim());
  const lacking = (e: GridEntry) =>
    e.byMember.map((fs, i) => (fs.length ? names[i] : null)).filter((n): n is string => n !== null);

  return {
    html: html(),
    markdown: markdown(),
    fileName: `drift-${input.members.map((m) => slug(m.side.name)).join('-')}-vs-${slug(b)}-${input.generatedAt.toISOString().slice(0, 10)}`,
  };

  function markdown(): string {
    const out: string[] = [];
    out.push(`# ${md(title)}`, '');
    out.push(`Set **${md(input.setName)}** · generated ${at}`, '');
    out.push(`- ★ **${md(b)}** — baseline, \`${input.baseline.schema}\`, ${read(input.baseline)}`);
    for (const m of input.members) out.push(`- **${md(m.side.name)}** — \`${m.side.schema}\`, ${read(m.side)}`);
    out.push('');
    if (kept.length) {
      out.push(
        `> ${md(kept.map((s) => s.name).join(' and '))} could not be reached; compared through the catalog overdb last read.`,
        '',
      );
    }
    for (const v of verdicts) out.push(`**${md(v)}**  `);
    out.push('');
    out.push('| | | What it means |', '|---:|---|---|');
    for (const c of cards) {
      const t = CONSEQUENCE_TEXT[c];
      out.push(`| ${counts.get(c) ?? 0} | ${md(t.label?.(b, h) ?? t.title)} | ${md(t.sub(b, h))} |`);
    }
    out.push('');
    const cell = (c: { value: string | null; same: boolean }, name: string) =>
      c.same ? '=' : c.value === null ? `_not on ${md(name)}_` : code(c.value);
    for (const s of sections) {
      out.push(`## \`${s.entry.table}\` — ${md(s.summary)}`, '');
      out.push(
        `| Column / key | ★ ${md(b)} | ${names.map(md).join(' | ')} | What differs |`,
        `|---|---|${names.map(() => '---').join('|')}|---|`,
      );
      for (const r of s.rows) {
        if (r.fold) {
          out.push(`| _${md(r.fold)}_ | |${names.map(() => ' ').join('|')}| |`);
          continue;
        }
        out.push(
          `| ${code(r.name ?? '(table)')} | ${r.baseline === null ? `_not on ${md(b)}_` : code(r.baseline)} | ` +
            `${r.cells.map((c, i) => cell(c, names[i])).join(' | ')} | ${md(r.note)} |`,
        );
      }
      out.push('');
    }
    if (!one) out.push('_`=` — the same as the baseline._', '');
    if (pending.length) {
      out.push(`## Not deployed yet`, '', `Tables only ${md(b)} has. Not counted as drift.`, '');
      for (const e of pending) out.push(`- \`${e.table}\` — not on ${md(lacking(e).join(', '))}`);
      out.push('');
    }
    if (ignoredTables.length) {
      out.push(
        `## Left out by ignore rules`,
        '',
        `${ignoredTables.length} table${ignoredTables.length === 1 ? '' : 's'} only one side has, ` +
          `hidden by ${input.ignorePatterns.map((p) => `\`${p}\``).join(', ')}.`,
        '',
      );
    }
    for (const m of sqls) {
      out.push(`## Proposed SQL for ${md(m.side.name)}`, '', 'Text only — nothing was run.', '', '```sql', m.sql.trim(), '```', '');
    }
    out.push(`_overdb ${input.version} · ${at} · compared catalogs only; no rows were read._`, '');
    return out.join('\n');
  }

  function html(): string {
    const card = (c: DriftConsequence | 'pending') => {
      const t = CONSEQUENCE_TEXT[c];
      const n = counts.get(c) ?? 0;
      return `<div class="card c-${c}"><div><b class="n">${n}</b> <b>${esc(t.label?.(b, h) ?? t.title)}</b></div><p>${esc(t.sub(b, h))}</p></div>`;
    };
    const side = (i: number) => `m${i % 3}`;
    const valueCell = (
      value: string | null,
      against: string | null,
      cls: string,
      who: string,
      context: boolean,
    ) => {
      if (value === null) return `<td class="${cls} absent">not on ${esc(who)}</td>`;
      if (context || against === null) return `<td class="${cls}${context ? ' ctx' : ''}">${esc(value)}</td>`;
      return `<td class="${cls}">${wordDiff(value, against)
        .a.map((w) => (w.changed ? `<mark>${esc(w.text)}</mark>` : esc(w.text)))
        .join('')}</td>`;
    };
    const span = input.members.length + 3;
    const rowsHtml = (rows: GridRow[]) =>
      rows
        .map((r) => {
          if (r.fold) return `<tr class="fold"><td colspan="${span}">${esc(r.fold)}</td></tr>`;
          const context = !r.note && r.cells.every((c) => c.same);
          // The baseline's words are lit against the first member that differs.
          const first = r.cells.find((c) => !c.same && c.value !== null)?.value ?? null;
          const dot = r.consequence ? `<i class="dot c-${r.consequence}"></i>` : '';
          return (
            `<tr${context ? ' class="ctx"' : ''}><td class="name">${esc(r.name ?? '(table)')}</td>` +
            valueCell(r.baseline, first, 'base', b, context) +
            r.cells
              .map((c, i) =>
                c.same && !context
                  ? `<td class="${side(i)} same">same</td>`
                  : valueCell(c.same ? r.baseline : c.value, r.baseline, side(i), names[i], context),
              )
              .join('') +
            `<td class="note">${dot}${esc(r.note)}</td></tr>`
          );
        })
        .join('\n');
    const head = `<thead><tr><th>Column / key</th><th class="base">★ ${esc(b)} <small>baseline</small></th>${names
      .map((n, i) => `<th class="${side(i)}">${esc(n)}</th>`)
      .join('')}<th>What differs</th></tr></thead>`;
    const tableHtml = (s: Section) => {
      const folds = s.rows.some((r) => r.fold);
      return `<section>
<h3><code>${esc(s.entry.table)}</code> <span>${esc(s.summary)}</span></h3>
<table>
${head}
<tbody>
${rowsHtml(s.rows)}
</tbody>
</table>
${folds ? `<details><summary>Whole table</summary><table>${head}<tbody>\n${rowsHtml(s.whole)}\n</tbody></table></details>` : ''}
</section>`;
    };
    const sideLine = (s: ReportSide, cls: string, label: string) =>
      `<p class="meta"><span class="side ${cls}">${label}${esc(s.name)}</span> schema <code>${esc(s.schema)}</code>, ${esc(read(s))}</p>`;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="overdb ${esc(input.version)}">
<title>${esc(title)}</title>
<style>
:root{--bg:#fbfbfc;--fg:#1a1a1f;--muted:#5a5a66;--faint:#74747f;--line:rgba(0,0,0,.1);--card:rgba(0,0,0,.035);
--base:13 148 136;--m0:194 65 12;--m1:109 40 217;--m2:190 24 93;--breaks:205 33 33;--integrity:182 61 11;--behaviour:141 86 6;--performance:29 78 216;--extra:89 66 255;--cosmetic:116 116 132;--pending:4 113 82}
@media (prefers-color-scheme:dark){:root{--bg:#1b1b20;--fg:#dcdce2;--muted:#9b9ba6;--faint:#8a8a96;--line:rgba(255,255,255,.08);--card:rgba(255,255,255,.035);
--base:94 234 212;--m0:253 186 116;--m1:196 181 253;--m2:249 168 212;--breaks:248 113 113;--integrity:251 146 60;--behaviour:251 191 36;--performance:147 197 253;--extra:127 110 242;--cosmetic:155 155 166;--pending:52 211 153}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:1280px;margin:0 auto;padding:32px 20px 48px}
h1{font-size:22px;margin:0 0 6px}
h2{font-size:15px;margin:32px 0 8px}
h3{font-size:14px;margin:0 0 8px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
h3 span,.meta,.foot,small{color:var(--muted);font-weight:400}
code,td,pre{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:12px}
.meta{margin:0 0 4px}
.side{display:inline-block;padding:1px 8px;border-radius:5px;font-weight:600;margin-right:4px;color:var(--fg)}
${['base', 'm0', 'm1', 'm2'].map((k) => `.side.${k}{background:rgb(var(--${k})/.12);box-shadow:inset 0 0 0 1px rgb(var(--${k})/.4)}`).join('\n')}
.warn{color:rgb(var(--behaviour));margin:8px 0 0}
.verdict{font-size:15px;font-weight:600;margin:4px 0}
.verdicts{margin:20px 0 12px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin-bottom:8px}
.card{padding:10px 12px;border-radius:7px;background:var(--card);border:1px solid var(--line);box-shadow:inset 0 3px 0 rgb(var(--c))}
.card p{margin:3px 0 0;font-size:12px;color:var(--muted)}
.card .n{font-size:17px;color:rgb(var(--c))}
${CONSEQUENCE_ORDER.map((c) => `.c-${c}{--c:var(--${c})}`).join('')}
section{margin-top:28px}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;table-layout:fixed;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
th{font:600 11px -apple-system,system-ui,sans-serif;text-align:left;padding:8px 10px;color:var(--muted);border-bottom:1px solid var(--line)}
th:first-child{width:18%}th:last-child{width:13%}
td{padding:6px 10px;vertical-align:top;border-top:1px solid var(--line);word-break:break-word}
${['base', 'm0', 'm1', 'm2']
  .map(
    (k) =>
      `.${k}{border-left:3px solid rgb(var(--${k})/.6);background:rgb(var(--${k})/.05)}th.${k}{color:rgb(var(--${k}))}td.${k} mark{background:rgb(var(--${k})/.25);color:inherit;border-radius:3px;padding:0 2px}td.${k}.absent{color:rgb(var(--${k}));background:repeating-linear-gradient(135deg,rgb(var(--${k})/.09) 0 6px,transparent 6px 12px)}`,
  )
  .join('\n')}
td.absent{font:italic 12px -apple-system,system-ui,sans-serif}
td.same{color:var(--faint);font:12px -apple-system,system-ui,sans-serif}
tr.ctx td,td.ctx{color:var(--muted)}
tr.fold td{background:var(--card);color:var(--faint);font-style:italic;padding:4px 10px}
td.note{font:12px -apple-system,system-ui,sans-serif;color:var(--muted)}
.dot{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:6px;background:rgb(var(--c))}
details{margin-top:6px}summary{cursor:pointer;color:var(--muted);font-size:12px}
pre{background:var(--card);border:1px solid var(--line);border-radius:7px;padding:12px;white-space:pre-wrap;word-break:break-word}
ul{padding-left:20px}li code{font-size:12px}
.foot{margin-top:40px;font-size:12px;border-top:1px solid var(--line);padding-top:12px}
@media (max-width:700px){table{table-layout:auto}.scroll table{min-width:${480 + input.members.length * 160}px}}
@media print{details{display:none}section{break-inside:avoid}}
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
<p class="meta">Set <b>${esc(input.setName)}</b> · generated ${esc(at)}</p>
${sideLine(input.baseline, 'base', '★ ')}
${input.members.map((m, i) => sideLine(m.side, side(i), '')).join('\n')}
${kept.length ? `<p class="warn">${esc(kept.map((s) => s.name).join(' and '))} could not be reached; compared through the catalog overdb last read.</p>` : ''}
<div class="verdicts">${verdicts.map((v) => `<p class="verdict">${esc(v)}</p>`).join('')}</div>
<div class="cards">${cards.map(card).join('')}</div>
${sections.map((s) => `<div class="scroll">${tableHtml(s)}</div>`).join('\n')}
${
  pending.length
    ? `<h2>Not deployed yet</h2><p class="meta">Tables only ${esc(b)} has. Not counted as drift.</p><ul>${pending
        .map((e) => `<li><code>${esc(e.table)}</code> — not on ${esc(lacking(e).join(', '))}</li>`)
        .join('')}</ul>`
    : ''
}
${
  ignoredTables.length
    ? `<h2>Left out by ignore rules</h2><p class="meta">${ignoredTables.length} table${ignoredTables.length === 1 ? '' : 's'} only one side has, hidden by ${input.ignorePatterns
        .map((p) => `<code>${esc(p)}</code>`)
        .join(', ')}.</p><details><summary>Which</summary><ul>${ignored
        .map((t) => `<li><code>${esc(t.table)}</code> · ${esc(t.pattern)}${one ? '' : ` · ${esc(t.member)}`}</li>`)
        .join('')}</ul></details>`
    : ''
}
${sqls
  .map(
    (m) =>
      `<h2>Proposed SQL for ${esc(m.side.name)}</h2><p class="meta">Text only — nothing was run.</p><details><summary>Show</summary><pre>${esc(m.sql.trim())}</pre></details>`,
  )
  .join('\n')}
<p class="foot">overdb ${esc(input.version)} · compared catalogs only; no rows were read, and nothing was run.</p>
</main>
</body>
</html>
`;
  }
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/// Markdown table cells: a pipe ends the cell, a newline ends the row.
function md(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/// Inline code that survives a backtick in the value.
function code(text: string): string {
  const clean = text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return clean.includes('`') ? `\`\` ${clean} \`\`` : `\`${clean}\``;
}

function stamp(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server';
}
