import { useEffect } from 'react';
import type { Connection, EnvSet } from '@shared/types';
import { useStore } from './store';
import { followSchema } from '@shared/schemaFollow';

/// Which schema each member's statement runs against.
///
/// This is the part of a set that is easy to get silently wrong. "The same
/// logical database in several places" almost never means the same NAME in
/// several places — `acme` locally, `acmedmsandbox` in sandbox — so an
/// unqualified statement resolves against whatever each session happens to
/// be pointed at, and the fan-out cheerfully compares an answer from the
/// wrong database against one from the right one. Stating it per member,
/// where you can see all of them at once, is the only way that mismatch is
/// visible before it is a result.
///
/// `children` go at the far end of the bar: the drift view puts its own
/// controls there rather than stacking a second bar under this one.
const TONE = {
  none: 'border-card bg-wash',
  base: 'border-side-base/40 bg-side-base/5',
  here: 'border-side-here/40 bg-side-here/5',
  here2: 'border-side-here2/40 bg-side-here2/5',
  here3: 'border-side-here3/40 bg-side-here3/5',
} as const;

export function SchemaBar({
  envSet,
  members,
  children,
  sides,
  kept,
}: {
  envSet: EnvSet;
  members: Connection[];
  children?: React.ReactNode;
  /// Colour each member as a side of a comparison, by id, in the same
  /// colours the drift view's columns use.
  sides?: Record<string, 'base' | 'here' | 'here2' | 'here3'>;
  /// A schema to show for a member that has no live one: an unreachable
  /// member compared through its kept catalog is still compared IN one.
  kept?: Record<string, string>;
}): JSX.Element | null {
  const schemaList = useStore((s) => s.schemaList);
  const activeSchema = useStore((s) => s.activeSchema);
  const loadSchemaList = useStore((s) => s.loadSchemaList);
  const saveEnvSet = useStore((s) => s.saveEnvSet);
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    for (const m of members) void loadSchemaList(m.id);
  }, [members, loadSchemaList]);

  if (!members.length) return null;

  const chosen = (id: string) => envSet.memberSchemas?.[id] ?? activeSchema[id] ?? '';
  // The others follow when they were on the same schema and have the new
  // one — see followSchema. Said in the toast, so a member moving that you
  // did not touch is never a surprise.
  const pick = (id: string, name: string) => {
    const current = Object.fromEntries(
      members.map((m) => [m.id, chosen(m.id) || kept?.[m.id] || '']),
    );
    const { schemas, followed } = followSchema(current, id, name, schemaList);
    void saveEnvSet({
      id: envSet.id,
      name: envSet.name,
      memberIds: envSet.memberIds,
      baselineId: envSet.baselineId,
      memberSchemas: {
        ...envSet.memberSchemas,
        ...Object.fromEntries([id, ...followed].map((m) => [m, schemas[m]])),
      },
    }).then(() => {
      if (followed.length) {
        const who = followed.map((f) => members.find((m) => m.id === f)?.name ?? f).join(', ');
        toast(`${who} moved to ${name} too.`);
      }
    });
  };

  // Worth pointing at only when they actually disagree. On a set where every
  // member is on the same name this is a row of identical dropdowns saying
  // nothing.
  const distinct = new Set(members.map((m) => chosen(m.id)).filter(Boolean));

  return (
    <div className="shrink-0 border-b border-card px-3.5 py-2 flex items-center gap-2 flex-wrap">
      <span className="text-[10px] uppercase tracking-wider text-ink-faint">Schema</span>
      {members.map((m) => {
        const names = schemaList[m.id] ?? [];
        const value = chosen(m.id);
        return (
          <label
            key={m.id}
            className={`flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded border ${
              TONE[sides?.[m.id] ?? 'none']
            }`}
            title={`${m.name} — which schema its statement runs against`}
          >
            {sides?.[m.id] === 'base' && (
              <span className="text-[9px] tracking-wider text-side-base">★ BASELINE</span>
            )}
            <span className="text-[10px] text-ink-faint max-w-[130px] truncate">{m.name}</span>
            <select
              value={value}
              onChange={(e) => pick(m.id, e.target.value)}
              className="bg-transparent text-[11px] text-ink outline-none max-w-[150px]"
            >
              {value === '' && (
                <option value="">{kept?.[m.id] ? `${kept[m.id]} (kept)` : 'whatever it is on'}</option>
              )}
              {!names.includes(value) && value !== '' && <option value={value}>{value}</option>}
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        );
      })}
      {distinct.size > 1 && (
        <span className="text-[10px] text-ink-faint">
          {distinct.size} different names — the statement is run against each member's own.
        </span>
      )}
      {children && (
        <>
          <div className="flex-1" />
          {children}
        </>
      )}
    </div>
  );
}
