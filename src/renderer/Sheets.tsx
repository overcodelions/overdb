import { useEffect, useState } from 'react';
import { ConnectionForm } from './ConnectionForm';
import { EnvSetForm } from './EnvSetForm';
import { AboutSheet, BasicsSheet, ShortcutsSheet } from './Help';
import { ImportSheet } from './ImportSheet';
import { SeedSheet } from './SeedSheet';
import { TablePicker } from './TablePicker';
import { useStore } from './store';
import { FORMAT_STYLES, formatSql } from '@shared/formatSql';
import type { FormatStyle } from '@shared/formatSql';
import type { AiTool } from '@shared/types';

/// Short enough to read at 10px, long enough that the five layouts look
/// different from each other — a SELECT list, a join and a condition.
const FORMAT_SAMPLE =
  'select c.name, count(*) as orders from customer c ' +
  'join sales_order o on (o.customer_id = c.id) ' +
  "where c.region = 'EU' group by c.name";

/// Backdrop + escape-to-close wrapper shared by every sheet, so no
/// individual sheet has to remember the dismissal rules.
export function SheetHost(): JSX.Element | null {
  const sheet = useStore((s) => s.sheet);
  const setSheet = useStore((s) => s.setSheet);

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheet(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet, setSheet]);

  if (!sheet) return null;

  // The help sheets explain in paragraphs and two columns; at a form's
  // width they would be a long thin scroll. One frame for all three, so
  // following a footer link does not resize the sheet under the pointer.
  const help = sheet.kind === 'about' || sheet.kind === 'basics' || sheet.kind === 'shortcuts';

  return (
    <div
      // Sheets hang from near the top so a form that grows as you fill it
      // grows downward instead of jumping. The seed sheet has a fixed
      // height — it cannot jump — so it sits in the middle, where a tall
      // dialog belongs.
      className={`fixed inset-0 z-40 flex justify-center bg-black/40 ${
        sheet.kind === 'seed' ? 'items-center py-6' : `items-start ${help ? 'pt-14' : 'pt-24'}`
      }`}
      onClick={() => setSheet(null)}
    >
      <div
        className={`${
          help
            ? 'w-[760px] max-w-[calc(100vw-48px)] max-h-[80vh] overflow-hidden'
            : sheet.kind === 'seed'
              // A five-step flow with a plan and a script side by side: it
              // needs a fixed frame, or every step resizes under the pointer.
              // Grows with the window up to a comfortable reading size: a
              // plan beside its rules, or a script beside its checks, needs
              // the room, and at 880×720 both were scrolling in slivers.
              ? 'w-[min(1200px,calc(100vw-96px))] h-[min(900px,calc(100vh-96px))] min-w-[min(880px,calc(100vw-48px))] min-h-[min(640px,calc(100vh-48px))] flex flex-col overflow-hidden'
              : `${sheet.kind === 'importConnections' ? 'w-[680px]' : 'w-[520px]'} max-w-[calc(100vw-48px)] max-h-[70vh] flex flex-col overflow-hidden`
        } rounded-lg border border-card bg-surface-elevated shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        {sheet.kind === 'about' && <AboutSheet />}
        {sheet.kind === 'basics' && <BasicsSheet />}
        {sheet.kind === 'shortcuts' && <ShortcutsSheet />}
        {sheet.kind === 'settings' && <SettingsSheet />}
        {sheet.kind === 'newConnection' && (
          <ConnectionForm found={sheet.found} onDone={() => setSheet(null)} />
        )}
        {sheet.kind === 'editConnection' && <EditConnectionSheet id={sheet.id} failure={sheet.failure} />}
        {sheet.kind === 'importConnections' && <ImportSheet />}
        {sheet.kind === 'newEnvSet' && (
          <EnvSetForm suggested={sheet.suggested} onDone={() => setSheet(null)} />
        )}
        {sheet.kind === 'editEnvSet' && (
          <EnvSetForm id={sheet.id} onDone={() => setSheet(null)} />
        )}
        {sheet.kind === 'seed' && <SeedSheet connectionId={sheet.connectionId} />}
        {sheet.kind === 'pickTables' && (
          <TablePicker connectionId={sheet.connectionId} onClose={() => setSheet(null)} />
        )}
      </div>
    </div>
  );
}

function SettingsSheet(): JSX.Element {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const setSheet = useStore((s) => s.setSheet);

  // Edits are held until Save. Settings that reach through to a live
  // connection — the row limit, the model a question is about to use —
  // should not change under a query you are halfway through running.
  const [draft, setDraft] = useState(settings);
  const [tools, setTools] = useState<Record<AiTool, boolean> | null>(null);
  useEffect(() => {
    void window.overdb.invoke('ai:detect').then(setTools);
  }, []);

  const patch = (next: Partial<typeof settings>) => setDraft((d) => ({ ...d, ...next }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const installed = (['claude', 'codex', 'gemini'] as AiTool[]).filter((t) => tools?.[t]);
  // Which CLI the model boxes below are for: the chosen one, or the one
  // that would be chosen if nothing is.
  const tool: AiTool = draft.aiTool ?? installed[0] ?? 'claude';

  return (
    <div className="flex flex-col min-h-0">
      <div className="px-5 pt-5 pb-3 border-b border-card shrink-0">
        <h2 className="text-sm font-semibold text-ink">Settings</h2>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-6">
        <Group title="Appearance">
          <Field label="Theme">
            <select
              className="field px-2 py-1 text-xs w-36"
              value={draft.theme}
              onChange={(e) => patch({ theme: e.target.value as typeof settings.theme })}
            >
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </Field>
        </Group>

        <Group title="Results">
          <Field label="Row limit">
            <input
              type="number"
              className="field px-2 py-1 text-xs w-28 text-right"
              value={draft.rowLimit}
              min={100}
              max={100000}
              step={100}
              onChange={(e) => patch({ rowLimit: Math.min(Number(e.target.value) || 10_000, 100_000) })}
            />
          </Field>
          <Note>
            Results stop at this many rows and offer to keep going. Bounded on purpose — an
            unbounded fetch is how a client runs your machine out of memory.
          </Note>

          <Field label="Offer to explain queries slower than">
            <span className="flex items-center gap-1">
              <input
                type="number"
                className="field px-2 py-1 text-xs w-24 text-right"
                value={draft.slowQueryMs}
                min={0}
                step={250}
                onChange={(e) => patch({ slowQueryMs: Math.max(0, Number(e.target.value) || 0) })}
              />
              <span className="text-ink-faint text-xs">ms</span>
            </span>
          </Field>
          <Note>0 turns the nudge off.</Note>
        </Group>

        <Group title="SQL layout">
          <Field label="Format produces">
            <select
              className="field px-2 py-1 text-xs w-44"
              value={draft.formatStyle}
              onChange={(e) => patch({ formatStyle: e.target.value as FormatStyle })}
            >
              {FORMAT_STYLES.map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
          </Field>
          <Note>{FORMAT_STYLES.find((f) => f.id === draft.formatStyle)?.blurb}</Note>
          {/* The sample is the argument. Naming five layouts tells you
              nothing; seeing the same statement in the one you picked tells
              you whether you want it. */}
          <pre className="mt-1 p-2.5 rounded bg-card border border-card font-mono text-[10px] leading-[1.45] text-ink-muted overflow-x-auto whitespace-pre">
{formatSql(FORMAT_SAMPLE, draft.formatStyle)}
          </pre>
        </Group>

        <Group title="AI">
          {tools === null ? (
            <Note>Looking for installed CLIs…</Note>
          ) : installed.length === 0 ? (
            <Note>
              No AI CLI found. overdb uses your own login for <code className="font-mono">claude</code>,{' '}
              <code className="font-mono">codex</code> or <code className="font-mono">gemini</code> —
              install one and the AI features appear. Nothing is sent anywhere else, and no key is
              stored here.
            </Note>
          ) : (
            <>
              <Field label="Use">
                <select
                  className="field px-2 py-1 text-xs w-36"
                  value={draft.aiTool ?? ''}
                  onChange={(e) => patch({ aiTool: (e.target.value || null) as AiTool | null })}
                >
                  <option value="">First installed</option>
                  {installed.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </Field>
              {installed.length < 3 && (
                <Note>
                  Only {installed.join(' and ')} {installed.length === 1 ? 'is' : 'are'} installed.
                  The others appear here once they are.
                </Note>
              )}

              <Field label={`Model (${tool})`}>
                <input
                  className="field px-2 py-1 text-xs w-40 font-mono"
                  value={draft.aiModel[tool]}
                  placeholder="the CLI's default"
                  onChange={(e) => patch({ aiModel: { ...draft.aiModel, [tool]: e.target.value } })}
                />
              </Field>
              <Field label={`Fast model (${tool})`}>
                <input
                  className="field px-2 py-1 text-xs w-40 font-mono"
                  value={draft.aiFastModel[tool]}
                  placeholder="the CLI's default"
                  onChange={(e) =>
                    patch({ aiFastModel: { ...draft.aiFastModel, [tool]: e.target.value } })
                  }
                />
              </Field>
              <Note>
                The fast model is for the calls that fire while you are waiting — turning a question
                into SQL, fixing a failed statement. Both boxes take whatever{' '}
                <code className="font-mono">{tool}</code> itself accepts; blank uses its own default,
                because a wrong model name is a hard error and a guessed one would be worse than none.
              </Note>
            </>
          )}
        </Group>
      </div>

      <div className="shrink-0 border-t border-card px-5 py-3 flex items-center gap-2">
        <span className="text-[11px] text-ink-faint">
          {dirty ? 'Unsaved changes' : 'Saved'}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setSheet(null)}
          className="text-xs px-3 py-1.5 rounded border border-card text-ink-muted hover:text-ink hover:bg-card"
        >
          {dirty ? 'Discard' : 'Close'}
        </button>
        <button
          onClick={() => {
            saveSettings(draft);
            setSheet(null);
          }}
          disabled={!dirty}
          className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  );
}

/// A titled block. Settings without grouping is a list of unrelated
/// controls, and the reader has to hold the taxonomy in their head.
function Group({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex items-center justify-between gap-3 text-xs text-ink">
      <span className="min-w-0">{label}</span>
      {children}
    </label>
  );
}

function Note({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="text-[11px] text-ink-faint leading-snug">{children}</p>;
}

function PlaceholderSheet({ title }: { title: string }): JSX.Element {
  return (
    <div className="p-5">
      <h2 className="text-sm font-semibold text-ink mb-1">{title}</h2>
      <p className="text-xs text-ink-muted">Not built yet.</p>
    </div>
  );
}

function EditConnectionSheet({ id, failure }: { id: string; failure?: string }): JSX.Element {
  const connection = useStore((s) => s.connections.find((c) => c.id === id));
  const setSheet = useStore((s) => s.setSheet);
  if (!connection) {
    return <div className="p-5 text-xs text-ink-muted">That connection no longer exists.</div>;
  }
  // Keyed on the id so switching which connection you're editing resets the
  // form's state instead of carrying the previous one's values over.
  return <ConnectionForm key={id} existing={connection} failure={failure} onDone={() => setSheet(null)} />;
}
