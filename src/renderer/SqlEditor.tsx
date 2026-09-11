import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  highlightActiveLine,
  keymap,
  lineNumberMarkers,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  acceptCompletion,
  autocompletion,
  completionKeymap,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { keywordCompletionSource, schemaCompletionSource, sql } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { SchemaSnapshot } from '@shared/types';
import { looksLikeQuestion } from '@shared/looksLikeSql';
import { splitStatements, type Statement } from '@shared/sqlGuard';
import { useIsDark } from './useThemeEffect';
import { paramChips, type ParamContext } from './paramChips';
import {
  columnCompletionSource,
  defaultSchemaName,
  dialectFor,
  joinCompletionSource,
  namespaceFor,
} from './sqlSchema';

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'rgb(var(--c-accent))' },
  // Variables rather than fixed hues: the dark steps are washed out on a
  // white editor, and these have to stay legible on both surfaces.
  { tag: tags.string, color: 'rgb(var(--c-sql-string))' },
  { tag: tags.number, color: 'rgb(var(--c-sql-number))' },
  { tag: tags.comment, color: 'rgb(var(--c-ink-faint))', fontStyle: 'italic' },
  { tag: tags.operator, color: 'rgb(var(--c-ink-muted))' },
]);

const themeSpec = {
  '&': { backgroundColor: 'transparent', color: 'rgb(var(--c-ink))', height: '100%' },
  '.cm-content': {
    fontFamily: 'SF Mono, Menlo, Consolas, monospace',
    fontSize: '12px',
    caretColor: 'rgb(var(--c-accent))',
    padding: '8px 0',
  },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'rgb(var(--c-ink-faint))', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--c-card-bg)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'rgb(var(--c-ink-muted))' },
  '&.cm-focused': { outline: 'none' },
  // The caret is a border on a zero-width element, so `caretColor` alone
  // does not colour it — without this it inherits near-black and vanishes
  // against a dark editor.
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'rgb(var(--c-accent))',
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'rgb(var(--c-accent))' },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'rgb(var(--c-accent) / 0.32)',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgb(var(--c-accent) / 0.38)',
  },
  '.cm-tooltip-autocomplete': {
    backgroundColor: 'rgb(var(--c-surface-elevated))',
    border: '1px solid var(--c-card-border)',
    borderRadius: '6px',
    fontFamily: 'SF Mono, Menlo, Consolas, monospace',
    fontSize: '11px',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'rgb(var(--c-accent) / 0.30)',
    color: 'rgb(var(--c-ink))',
  },
  '.cm-completionDetail': { color: 'rgb(var(--c-ink-faint))', fontStyle: 'normal', marginLeft: '1em' },
};

// `dark` tells CodeMirror which way its own defaults should go for
// everything we have not overridden — the caret and the selection layer
// among them. It is a build-time flag, not a variable, so the theme is
// rebuilt and swapped through a compartment when the preference changes.
const darkTheme = EditorView.theme(themeSpec, { dark: true });
const lightTheme = EditorView.theme(themeSpec, { dark: false });
const themeCompartment = new Compartment();

/// Statements that are plainly English get shown as a question rather than
/// as broken SQL: no keyword colouring, and a tinted band so it reads as
/// something you asked rather than something you wrote. Syntax-highlighting
/// "find me all the panels" makes the editor look like it is failing to
/// parse, when in fact it understood perfectly well.
const statementBlocks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      // selectionSet matters as much as docChanged here: which block is
      // active is what tells you what ⌘↵ is about to run.
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/// The mark that stands in for a question's line number.
///
/// The band tells you a statement is prose once you are looking at it; the
/// gutter is what tells you from the margin, at the same glance that finds
/// the line you were editing. First line only — the band carries the rest,
/// and a column of these down a five-line question would read as five
/// separate things.
/// The same mark the gutter chip carries, at text size. Anywhere a control
/// hands work to a model it wears this, so the two are recognisably the
/// same offer rather than two unrelated buttons.
function Sparkle(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="ai-spark w-[13px] h-[13px] block">
      <path d="M12 3.5 13.6 8.9 19 10.5 13.6 12.1 12 17.5 10.4 12.1 5 10.5 10.4 8.9Z" />
      <path d="M18.2 16.4 18.9 18.6 21 19.3 18.9 20 18.2 22.2 17.5 20 15.4 19.3 17.5 18.6Z" />
    </svg>
  );
}

/// The mark itself, drawn rather than masked: a gutter element is 34px of
/// text, and every CSS route to putting a glyph in one (a background image,
/// a masked pseudo-element, a dingbat character) fails silently in a
/// different way. A real SVG child either renders or does not.
class AiGutterMarker extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }
  // Without this every keystroke tears the marker DOM down and rebuilds it:
  // the default comparison is "never equal". The three markers are
  // singletons, so identity of the class string is identity of the mark.
  eq(other: GutterMarker): boolean {
    return other instanceof AiGutterMarker && other.elementClass === this.elementClass;
  }
  toDOM(): Node {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'cm-ai-mark');
    for (const d of [
      'M12 3.5 13.6 8.9 19 10.5 13.6 12.1 12 17.5 10.4 12.1 5 10.5 10.4 8.9Z',
      'M18.2 16.4 18.9 18.6 21 19.3 18.9 20 18.2 22.2 17.5 20 15.4 19.3 17.5 18.6Z',
    ]) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }
}
/// Three strengths of the same mark, on the FIRST line of a statement:
///
///   question — lit. ⌘↵ hands this to a model right now.
///   active   — dim. The statement you are in; a model is one click away.
///   any      — invisible until you hover its gutter.
///
/// Every statement gets one because the model is available on every
/// statement, and an affordance that only appears where it is already
/// obvious teaches nobody it exists. Only the lit one is a STATE; the
/// others are a door, which is why they are quiet.
const questionGutterMarker = new AiGutterMarker('cm-ai-gutter cm-question-gutter');
const activeGutterMarker = new AiGutterMarker('cm-ai-gutter cm-ai-gutter-active');
const idleGutterMarker = new AiGutterMarker('cm-ai-gutter');

const questionGutter = lineNumberMarkers.compute(['doc', 'selection'], (state) => {
  const doc = state.doc.toString();
  const cursor = state.selection.main.head;
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const statement of splitStatements(doc)) {
    const start = Math.max(0, Math.min(statement.start, doc.length));
    const line = state.doc.lineAt(start);
    const marker = looksLikeQuestion(statement.sql)
      ? questionGutterMarker
      : cursor >= start && cursor <= statement.end + 1
        ? activeGutterMarker
        : idleGutterMarker;
    builder.add(line.from, line.from, marker);
  }
  return builder.finish();
});

const questionMark = Decoration.mark({ class: 'cm-question' });
const questionLine = Decoration.line({ class: 'cm-question-line' });
const stmtLine = Decoration.line({ class: 'cm-stmt-line' });
const stmtActiveLine = Decoration.line({ class: 'cm-stmt-line cm-stmt-active' });

/// Chips, or nothing at all. Nothing is the right answer for an editor with
/// no connection behind it: a value that cannot be resolved must not be
/// drawn as if it had been.
function paramExtension(
  params: Omit<ParamContext, 'onOpen'> | undefined,
  latest: { current: { onParamOpen?: ParamContext['onOpen'] } },
): Extension {
  if (!params) return [];
  return paramChips({
    ...params,
    onOpen: (slot, at) => latest.current.onParamOpen?.(slot, at),
  });
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc.toString();
  const cursor = view.state.selection.main.head;
  const statements = splitStatements(doc);

  for (const statement of statements) {
    const from = Math.max(0, Math.min(statement.start, doc.length));
    const to = Math.max(from, Math.min(statement.end, doc.length));
    const isQuestion = looksLikeQuestion(statement.sql);
    // `end + 1` so a cursor resting on the terminating semicolon still
    // counts as inside — it is the statement ⌘↵ would run.
    const active = cursor >= from && cursor <= to + 1;

    let pos = from;
    for (;;) {
      const line = view.state.doc.lineAt(pos);
      // Line decorations must be added at the line start and in document
      // order, before any mark beginning on the same line.
      builder.add(line.from, line.from, active ? stmtActiveLine : stmtLine);
      if (isQuestion) {
        builder.add(line.from, line.from, questionLine);
        const markFrom = Math.max(from, line.from);
        const markTo = Math.min(to, line.to);
        if (markTo > markFrom) builder.add(markFrom, markTo, questionMark);
      }
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/// Completion is for SQL, and a question is not SQL.
///
/// Offering `partner_group_view_restrictions` while someone types "find me
/// all the partners" is worse than useless: the popup steals the keystrokes
/// that dismiss it, Tab inserts a table name into a sentence, and the whole
/// point of typing English here is that you do NOT have to know the schema.
/// So every source is gated on the statement the cursor is in.
function onlyInSql(source: CompletionSource): CompletionSource {
  return (context) => {
    const doc = context.state.doc.toString();
    const statement = splitStatements(doc).find(
      (s) => context.pos >= s.start && context.pos <= s.end + 1,
    );
    if (statement && looksLikeQuestion(statement.sql)) return null;
    return source(context);
  };
}

/// Swapped out whenever the catalog changes, so completion can light up
/// after introspection finishes without rebuilding the editor and throwing
/// away the user's undo history and cursor.
const schemaCompartment = new Compartment();

/// Swapped whenever a value changes, so a chip repaints the moment its
/// value is edited — and whenever the connection changes, because the same
/// hole resolves to a different value on a different environment.
const paramsCompartment = new Compartment();

function schemaExtensions(snapshot: SchemaSnapshot | undefined, activeSchema?: string) {
  const dialect = dialectFor(snapshot);
  const schema = namespaceFor(snapshot, activeSchema);
  return [
    // `sql()` is here for parsing and highlighting only. Its `schema` option
    // registers completion through languageData, which then has to be merged
    // with our own join source — and relying on that implicit resolution is
    // what left the editor offering bare SQL keywords instead of tables.
    sql({ dialect, upperCaseKeywords: false }),
    autocompletion({
      // Explicit and ordered: foreign-key joins first (most specific),
      // then tables and columns from the live catalog, then keywords last
      // so `panel_widget` always outranks `partition`.
      override: [
        // Most specific first. Columns of the tables actually in scope beat
        // the full table list, which beats bare SQL keywords — otherwise
        // `panel_` offers `partition` ahead of `panel_id`.
        joinCompletionSource(snapshot),
        columnCompletionSource(snapshot),
        schemaCompletionSource({ dialect, schema, defaultSchema: defaultSchemaName(snapshot) }),
        keywordCompletionSource(dialect, false),
      ].map(onlyInSql),
    }),
  ];
}

export function SqlEditor({
  value,
  schema,
  activeSchema,
  inject,
  onChange,
  onCursor,
  onRun,
  onRunAll,
  onFormat,
  onPlan,
  onStatementAction,
  onRefine,
  refining = false,
  translating = false,
  runSetLabel,
  aiAvailable = true,
  params,
  onParamOpen,
}: {
  value: string;
  schema?: SchemaSnapshot;
  activeSchema?: string;
  /// Imperative insert, used by the Ask panel. The editor is mounted once
  /// and owns its document, so pushing text in needs a transaction rather
  /// than a prop change — bumping `nonce` is what triggers it.
  inject?: {
    text: string;
    nonce: number;
    mode?: 'insert' | 'append' | 'replace';
    /// Replace exactly this span. Without it a replace rewrites the whole
    /// document, which would throw away the other statements in the buffer.
    range?: { from: number; to: number };
  };
  onChange(next: string): void;
  /// Cursor / selection, so Run can mean "the statement I am looking at".
  onCursor?(from: number, to: number): void;
  onRun(): void;
  onRunAll?(): void;
  onFormat?(): void;
  /// Plan the statement under the cursor without running it. A sibling of
  /// Run rather than a corner of the results pane: seeing what a query is
  /// about to do belongs BEFORE you do it, and until now the only way to
  /// reach it was to run the query first.
  onPlan?(): void;
  /// An action on ONE statement, named explicitly rather than inferred from
  /// where the cursor happens to be.
  ///
  /// The toolbar buttons act on the statement at the cursor, which is
  /// correct and completely invisible: sitting above a buffer of six
  /// queries they read as applying to all six. This is the same three
  /// actions said in the one place that cannot be misread — on the
  /// statement itself.
  onStatementAction?(
    action: 'plan' | 'explain' | 'format' | 'run-set',
    statement: { sql: string; from: number; to: number },
  ): void;
  /// Ask a model to change ONE statement. The gutter mark and the strip's
  /// Refine both open the box; this fires when it is submitted, and the
  /// caller replaces the span itself.
  onRefine?(statement: { sql: string; from: number; to: number }, instruction: string): void;
  /// True while that request is in flight, so the box can say so and stay
  /// put — closing it would hide what the answer is about to replace.
  refining?: boolean;
  /// True while a question is being turned into SQL. The band it is being
  /// turned from is what animates — the Run button says the same thing, but
  /// it is in the far corner and your eye is on the sentence.
  translating?: boolean;
  /// Label for the fan-out action, or absent when there is no environment
  /// set to run against. Passed in rather than decided here: the editor
  /// knows about statements, not about which servers exist.
  runSetLabel?: string;
  /// Values for the placeholders in this buffer, drawn in the holes
  /// themselves (src/renderer/paramChips.ts). Absent — the fan-out's schema
  /// drift editor, say — and the text is left exactly as typed.
  params?: Omit<ParamContext, 'onOpen'>;
  /// A chip was clicked. The caller opens the value panel: the editor knows
  /// where the hole is, and nothing else about connections or storage.
  onParamOpen?(
    slot: { key: string; label: string; style: 'positional' | 'named'; from: number; to: number },
    at: DOMRect,
  ): void;
  /// Whether a translation is actually possible on this machine. The prose
  /// highlight means "⌘↵ will hand this to a model"; with no CLI installed
  /// it can only mean "this is not SQL", and it is drawn accordingly.
  aiAvailable?: boolean;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const isDark = useIsDark();
  /// The statement the refine box is attached to, with the screen position
  /// of its first line — measured once when it opens, like the hover strip.
  const [refine, setRefine] = useState<{
    statement: { sql: string; from: number; to: number };
    top: number;
  } | null>(null);
  const [draft, setDraft] = useState('');
  const openRefine = (statement: { sql: string; from: number; to: number }) => {
    const v = view.current;
    const box = host.current?.getBoundingClientRect();
    // No CLI, nothing behind the door — see the `no-ai` rules in styles.css.
    if (!v || !box || !aiAvailable) return;
    // Anchored UNDER the statement, not over it: what you are about to
    // change has to stay readable while you say how to change it.
    const end = v.coordsAtPos(Math.min(statement.to, v.state.doc.length));
    const start = v.coordsAtPos(Math.min(statement.from, v.state.doc.length));
    const top = (end?.bottom ?? start?.top ?? box.top) - box.top + 4;
    setDraft('');
    setRefine({ statement, top });
  };
  const latest = useRef({ onChange, onRun, onRunAll, onCursor, onFormat, onPlan, openRefine, onParamOpen });
  latest.current = { onChange, onRun, onRunAll, onCursor, onFormat, onPlan, openRefine, onParamOpen };

  // The box closes when the answer lands, not when it is asked for: what
  // replaced the statement is the thing worth looking at.
  const wasRefining = useRef(refining);
  useEffect(() => {
    if (wasRefining.current && !refining) setRefine(null);
    wasRefining.current = refining;
  }, [refining]);

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers({
          // The mark is a button. Clicking it asks for a change to the
          // statement it sits on — mousedown rather than click so the
          // editor does not move the caret into the statement first.
          domEventHandlers: {
            mousedown: (v, line, event) => {
              const el = event.target as HTMLElement | null;
              if (!el?.closest('.cm-ai-gutter')) return false;
              const stmt = splitStatements(v.state.doc.toString()).find(
                (st) => line.from >= st.start - 1 && line.from <= st.end + 1,
              );
              if (!stmt) return false;
              event.preventDefault();
              latest.current.openRefine({ sql: stmt.sql, from: stmt.start, to: stmt.end });
              return true;
            },
          },
        }),
        questionGutter,
        history(),
        highlightActiveLine(),
        statementBlocks,
        schemaCompartment.of(schemaExtensions(schema, activeSchema)),
        paramsCompartment.of(paramExtension(params, latest)),
        syntaxHighlighting(highlight),
        themeCompartment.of(isDark ? darkTheme : lightTheme),
        keymap.of([
          { key: 'Mod-Enter', preventDefault: true, run: () => { latest.current.onRun(); return true; } },
          // ⌥↵ beside ⌘↵: same target statement, but planned instead of
          // executed.
          {
            key: 'Alt-Enter',
            preventDefault: true,
            run: () => {
              latest.current.onPlan?.();
              return true;
            },
          },
          {
            key: 'Shift-Alt-f',
            preventDefault: true,
            run: () => {
              latest.current.onFormat?.();
              return true;
            },
          },
          {
            key: 'Shift-Mod-Enter',
            preventDefault: true,
            run: () => {
              latest.current.onRunAll?.();
              return true;
            },
          },
          // Tab accepts the highlighted completion; without this it inserts
          // an indent while the popup sits there ignored.
          { key: 'Tab', run: acceptCompletion },
          ...completionKeymap,
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) latest.current.onChange(u.state.doc.toString());
          if (u.docChanged || u.selectionSet) {
            const sel = u.state.selection.main;
            latest.current.onCursor?.(sel.from, sel.to);
          }
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // Mount once: `value` is the initial document and further changes flow
    // out through onChange, not back in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: schemaCompartment.reconfigure(schemaExtensions(schema, activeSchema)),
    });
  }, [schema, activeSchema]);

  useEffect(() => {
    view.current?.dispatch({
      effects: themeCompartment.reconfigure(isDark ? darkTheme : lightTheme),
    });
  }, [isDark]);

  useEffect(() => {
    view.current?.dispatch({
      effects: paramsCompartment.reconfigure(paramExtension(params, latest)),
    });
  }, [params?.engine, params?.bindings, params?.target.connectionId, params?.target.env]);

  /// Seeded from the CURRENT nonce, not zero.
  ///
  /// QueryPane keys this editor on the connection id, so switching
  /// connections mounts a fresh one — and a ref starting at zero made
  /// whatever inject was last dispatched look brand new, so it replayed
  /// against the new connection's buffer. With a replace payload that meant
  /// dispatching the old buffer's offsets into the new document:
  /// "Invalid change range 1055 to 0 (in doc of length 0)".
  const injected = useRef(inject?.nonce ?? 0);
  useEffect(() => {
    const v = view.current;
    if (!v || !inject || inject.nonce === injected.current) return;
    injected.current = inject.nonce;
    // Insert at the cursor rather than replacing: the proposal is something
    // to read alongside what you already wrote, not instead of it.
    if (inject.mode === 'replace') {
      // Clamped against THIS document, and ordered. An offset that outruns
      // the doc must land at its end, never throw — the editor swallowing a
      // proposal is recoverable, a thrown RangeError takes the pane down.
      const len = v.state.doc.length;
      const from = Math.max(0, Math.min(inject.range?.from ?? 0, len));
      const to = Math.max(from, Math.min(inject.range?.to ?? len, len));
      // Belt and braces on top of the offsets: whatever the arithmetic says,
      // a replacement must never weld itself onto the statement above or the
      // one below. Cheap to guarantee here, and impossible to get wrong.
      const beforeText = v.state.doc.sliceString(Math.max(0, from - 2), from);
      const afterText = v.state.doc.sliceString(to, Math.min(v.state.doc.length, to + 2));
      const lead = from > 0 && !/\n\s*$/.test(beforeText) ? '\n\n' : '';
      const tail = to < v.state.doc.length && !/^\s*\n/.test(afterText) ? '\n\n' : '';
      const insert = lead + inject.text.trimEnd() + tail;
      v.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        scrollIntoView: true,
      });
      v.focus();
      return;
    }
    // Append goes to the END of the document, never the cursor. A
    // hundred-line rewrite landing wherever the caret happened to be sits
    // INSIDE the statement you were reading, and the two silently become
    // one unrunnable thing.
    const at = inject.mode === 'append' ? v.state.doc.length : v.state.selection.main.to;
    const prefix = at > 0 && v.state.doc.sliceString(at - 1, at) !== '\n' ? '\n\n' : '';
    v.dispatch({
      changes: { from: at, insert: prefix + inject.text + '\n' },
      selection: { anchor: at + prefix.length + inject.text.length + 1 },
      scrollIntoView: true,
    });
    v.focus();
  }, [inject]);

  // Which statement the pointer is over, and where its first line sits.
  //
  // Recomputed only when the pointer changes LINE, and the split is cached
  // on the document object itself — CodeMirror replaces `doc` on every
  // change, so identity is an exact and free staleness check. Splitting a
  // thousand-line buffer on every mousemove was the obvious way to write
  // this and makes the editor feel broken.
  const [hover, setHover] = useState<{ top: number; statement: Statement } | null>(null);
  const split = useRef<{ doc: unknown; list: Statement[] } | null>(null);
  const lastLine = useRef(-1);

  const track = (event: React.MouseEvent) => {
    const v = view.current;
    const box = host.current;
    if (!v || !box) return;
    const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return void setHover(null);
    const line = v.state.doc.lineAt(pos).number;
    if (line === lastLine.current && hover) return;
    lastLine.current = line;

    if (split.current?.doc !== v.state.doc) {
      split.current = { doc: v.state.doc, list: splitStatements(v.state.doc.toString()) };
    }
    const statement = split.current.list.find((s) => pos >= s.start && pos <= s.end + 1);
    if (!statement) return void setHover(null);
    const coords = v.coordsAtPos(Math.min(statement.start, v.state.doc.length));
    if (!coords) return void setHover(null);
    setHover({ top: coords.top - box.getBoundingClientRect().top, statement });
  };

  const act = (action: 'plan' | 'explain' | 'format' | 'run-set' | 'refine') => {
    if (action === 'refine') {
      const s = hover?.statement;
      setHover(null);
      if (s) openRefine({ sql: s.sql, from: s.start, to: s.end });
      return;
    }
    if (!hover) return;
    onStatementAction?.(action, {
      sql: hover.statement.sql,
      from: hover.statement.start,
      to: hover.statement.end,
    });
  };

  return (
    <div
      className={`h-full relative${aiAvailable ? '' : ' no-ai'}${
        translating ? ' cm-translating' : ''
      }`}
      onMouseMove={track}
      onMouseLeave={() => {
        lastLine.current = -1;
        setHover(null);
      }}
    >
      <div
        ref={host}
        onMouseDown={() => view.current?.focus()}
        // Scrolling moves the statement out from under a strip whose
        // position was measured before the scroll, so the strip goes.
        onScroll={() => {
          lastLine.current = -1;
          setHover(null);
        }}
        className="h-full overflow-auto cursor-text"
      />
      {refine && onRefine && (
        <div
          style={{ top: Math.max(0, refine.top) }}
          onMouseDown={(e) => e.stopPropagation()}
          className="ai-box absolute left-3 right-3 z-20 rounded-md backdrop-blur-sm px-2.5 py-2 shadow-lg shadow-black/30"
        >
          <div className="flex items-center gap-1.5 text-[10px] text-ink-muted mb-1.5">
            <Sparkle />
            Change this statement — it is rewritten in place for you to read, never run.
          </div>
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={draft}
              disabled={refining}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Stopped here rather than handled by the editor: this input
                // sits inside the editor's box, and Escape would otherwise
                // reach CodeMirror's own bindings.
                e.stopPropagation();
                if (e.key === 'Escape') setRefine(null);
                if (e.key === 'Enter' && draft.trim() && !refining) {
                  onRefine(refine.statement, draft.trim());
                }
              }}
              placeholder="add the partner name and group by month"
              className="field flex-1 px-2 py-1 text-xs font-mono disabled:opacity-60"
            />
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => draft.trim() && !refining && onRefine(refine.statement, draft.trim())}
              disabled={!draft.trim() || refining}
              className="ai-btn text-[11px] font-medium px-2.5 py-1 rounded disabled:opacity-40"
            >
              {refining ? 'Rewriting…' : 'Rewrite'}
            </button>
            <button
              onClick={() => setRefine(null)}
              disabled={refining}
              className="text-[11px] text-ink-faint hover:text-ink disabled:opacity-40"
            >
              Esc
            </button>
          </div>
        </div>
      )}
      {hover && onStatementAction && !refine && (
        <div
          // Pinned to the statement's FIRST line: the strip has to be
          // attached to something, and the top-left of the block is the
          // only part of a statement whose position does not depend on how
          // long it is.
          style={{ top: Math.max(0, hover.top) }}
          // Without this the editor takes focus and the click lands as a
          // caret move before the button ever sees it.
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute right-3.5 z-10 flex items-center gap-1 rounded-md border border-accent/60 bg-surface shadow-md shadow-black/20 px-1 py-1"
        >
          <Act label="Plan" title="Show this statement's plan — it is not executed" onClick={() => act('plan')} />
          <Act label="Explain" title="Plan it and ask the model to interpret it" onClick={() => act('explain')} />
          <Act label="Format" title="Reformat just this statement" onClick={() => act('format')} />
          {/* The same door as the mark in the gutter, said in a word for
              anyone who never hovers a line number. */}
          {aiAvailable && onRefine && (
            <Act
              label="Refine"
              title="Ask a model to change this statement — you read it before it runs"
              onClick={() => act('refine')}
              icon={<Sparkle />}
            />
          )}
          {/* Belongs here and not on the toolbar for the reason in the
              comment above: fanning out acts on ONE statement, and a
              button above a buffer of six reads as applying to all six. */}
          {runSetLabel && (
            <Act
              label={runSetLabel}
              title="Run this statement against every member of an environment set and compare the answers"
              onClick={() => act('run-set')}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Act({
  label,
  title,
  onClick,
  icon,
}: {
  label: string;
  title: string;
  onClick(): void;
  /// The mark, for the one action here that hands work to a model. It says
  /// that in the same glyph the gutter uses — which is enough. A filled
  /// button beside four plain ones reads as the thing you are supposed to
  /// press, and this is not that.
  icon?: JSX.Element;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide px-2 py-1 rounded text-ink bg-card/70 hover:bg-accent hover:text-white"
    >
      {icon}
      {label}
    </button>
  );
}
