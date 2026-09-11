import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EnvKind } from '@shared/types';
import {
  blankBinding,
  resolveBinding,
  resolveParams,
  type ParamScope,
  type ParamSlot,
  type ParamType,
} from '@shared/params';
import { useStore } from './store';

/// The panel behind a value chip.
///
/// It exists because a value is not one string. `client_name` is `hp` on
/// every scratch database you own and `HP Inc` on prod, and the old
/// dropdown could write to one of those layers while showing you none of
/// the others — so "why did prod return nothing" was a question you could
/// only answer by switching connections and looking again.
///
/// So the layers are a small table, all of them at once, each editable in
/// place, with a mark on the one this connection is actually using. Setting
/// prod's value from your laptop is a normal thing to do here.

const ENV_ORDER: EnvKind[] = ['local', 'dev', 'sandbox', 'staging', 'prod', 'other'];

const TYPES: Array<{ value: ParamType; label: string }> = [
  { value: 'auto', label: 'auto' },
  { value: 'text', label: 'text' },
  { value: 'number', label: 'number' },
  { value: 'boolean', label: 'bool' },
  { value: 'null', label: 'NULL' },
  { value: 'list', label: 'list' },
];

export function ParamPopover({
  slot,
  at,
  target,
  onClose,
}: {
  slot: ParamSlot;
  /// Where the chip is, in viewport coordinates.
  at: DOMRect;
  target: { connectionId?: string; env?: EnvKind };
  onClose(): void;
}): JSX.Element {
  const bindings = useStore((s) => s.params);
  const connections = useStore((s) => s.connections);
  const setParamValue = useStore((s) => s.setParamValue);
  const setParamType = useStore((s) => s.setParamType);
  const clearParamValue = useStore((s) => s.clearParamValue);
  const forgetParam = useStore((s) => s.forgetParam);
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);

  const binding = bindings.find((b) => b.key === slot.key);
  const resolved = resolveParams([slot], bindings, target)[0];
  const connection = connections.find((c) => c.id === target.connectionId);

  /// Only the environments you actually have connections in, plus whichever
  /// one this editor is pointed at. Six fixed rows would mostly be rows for
  /// environments that do not exist here.
  const envs = useMemo(() => {
    const present = new Set(connections.map((c) => c.env));
    if (target.env) present.add(target.env);
    return ENV_ORDER.filter((e) => present.has(e));
  }, [connections, target.env]);

  useEffect(() => {
    first.current?.focus();
    first.current?.select();
  }, [slot.key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const WIDTH = 330;
  const left = Math.max(8, Math.min(at.left - 8, window.innerWidth - WIDTH - 8));
  /// Under the chip, flipped above it when there is no room — MEASURED
  /// rather than assumed. The panel's height depends on how many
  /// environments you have connections in, so a fixed guess would hang a
  /// tall one off the bottom of the window on exactly the setups that have
  /// the most to show.
  const [top, setTop] = useState(at.bottom + 6);
  useLayoutEffect(() => {
    const height = box.current?.offsetHeight ?? 0;
    const below = at.bottom + 6;
    const room = window.innerHeight - below - 8;
    setTop(height <= room ? below : Math.max(8, at.top - height - 6));
  }, [at.top, at.bottom, envs.length, Boolean(connection)]);

  const write = (scope: ParamScope, text: string, env?: EnvKind) =>
    setParamValue(slot, text, scope, { connectionId: target.connectionId, env: env ?? target.env });

  return (
    <div
      ref={box}
      style={{ position: 'fixed', left, top, width: WIDTH }}
      // `fixed z-50` is what every other floating panel in here uses (the
      // grid's cell and filter menus), so this one stacks with them rather
      // than inventing a layer above the command palette.
      className="fixed z-50 rounded-md border border-card bg-surface-elevated shadow-2xl flex flex-col"
    >
      <div className="px-2.5 pt-2.5 pb-2 flex flex-col gap-1.5 border-b border-rule">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[11.5px] text-ink truncate">{slot.label}</span>
          <span className="flex-1" />
          <span className="text-[9.5px] text-ink-faint whitespace-nowrap">
            {slot.style === 'positional' ? 'positional' : 'named'}
            {slot.count > 1 && ` · ${slot.count} places`}
          </span>
        </div>
        <div className="flex gap-1.5">
          <input
            ref={first}
            value={resolved.text}
            placeholder={resolved.type === 'list' ? 'hp, ibm, dell' : 'no value yet'}
            disabled={resolved.type === 'null'}
            onChange={(e) => write(resolved.missing ? 'default' : resolved.scope, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onClose();
            }}
            className="field px-1.5 py-1 text-[11.5px] font-mono flex-1 disabled:opacity-40"
          />
          <select
            value={resolved.type}
            onChange={(e) => setParamType(slot, e.target.value as ParamType)}
            title="How the text is read"
            className="field px-1 py-0.5 text-[10px]"
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        {resolved.type === 'list' && (
          // Said here rather than left to be discovered: one hole standing
          // for a list is the whole reason `IN (?)` works at all, and the
          // number of values is not visible anywhere else.
          <span className="text-[10px] text-ink-faint">
            One hole, as many values as you type — separated by commas.
            {slot.inList && ' Read as a list because it is an IN.'}
          </span>
        )}
      </div>

      <div className="px-1.5 py-1.5 flex flex-col gap-px">
        <span className="px-1.5 pb-1 text-[10px] uppercase tracking-wider text-ink-faint">
          Where this value applies
        </span>

        <Layer
          name="Everywhere"
          value={binding?.value ?? ''}
          inUse={!resolved.missing && resolved.scope === 'default'}
          onChange={(text) => write('default', text)}
        />

        {envs.map((env) => (
          <Layer
            key={env}
            name={env}
            muted
            value={binding?.byEnv?.[env] ?? ''}
            inUse={resolved.scope === 'env' && target.env === env && !resolved.missing}
            onChange={(text) => write('env', text, env)}
            onClear={
              binding?.byEnv?.[env] !== undefined
                ? () => clearParamValue(slot.key, 'env', { env })
                : undefined
            }
          />
        ))}

        {connection && (
          <>
            <div className="h-px bg-rule mx-1.5 my-1" />
            <Layer
              name={`${connection.name} only`}
              muted
              value={binding?.byConnection?.[connection.id] ?? ''}
              inUse={resolved.scope === 'connection' && !resolved.missing}
              onChange={(text) => write('connection', text)}
              onClear={
                binding?.byConnection?.[connection.id] !== undefined
                  ? () => clearParamValue(slot.key, 'connection', { connectionId: connection.id })
                  : undefined
              }
            />
          </>
        )}
      </div>

      <div className="border-t border-rule px-2.5 py-1.5 flex items-center gap-2">
        <span className="text-[10px] text-ink-faint">
          Most specific wins: connection → environment → everywhere
        </span>
        <span className="flex-1" />
        {binding && (
          <button
            onClick={() => {
              forgetParam(slot.key);
              onClose();
            }}
            className="text-[10px] text-ink-muted hover:text-bad"
          >
            Forget
          </button>
        )}
      </div>
    </div>
  );
}

/// One layer's row. The value is edited where it is read — setting prod's
/// answer from a local connection is the point, not an edge case.
function Layer({
  name,
  value,
  inUse,
  muted,
  onChange,
  onClear,
}: {
  name: string;
  value: string;
  inUse: boolean;
  muted?: boolean;
  onChange(text: string): void;
  onClear?(): void;
}): JSX.Element {
  return (
    <div
      className={`group flex items-center gap-2 pl-1.5 pr-1 py-0.5 rounded ${
        inUse ? 'bg-accent/12 shadow-[inset_2px_0_0_rgb(var(--c-accent))]' : ''
      }`}
    >
      <span
        className={`text-[11px] w-[104px] shrink-0 truncate ${muted ? 'text-ink-muted' : 'text-ink'}`}
        title={name}
      >
        {name}
      </span>
      <input
        value={value}
        placeholder="—"
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 min-w-0 bg-transparent border-0 outline-none px-1 py-0.5 text-[11px] font-mono text-ink placeholder:text-ink-faint focus:bg-card rounded"
      />
      {inUse && (
        <span className="shrink-0 text-[9px] px-1 py-0.5 rounded border border-accent/40 text-accent">
          in use here
        </span>
      )}
      {!inUse && onClear && (
        <button
          onClick={onClear}
          title="Drop this override"
          className="shrink-0 text-[10px] px-1 text-ink-faint opacity-0 group-hover:opacity-100 hover:text-bad"
        >
          ✕
        </button>
      )}
    </div>
  );
}
