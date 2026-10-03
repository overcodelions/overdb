import { useEffect, useState } from 'react';
import { useStore } from './store';
import { FORMAT_STYLES, formatSql } from '@shared/formatSql';
import type { FormatStyle } from '@shared/formatSql';
import type { AiTool, AppSettings } from '@shared/types';

/// Short enough to read at 10px, long enough that the five layouts look
/// different from each other — a SELECT list, a join and a condition.
const FORMAT_SAMPLE =
  'select c.name, count(*) as orders from customer c ' +
  'join sales_order o on (o.customer_id = c.id) ' +
  "where c.region = 'EU' group by c.name";

const AI_TOOLS: AiTool[] = ['claude', 'codex', 'gemini'];

/// One entry per pane, in the order a new user meets them: how the app
/// looks, then what a query does, then the parts that need a model.
const SECTIONS = [
  { id: 'general', label: 'General', lede: 'How overdb looks and how its panes behave.' },
  { id: 'queries', label: 'Queries', lede: 'What happens when a statement runs.' },
  { id: 'formatting', label: 'SQL formatting', lede: 'The layout Format produces. Pick one and see it on a real statement.' },
  { id: 'ai', label: 'AI', lede: 'Which CLI answers questions and which models it uses. overdb uses your own login — no key is stored here, and nothing is sent anywhere else.' },
  { id: 'maps', label: 'Database maps', lede: 'What overdb learned about a database by reading its code once, so seeds plan in seconds.' },
] as const;
export type SettingsSection = (typeof SECTIONS)[number]['id'];

type Patch = (next: Partial<AppSettings>) => void;

/// A rail of sections on the left, one pane on the right, and a single bar
/// that commits everything. A long scroll made you read every setting to
/// find one; a rail names the five places a setting can be.
export function SettingsSheet({ section: initial }: { section?: SettingsSection }): JSX.Element {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const setSheet = useStore((s) => s.setSheet);

  // Edits are held until Save. Settings that reach through to a live
  // connection — the row limit, the model a question is about to use —
  // should not change under a query you are halfway through running.
  const [draft, setDraft] = useState(settings);
  const [section, setSection] = useState<SettingsSection>(initial ?? 'general');
  const [tools, setTools] = useState<Record<AiTool, boolean> | null>(null);
  useEffect(() => {
    void window.overdb.invoke('ai:detect').then(setTools);
  }, []);

  const patch: Patch = (next) => setDraft((d) => ({ ...d, ...next }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const save = () => {
    saveSettings(draft);
    setSheet(null);
  };

  // ⌘S saves, as it would in any document; the sheet is one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (dirty) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex flex-1 min-h-0">
        <nav className="w-[196px] shrink-0 border-r border-card bg-wash flex flex-col">
          <h2 className="px-4 pt-4 pb-3 text-sm font-semibold text-ink">Settings</h2>
          <div className="flex flex-col gap-0.5 px-2">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={`flex items-center gap-2.5 text-left text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                  section === s.id
                    ? 'bg-accent/15 text-ink'
                    : 'text-ink-muted hover:text-ink hover:bg-wash-strong'
                }`}
              >
                <span className={section === s.id ? 'text-accent' : 'text-ink-faint'}>
                  <SectionIcon id={s.id} />
                </span>
                {s.label}
              </button>
            ))}
          </div>
        </nav>

        <div className="flex-1 min-w-0 overflow-y-auto">
          <div className="max-w-[600px] px-7 py-6">
            <header className="mb-5">
              <h3 className="text-base font-semibold text-ink">{current.label}</h3>
              <p className="mt-1 text-xs text-ink-muted leading-relaxed">{current.lede}</p>
            </header>
            {section === 'general' && <GeneralPane draft={draft} patch={patch} />}
            {section === 'queries' && <QueriesPane draft={draft} patch={patch} />}
            {section === 'formatting' && <FormattingPane draft={draft} patch={patch} />}
            {section === 'ai' && <AiPane draft={draft} patch={patch} tools={tools} />}
            {section === 'maps' && <MapsPane draft={draft} patch={patch} />}
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-card px-5 py-3 flex items-center gap-2">
        <span className={`text-[11px] ${dirty ? 'text-warn' : 'text-ink-faint'}`}>
          {dirty ? 'Unsaved changes' : 'All changes saved'}
        </span>
        <div className="flex-1" />
        {dirty && (
          <button
            onClick={() => setDraft(settings)}
            className="text-xs px-3 py-1.5 rounded text-ink-muted hover:text-ink hover:bg-card"
          >
            Revert
          </button>
        )}
        <button
          onClick={() => setSheet(null)}
          className="text-xs px-3 py-1.5 rounded border border-card text-ink-muted hover:text-ink hover:bg-card"
        >
          {dirty ? 'Discard' : 'Close'}
        </button>
        <button
          onClick={save}
          disabled={!dirty}
          title="Save (⌘S)"
          className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  );
}

// ---------- Panes ----------

function GeneralPane({ draft, patch }: { draft: AppSettings; patch: Patch }): JSX.Element {
  const hints = draft.dismissedHints.length;
  return (
    <>
      <Group title="Appearance">
        <Row label="Theme" help="System follows your Mac's appearance and switches with it.">
          <ThemePicker value={draft.theme} onChange={(theme) => patch({ theme })} />
        </Row>
      </Group>

      <Group title="Panes">
        <Row
          label="Open Health and Slow queries full window"
          help="They show what the server is doing, not the result of your statement, so they get the whole window. Each pane can still dock itself under the editor."
        >
          <Toggle value={draft.panesFull} onChange={(panesFull) => patch({ panesFull })} />
        </Row>
      </Group>

      <Group title="Tips">
        <Row
          label="Dismissed tips"
          help={
            hints === 0
              ? 'You have not closed any tips. Tips you close with Not now stay closed.'
              : `You have closed ${hints} ${hints === 1 ? 'tip' : 'tips'}. Bring them back to see them again.`
          }
        >
          <button
            disabled={hints === 0}
            onClick={() => patch({ dismissedHints: [] })}
            className="text-xs px-3 py-1 rounded border border-card text-ink-muted hover:text-ink hover:bg-card disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Show again
          </button>
        </Row>
      </Group>
    </>
  );
}

function QueriesPane({ draft, patch }: { draft: AppSettings; patch: Patch }): JSX.Element {
  return (
    <Group title="Results">
      <Row
        label="Row limit"
        help="A result stops at this many rows and offers to keep going. The cap is on purpose: an unbounded fetch is how a client runs your machine out of memory. Up to 100,000."
      >
        <NumberInput
          value={draft.rowLimit}
          min={100}
          max={100000}
          step={100}
          suffix="rows"
          onChange={(n) => patch({ rowLimit: Math.min(n || 10_000, 100_000) })}
        />
      </Row>
      <Row
        label="Offer to explain slow queries"
        help={
          draft.slowQueryMs === 0
            ? 'Off. Set a threshold to have slow statements offer an explanation of their plan.'
            : `A statement that takes longer than ${draft.slowQueryMs.toLocaleString()} ms offers to explain its plan. 0 turns this off.`
        }
      >
        <NumberInput
          value={draft.slowQueryMs}
          min={0}
          step={250}
          suffix="ms"
          onChange={(n) => patch({ slowQueryMs: Math.max(0, n || 0) })}
        />
      </Row>
    </Group>
  );
}

function FormattingPane({ draft, patch }: { draft: AppSettings; patch: Patch }): JSX.Element {
  return (
    <>
      <Group title="Layout">
        <div role="radiogroup" className="flex flex-col">
          {FORMAT_STYLES.map((f) => (
            <Choice
              key={f.id}
              selected={draft.formatStyle === f.id}
              onSelect={() => patch({ formatStyle: f.id as FormatStyle })}
              label={f.label}
              help={f.blurb}
            />
          ))}
        </div>
      </Group>
      {/* The sample is the argument. Naming five layouts tells you nothing;
          seeing the same statement in the one you picked tells you whether
          you want it. */}
      <Group title="Preview">
        <pre className="p-3 font-mono text-[11px] leading-[1.5] text-ink-muted overflow-x-auto whitespace-pre">
{formatSql(FORMAT_SAMPLE, draft.formatStyle)}
        </pre>
      </Group>
    </>
  );
}

function AiPane({
  draft,
  patch,
  tools,
}: {
  draft: AppSettings;
  patch: Patch;
  tools: Record<AiTool, boolean> | null;
}): JSX.Element {
  const installed = AI_TOOLS.filter((t) => tools?.[t]);
  // Which CLI the model boxes are for: the chosen one, or the one that
  // would be chosen if nothing is.
  const tool: AiTool = draft.aiTool ?? installed[0] ?? 'claude';

  return (
    <>
      <Group title="Assistant">
        <Row label="Installed CLIs" help="Install another and it appears here the next time Settings opens.">
          <div className="flex gap-1.5">
            {AI_TOOLS.map((t) => (
              <span
                key={t}
                className={`inline-flex items-center gap-1.5 text-[11px] font-mono px-2 py-0.5 rounded-full border border-card ${
                  tools?.[t] ? 'text-ink' : 'text-ink-faint'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    tools === null ? 'bg-ink-faint animate-pulse' : tools[t] ? 'bg-good' : 'bg-ink-faint/40'
                  }`}
                />
                {t}
              </span>
            ))}
          </div>
        </Row>
        {tools !== null && installed.length === 0 ? (
          <div className="px-4 py-3 text-[11px] text-ink-muted leading-relaxed">
            No AI CLI found. Install <code className="font-mono">claude</code>,{' '}
            <code className="font-mono">codex</code> or <code className="font-mono">gemini</code> and
            sign in, and Ask, Seed and the other AI features appear.
          </div>
        ) : (
          <Row label="Use" help="First installed picks claude, then codex, then gemini.">
            <select
              className="field px-2 py-1 text-xs w-40"
              value={draft.aiTool ?? ''}
              disabled={tools === null}
              onChange={(e) => patch({ aiTool: (e.target.value || null) as AiTool | null })}
            >
              <option value="">First installed</option>
              {installed.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Row>
        )}
      </Group>

      {installed.length > 0 && (
        <Group
          title={`Models for ${tool}`}
          note={
            <>
              Each box takes any model name <code className="font-mono">{tool}</code> itself accepts.
              Blank uses its own default — a wrong name is a hard error, so overdb never guesses one.
            </>
          }
        >
          <Row label="Everyday" help="Answers questions in Ask and explains plans.">
            <ModelInput
              value={draft.aiModel[tool]}
              onChange={(v) => patch({ aiModel: { ...draft.aiModel, [tool]: v } })}
            />
          </Row>
          <Row label="Fast" help="Calls that fire while you wait: turning a question into SQL, fixing a failed statement.">
            <ModelInput
              value={draft.aiFastModel[tool]}
              onChange={(v) => patch({ aiFastModel: { ...draft.aiFastModel, [tool]: v } })}
            />
          </Row>
          {tool === 'claude' && (
            <Row
              label="Map"
              help="Reads your repos to map a database. A map is written rarely and read often, so it defaults to sonnet, the standard tier."
            >
              <ModelInput value={draft.aiMapModel} onChange={(aiMapModel) => patch({ aiMapModel })} />
            </Row>
          )}
        </Group>
      )}
    </>
  );
}

function MapsPane({ draft, patch }: { draft: AppSettings; patch: Patch }): JSX.Element {
  const location = draft.mapLocation ?? 'overdb';
  return (
    <Group title="Where maps are kept">
      <div role="radiogroup" className="flex flex-col">
        <Choice
          selected={location === 'overdb'}
          onSelect={() => patch({ mapLocation: 'overdb' })}
          label="In overdb, on this machine"
          help="Kept in overdb's own folder. Private to you, and nothing in your repos changes."
        />
        <Choice
          selected={location === 'repo'}
          onSelect={() => patch({ mapLocation: 'repo' })}
          label="In the recipe repo"
          help={
            <>
              Saved to <code className="font-mono">.overdb/map/</code> in the repo a base recipe lives in. Commit it
              and your team gets the map through git without mapping again.
            </>
          }
        />
      </div>
    </Group>
  );
}

// ---------- Building blocks ----------

/// A titled card of rows. Settings without grouping is a list of unrelated
/// controls, and the reader has to hold the taxonomy in their head.
function Group({
  title,
  note,
  children,
}: {
  title: string;
  note?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="mb-6">
      <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">{title}</h4>
      <div className="rounded-lg border border-card bg-card divide-y divide-rule">{children}</div>
      {note && <p className="mt-2 px-1 text-[11px] text-ink-faint leading-relaxed">{note}</p>}
    </section>
  );
}

/// What a setting is and why you would change it on the left, the control
/// on the right. The explanation sits under the name it explains, not
/// under the control, so the eye reads one column then acts in the other.
function Row({
  label,
  help,
  children,
}: {
  label: string;
  help?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-6 px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="text-xs text-ink">{label}</div>
        {help && <div className="mt-0.5 text-[11px] text-ink-faint leading-relaxed">{help}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/// One option of a radio group, written out with what picking it means.
function Choice({
  selected,
  onSelect,
  label,
  help,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  help: React.ReactNode;
}): JSX.Element {
  return (
    <button
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex items-start gap-3 px-4 py-3 text-left transition-colors border-t border-rule first:border-t-0 first:rounded-t-lg last:rounded-b-lg ${
        selected ? 'bg-accent/10' : 'hover:bg-wash-strong'
      }`}
    >
      <span
        className={`mt-0.5 w-3.5 h-3.5 shrink-0 rounded-full border flex items-center justify-center ${
          selected ? 'border-accent' : 'border-ink-faint'
        }`}
      >
        {selected && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
      </span>
      <span className="min-w-0">
        <span className="block text-xs text-ink">{label}</span>
        <span className="block mt-0.5 text-[11px] text-ink-faint leading-relaxed">{help}</span>
      </span>
    </button>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`relative w-8 h-[18px] rounded-full transition-colors ${value ? 'bg-accent' : 'bg-wash-strong border border-card'}`}
    >
      <span
        className={`absolute top-[2px] w-3.5 h-3.5 rounded-full bg-white shadow transition-all ${
          value ? 'left-[16px]' : 'left-[2px]'
        }`}
      />
    </button>
  );
}

function NumberInput({
  value,
  onChange,
  suffix,
  ...range
}: {
  value: number;
  onChange: (n: number) => void;
  suffix: string;
  min?: number;
  max?: number;
  step?: number;
}): JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <input
        type="number"
        className="field px-2 py-1 text-xs w-24 text-right tabular-nums"
        value={value}
        {...range}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="w-7 text-[11px] text-ink-faint">{suffix}</span>
    </span>
  );
}

function ModelInput({ value, onChange }: { value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <input
      className="field px-2 py-1 text-xs w-40 font-mono"
      value={value}
      placeholder="CLI default"
      spellCheck={false}
      onChange={(e) => onChange(e.target.value.trim())}
    />
  );
}

function ThemePicker({
  value,
  onChange,
}: {
  value: AppSettings['theme'];
  onChange: (v: AppSettings['theme']) => void;
}): JSX.Element {
  const options: Array<{ id: AppSettings['theme']; label: string }> = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'system', label: 'System' },
  ];
  return (
    <div className="flex gap-2">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`flex flex-col items-center gap-1 p-1.5 rounded-lg border transition-colors ${
            value === o.id ? 'border-accent bg-accent/10' : 'border-card hover:bg-wash-strong'
          }`}
        >
          <ThemeSwatch kind={o.id} />
          <span className={`text-[10px] ${value === o.id ? 'text-ink' : 'text-ink-muted'}`}>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/// A thumbnail of the app in each theme: a sidebar, two lines of text and
/// an accent. System is both, split down the diagonal.
function ThemeSwatch({ kind }: { kind: AppSettings['theme'] }): JSX.Element {
  const light = { bg: '#f6f6f8', side: '#e9e9ee', fg: '#c4c4cc', accent: '#6d5dfc' };
  const dark = { bg: '#1c1c21', side: '#141418', fg: '#3a3a44', accent: '#7c6cff' };
  const pane = (c: typeof light) => (
    <>
      <rect width="44" height="28" fill={c.bg} />
      <rect width="12" height="28" fill={c.side} />
      <rect x="16" y="6" width="20" height="2.5" rx="1" fill={c.fg} />
      <rect x="16" y="11" width="14" height="2.5" rx="1" fill={c.fg} />
      <rect x="16" y="18" width="10" height="4" rx="1" fill={c.accent} />
    </>
  );
  return (
    <svg viewBox="0 0 44 28" className="w-11 h-7 rounded overflow-hidden block" aria-hidden="true">
      {kind === 'system' ? (
        <>
          <defs>
            <clipPath id="swatch-dark-half">
              <polygon points="44,0 44,28 0,28" />
            </clipPath>
          </defs>
          {pane(light)}
          <g clipPath="url(#swatch-dark-half)">{pane(dark)}</g>
        </>
      ) : (
        pane(kind === 'dark' ? dark : light)
      )}
    </svg>
  );
}

function SectionIcon({ id }: { id: SettingsSection }): JSX.Element {
  const paths: Record<SettingsSection, React.ReactNode> = {
    general: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" />
      </>
    ),
    queries: (
      <>
        <ellipse cx="12" cy="5.5" rx="7.5" ry="2.5" />
        <path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5" />
      </>
    ),
    formatting: <path d="M4 6h16M4 10h10M8 14h12M8 18h8" />,
    ai: <path d="M12 3.5 13.6 8.9 19 10.5 13.6 12.1 12 17.5 10.4 12.1 5 10.5 10.4 8.9Z" />,
    maps: <path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4ZM9 4v14M15 6v14" />,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-3.5 h-3.5 block"
      aria-hidden="true"
    >
      {paths[id]}
    </svg>
  );
}
