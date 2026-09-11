// Placeholder values, drawn where the placeholder is.
//
// A pasted `WHERE client_name = ?` is a statement with a hole in it, and the
// value that fills the hole belongs in the hole — not in a form under the
// editor that you read by matching labels. So every placeholder in the
// buffer renders as a chip carrying its bound value, and the statement reads
// as the query that is actually about to run.
//
// Two things this buys beyond tidiness. A hole with nothing behind it is
// visible AS a hole, in every statement at once, rather than only in the one
// your cursor happens to be in — which is exactly the case that used to send
// a run to the server with a value nobody had filled in. And the value shown
// is the value THIS connection resolves, so switching connections visibly
// changes the query rather than silently changing it.
//
// The chip is a display of the binding, never the binding itself: the
// document still contains `?`, and the value still travels as a bound
// parameter (src/shared/params.ts). Nothing here rewrites SQL.

import { EditorView, Decoration, WidgetType, type DecorationSet } from '@codemirror/view';
import { StateField, type EditorState, type Extension } from '@codemirror/state';
import { RangeSetBuilder } from '@codemirror/state';
import type { Engine, EnvKind } from '@shared/types';
import {
  bufferPlaceholders,
  coerceParam,
  resolveBinding,
  type ParamBinding,
  type ParamScope,
  type Placeholder,
} from '@shared/params';

/// What the editor needs to know to draw a value in a hole.
export interface ParamContext {
  engine: Engine;
  bindings: ParamBinding[];
  /// Whose values these are — a connection and its environment, or just an
  /// environment when the editor is aimed at a set rather than a server.
  target: { connectionId?: string; env?: EnvKind };
  /// Opens the value panel for a chip. The rect is in VIEWPORT coordinates,
  /// so the panel can be positioned without knowing where the editor sits.
  onOpen(
    slot: { key: string; label: string; style: Placeholder['style']; from: number; to: number },
    at: DOMRect,
  ): void;
}

/// One chip. Everything it draws is settled here rather than in the DOM, so
/// `eq` can decide cheaply whether a redraw is needed.
interface Chip {
  key: string;
  label: string;
  style: Placeholder['style'];
  /// The spelling the author used, reduced to its opening mark: `?`, `:`,
  /// `$`, `#`. Kept because it says which kind of hole this is without
  /// spelling the whole thing out.
  mark: string;
  text: string;
  missing: boolean;
  scope: ParamScope;
  /// How many values a list expands to. `IN (?)` bound to three names is
  /// three placeholders by the time it reaches the server, and that is
  /// invisible from the chip's text alone.
  items: number | null;
  from: number;
  to: number;
}

/// A value long enough to push the rest of the line off the screen is worse
/// than one you have to click to read in full.
const MAX_SHOWN = 28;

class ChipWidget extends WidgetType {
  constructor(
    private chip: Chip,
    private ctx: ParamContext,
  ) {
    super();
  }

  eq(other: ChipWidget): boolean {
    const a = this.chip;
    const b = other.chip;
    return (
      a.key === b.key &&
      a.text === b.text &&
      a.missing === b.missing &&
      a.label === b.label &&
      a.scope === b.scope &&
      a.items === b.items
    );
  }

  toDOM(): HTMLElement {
    const { chip } = this;
    const el = document.createElement('span');
    el.className = `cm-param ${chip.missing ? 'cm-param-none' : 'cm-param-set'}`;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.title = chip.missing
      ? `${chip.label} — no value yet. Click to fill it in.`
      : `${chip.label} = ${chip.text}\nfrom ${scopeWord(chip.scope, this.ctx.target.env)}${
          chip.items !== null ? `\nexpands to ${chip.items} value${chip.items === 1 ? '' : 's'}` : ''
        }`;

    const mark = document.createElement('i');
    mark.className = 'cm-param-mark';
    mark.textContent = chip.mark;
    el.appendChild(mark);

    const body = document.createElement('span');
    // An empty hole shows its NAME — that is the question being asked. A
    // filled one shows its VALUE, because the name is no longer the news.
    const shown = chip.missing ? chip.label : chip.text;
    body.textContent = shown.length > MAX_SHOWN ? `${shown.slice(0, MAX_SHOWN - 1)}…` : shown;
    el.appendChild(body);

    if (chip.items !== null && chip.items > 1) {
      const count = document.createElement('i');
      count.className = 'cm-param-mark';
      count.textContent = `×${chip.items}`;
      el.appendChild(count);
    }

    const open = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.ctx.onOpen(
        { key: chip.key, label: chip.label, style: chip.style, from: chip.from, to: chip.to },
        el.getBoundingClientRect(),
      );
    };
    el.addEventListener('mousedown', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') open(e);
    });
    return el;
  }

  /// False so the events above reach the chip. Returning true would hand
  /// the mousedown to the editor, which would put a cursor beside the chip
  /// instead of opening it.
  ignoreEvent(): boolean {
    return false;
  }
}

function scopeWord(scope: ParamScope, env?: EnvKind): string {
  if (scope === 'connection') return 'this connection';
  if (scope === 'env') return env ?? 'this environment';
  return 'everywhere';
}

function chipsIn(state: EditorState, ctx: ParamContext): Chip[] {
  const doc = state.doc.toString();
  const byKey = new Map(ctx.bindings.map((b) => [b.key, b]));
  const out: Chip[] = [];

  for (const hole of bufferPlaceholders(doc, ctx.engine)) {
    // A hole the cursor is sitting in goes back to being text. Otherwise
    // renaming `:partnertest` to `:partner` means fighting a widget for
    // every keystroke — the chip is for reading the query, not for holding
    // the editor hostage.
    const touched = state.selection.ranges.some((r) => r.from <= hole.to && r.to >= hole.from);
    if (touched) continue;

    const binding = byKey.get(hole.key);
    const resolved = binding ? resolveBinding(binding, ctx.target) : null;
    const text = resolved?.text ?? '';
    let items: number | null = null;
    if (binding?.type === 'list' && text.trim() !== '') {
      const list = coerceParam(text, 'list');
      items = Array.isArray(list) ? list.length : null;
    }
    out.push({
      key: hole.key,
      label: hole.label,
      style: hole.style,
      mark: hole.raw[0],
      text,
      missing: !binding || (binding.type !== 'null' && text.trim() === ''),
      scope: resolved?.scope ?? 'default',
      items,
      from: hole.from,
      to: hole.to,
    });
  }
  return out;
}

function build(state: EditorState, ctx: ParamContext): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const chip of chipsIn(state, ctx)) {
    builder.add(
      chip.from,
      chip.to,
      Decoration.replace({ widget: new ChipWidget(chip, ctx) }),
    );
  }
  return builder.finish();
}

/// The extension. Rebuilt through a compartment whenever the values change,
/// so a value typed into the panel repaints the chip it came from.
export function paramChips(ctx: ParamContext): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => build(state, ctx),
    // Selection matters as much as the document here: moving the cursor
    // into a hole is what turns its chip back into text.
    update: (deco, tr) =>
      tr.docChanged || tr.selection ? build(tr.state, ctx) : deco,
    provide: (f) => [
      EditorView.decorations.from(f),
      // Arrow keys step OVER a chip rather than into the middle of a token
      // that is not being displayed as text.
      EditorView.atomicRanges.of((view) => view.state.field(f, false) ?? Decoration.none),
    ],
  });
  return field;
}
