import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  highlightActiveLine,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { acceptCompletion, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { keywordCompletionSource, schemaCompletionSource, sql } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { SchemaSnapshot } from '@shared/types';
import { looksLikeQuestion } from '@shared/looksLikeSql';
import { splitStatements } from '@shared/sqlGuard';
import {
  columnCompletionSource,
  defaultSchemaName,
  dialectFor,
  joinCompletionSource,
  namespaceFor,
} from './sqlSchema';

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'rgb(var(--c-accent))' },
  { tag: tags.string, color: '#7dd3a0' },
  { tag: tags.number, color: '#e0a45e' },
  { tag: tags.comment, color: 'rgb(var(--c-ink-faint))', fontStyle: 'italic' },
  { tag: tags.operator, color: 'rgb(var(--c-ink-muted))' },
]);

const theme = EditorView.theme(
  {
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
  },
  // Tells CodeMirror to use its dark-mode defaults for everything we have
  // not overridden. Without it, built-ins like the caret and the selection
  // layer are styled for a light background.
  { dark: true },
);

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

const questionMark = Decoration.mark({ class: 'cm-question' });
const questionLine = Decoration.line({ class: 'cm-question-line' });
const stmtLine = Decoration.line({ class: 'cm-stmt-line' });
const stmtActiveLine = Decoration.line({ class: 'cm-stmt-line cm-stmt-active' });

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

/// Swapped out whenever the catalog changes, so completion can light up
/// after introspection finishes without rebuilding the editor and throwing
/// away the user's undo history and cursor.
const schemaCompartment = new Compartment();

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
      ],
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
    mode?: 'insert' | 'replace';
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
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, onRun, onRunAll, onCursor, onFormat });
  latest.current = { onChange, onRun, onRunAll, onCursor, onFormat };

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        highlightActiveLine(),
        statementBlocks,
        schemaCompartment.of(schemaExtensions(schema, activeSchema)),
        syntaxHighlighting(highlight),
        theme,
        keymap.of([
          { key: 'Mod-Enter', preventDefault: true, run: () => { latest.current.onRun(); return true; } },
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

  const injected = useRef(0);
  useEffect(() => {
    const v = view.current;
    if (!v || !inject || inject.nonce === injected.current) return;
    injected.current = inject.nonce;
    // Insert at the cursor rather than replacing: the proposal is something
    // to read alongside what you already wrote, not instead of it.
    if (inject.mode === 'replace') {
      const from = inject.range?.from ?? 0;
      const to = Math.min(inject.range?.to ?? v.state.doc.length, v.state.doc.length);
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
    const at = v.state.selection.main.to;
    const prefix = at > 0 && v.state.doc.sliceString(at - 1, at) !== '\n' ? '\n\n' : '';
    v.dispatch({
      changes: { from: at, insert: prefix + inject.text + '\n' },
      selection: { anchor: at + prefix.length + inject.text.length + 1 },
      scrollIntoView: true,
    });
    v.focus();
  }, [inject]);

  return (
    <div
      ref={host}
      onMouseDown={() => view.current?.focus()}
      className="h-full overflow-auto cursor-text"
    />
  );
}
